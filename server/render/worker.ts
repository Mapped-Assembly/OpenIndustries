/** Bounded scheduler and cancellation around disposable Chromium jobs. */
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, hash, RenderError } from './contract.ts';
import { active, RenderStore, type RenderJob } from './store.ts';

type Running={child:ChildProcess;timer:NodeJS.Timeout;killTimer?:NodeJS.Timeout;settled:boolean};
export class RenderWorker {
  private running=new Map<string,Running>();
  private stopped=false;
  constructor(readonly store:RenderStore,readonly web:string,readonly concurrency=1,readonly deadlineMs:number=LIMITS.deadlineMs) {
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>2)throw new RenderError('CONFIGURATION','Concurrency must be 1 or 2.');
    if(!Number.isInteger(deadlineMs)||deadlineMs<100||deadlineMs>LIMITS.deadlineMs)throw new RenderError('CONFIGURATION','Deadline must be within 100–120000 ms.');
  }
  /** Queue ownership belongs to the persistent service, never the MCP/browser client. */
  pump():void {
    if(this.stopped)return;
    for(const job of this.store.list()){
      if(this.running.size>=this.concurrency)break;
      if(job.status==='queued')this.start(job);
    }
  }
  private start(job:RenderJob):void {
    job.status='running';this.store.save(job);
    const child=fork(fileURLToPath(new URL('./child.ts',import.meta.url)),[this.store.path(job.id),this.web],
      {execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});
    const entry:Running={child,settled:false,timer:setTimeout(()=>this.fail(job.id,'RENDER_TIMEOUT','Render exceeded its wall-clock deadline.'),this.deadlineMs)};
    this.running.set(job.id,entry);
    child.on('message',(message:{type?:string;progress?:number;message?:string})=>{
      if(entry.settled)return;
      if(message.type==='progress'&&typeof message.progress==='number'&&message.progress>=0&&message.progress<=1){
        const current=this.store.get(job.id);current.progress=Math.max(current.progress,message.progress);this.store.save(current);
      }else if(message.type==='failure')this.fail(job.id,'RENDER_FAILED',message.message??'Headless renderer failed.');
      else if(message.type==='complete'){
        try {
          const dir=this.store.path(job.id),bytes=readFileSync(join(dir,'result.gif'));
          const metadata=JSON.parse(readFileSync(join(dir,'metadata.json'),'utf8'));
          if(bytes.length>LIMITS.outputBytes||bytes.subarray(0,6).toString()!=='GIF89a'||metadata.job_id!==job.id||metadata.scene_sha256!==job.scene_sha256||metadata.media.sha256!==hash(bytes))throw Error('Output integrity check failed.');
          renameSync(join(dir,'result.gif'),join(dir,'output.gif'));renameSync(join(dir,'metadata.json'),join(dir,'review.json'));
          const current=this.store.get(job.id);current.status='completed';current.progress=1;
          current.output={gif:`/v1/render/jobs/${job.id}/media`,metadata:`/v1/render/jobs/${job.id}/metadata`,sha256:hash(bytes),metadata_sha256:hash(readFileSync(join(dir,'review.json'))),bytes:bytes.length};
          this.store.save(current);entry.settled=true;clearTimeout(entry.timer);
        }catch{this.fail(job.id,'OUTPUT_FAILED','Could not verify or publish the rendered files.');}
      }
    });
    const exited=()=>{
      if(!entry.settled)this.fail(job.id,'WORKER_FAILED','Renderer exited without a completed output.');
      clearTimeout(entry.timer);if(entry.killTimer)clearTimeout(entry.killTimer);
      this.running.delete(job.id);if(!this.stopped)this.pump();
    };
    child.once('error',()=>this.fail(job.id,'WORKER_FAILED','Could not start the renderer.'));
    child.once('exit',exited);
  }
  private halt(id:string):void {
    const entry=this.running.get(id);if(!entry)return;
    entry.settled=true;clearTimeout(entry.timer);entry.child.kill('SIGTERM');
    entry.killTimer=setTimeout(()=>entry.child.kill('SIGKILL'),2000);
  }
  private fail(id:string,code:string,message:string):void {
    const job=this.store.get(id);if(!active(job))return;
    job.status='failed';job.error={code,message};this.store.save(job);this.halt(id);
  }
  /** Cancel is synchronous at the authority; partial output is never downloadable. */
  cancel(id:string):RenderJob {
    const job=this.store.get(id);if(!active(job))return job;
    job.status='cancelled';job.error={code:'CANCELLED',message:'Render cancelled; no completed media was published.'};this.store.save(job);this.halt(id);return job;
  }
  /** Validate retained output on download so corruption cannot be returned as success. */
  artifact(id:string,kind:'media'|'metadata'):Buffer {
    const job=this.store.get(id);if(job.status!=='completed'||!job.output)throw new RenderError('OUTPUT_NOT_READY','Only completed jobs have downloadable output.',409);
    try {
      const path=join(this.store.path(id),kind==='media'?'output.gif':'review.json');
      if(statSync(path).size>LIMITS.outputBytes)throw Error();const bytes=readFileSync(path);
      if(hash(bytes)!==(kind==='media'?job.output.sha256:job.output.metadata_sha256))throw Error();return bytes;
    }catch{throw new RenderError('OUTPUT_UNAVAILABLE','Completed output is missing or corrupt; restore it or submit a new render.',410);}
  }
  async close():Promise<void> {
    this.stopped=true;
    for(const job of this.store.list())if(active(job)){
      job.status='interrupted';job.error={code:'WORKER_INTERRUPTED',message:'Service stopped; submit a new request ID to retry.'};this.store.save(job);this.halt(job.id);
    }
    await Promise.all([...this.running.values()].map(({child})=>new Promise<void>(done=>{if(child.exitCode!==null||child.signalCode!==null)done();else child.once('exit',()=>done());})));
    for(const job of this.store.list())if(job.status!=='completed')for(const file of ['result.gif','metadata.json','output.gif','review.json'])rmSync(join(this.store.path(job.id),file),{force:true});
  }
}
