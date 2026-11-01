/** One local render authority with durable job state and immutable completed artifacts. */
import { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LIMITS, RenderError, type RenderInput } from './contract.ts';

export type JobStatus='queued'|'running'|'completed'|'cancelled'|'failed'|'interrupted';
export type RenderJob={id:string;status:JobStatus;progress:number;created_at:string;updated_at:string;
  scene_sha256:string;source:RenderInput['source'];options:RenderInput['options'];error:null|{code:string;message:string};
  output:null|{gif:string;metadata:string;sha256:string;metadata_sha256:string;bytes:number};renderer_version:'oi-gif-v1'};
export const active=(job:RenderJob):boolean=>job.status==='queued'||job.status==='running';
/** Replace a complete file atomically; private staging files never become downloads. */
export function atomicJSON(path:string,value:unknown):void {
  writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600,flush:true});renameSync(path+'.tmp',path);
}
export class RenderStore {
  readonly directory:string;
  private db:DatabaseSync;
  private owner=randomUUID();
  constructor(directory:string) {
    this.directory=resolve(directory);mkdirSync(join(this.directory,'jobs'),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(join(this.directory,'renders.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if(version!==0&&version!==1){this.db.close();throw new RenderError('INCOMPATIBLE_STORE','Unsupported render store version.',409);}
    this.db.exec(`CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER,host TEXT,token TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,body TEXT NOT NULL);
      PRAGMA user_version=1;`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.db.prepare('SELECT * FROM owner WHERE id=1').get();
      if(previous){
        if(previous.host!==hostname())throw new RenderError('STORE_OWNED','Render stores cannot be shared across hosts.',409);
        let alive=true;try{process.kill(Number(previous.pid),0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
        if(alive)throw new RenderError('STORE_OWNED','Another renderer owns this state directory.',409);
      }
      this.db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?,?,?)').run(process.pid,hostname(),this.owner);
      for(const row of this.db.prepare('SELECT body FROM jobs').all()){
        const job=JSON.parse(String(row.body)) as RenderJob;
        if(active(job)){job.status='interrupted';job.error={code:'WORKER_INTERRUPTED',message:'Previous worker stopped before completion; submit a new request ID to retry.'};this.save(job);this.removeStaging(job.id);}
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');this.db.close();throw error;}
    this.prune();
  }
  /** Resolve only caller-validated job IDs already present in the store. */
  path(id:string):string {return join(this.directory,'jobs',id);}
  private removeStaging(id:string):void {for(const file of ['result.gif','metadata.json'])rmSync(join(this.path(id),file),{force:true});}
  save(job:RenderJob):void {job.updated_at=new Date().toISOString();this.db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job),job.id);}
  get(id:string):RenderJob {
    const row=this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id);
    if(!row)throw new RenderError('JOB_NOT_FOUND','Render job not found or expired.',404);
    return JSON.parse(String(row.body));
  }
  list():RenderJob[]{return this.db.prepare('SELECT body FROM jobs ORDER BY rowid').all().map(r=>JSON.parse(String(r.body)));}
  /** Persist resolved geometry before acknowledging; identical requests return the same job. */
  submit(input:RenderInput):RenderJob {
    const old=this.db.prepare('SELECT fingerprint,body FROM jobs WHERE id=?').get(input.request_id);
    if(old){if(old.fingerprint!==input.fingerprint)throw new RenderError('REQUEST_ID_REUSED','request_id already names different render content.',409);return JSON.parse(String(old.body));}
    this.prune();const jobs=this.list();
    if(jobs.filter(active).length>=LIMITS.queue)throw new RenderError('QUEUE_FULL','At most eight pending/running renders are allowed.',429);
    if(jobs.length>=LIMITS.jobs)throw new RenderError('RETENTION_FULL','Delete terminal jobs or wait for seven-day expiry.',429);
    const job:RenderJob={id:input.request_id,status:'queued',progress:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),scene_sha256:input.scene_sha256,source:input.source,options:input.options,error:null,output:null,renderer_version:'oi-gif-v1'};
    const dir=this.path(job.id);mkdirSync(dir,{recursive:true,mode:0o700});atomicJSON(join(dir,'input.json'),input);
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(job.id,input.fingerprint,JSON.stringify(job));return job;
  }
  input(id:string):RenderInput{return JSON.parse(readFileSync(join(this.path(id),'input.json'),'utf8'));}
  /** Terminal records and their files expire together; active work is never pruned. */
  prune(now=Date.now()):void {for(const job of this.list())if(!active(job)&&now-Date.parse(job.updated_at)>LIMITS.retentionMs)this.delete(job.id);}
  delete(id:string):void {
    const job=this.get(id);if(active(job))throw new RenderError('JOB_ACTIVE','Cancel active work before deleting.',409);
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);rmSync(this.path(id),{recursive:true,force:true});
  }
  /** Reuse a private capability across worker restarts; never export it in job metadata. */
  token():string {
    const path=join(this.directory,'token');
    if(!existsSync(path))writeFileSync(path,randomUUID()+randomUUID(),{mode:0o600,flag:'wx',flush:true});
    const token=readFileSync(path,'utf8');if(!/^[0-9a-f-]{72}$/.test(token))throw new RenderError('INVALID_TOKEN','Restore the renderer token file.',500);return token;
  }
  close():void {this.db.prepare('DELETE FROM owner WHERE token=?').run(this.owner);this.db.close();}
}
