/** Real HTTP/MCP/Chromium integration, decoded media and durable failure boundaries. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
// @ts-expect-error omggif is the repository's existing untyped GIF decoder.
import { GifReader } from 'omggif';
import { startService } from '../../server/render/service.ts';
import { envelope, normalize, LIMITS, hash } from '../../server/render/contract.ts';
import { RenderStore } from '../../server/render/store.ts';
import { LocalSceneBackend } from '../../server/local-scene-backend.ts';
import { executeSceneTool } from '../../server/mcp-scenes.ts';
import { oneRoom } from '../../benchmarks/render/build-scene.ts';

const wait=async<T>(read:()=>Promise<T>,done:(value:T)=>boolean,timeout=120_000):Promise<T>=>{
  const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(done(value))return value;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out');
};
const terminal=(job:any)=>!['queued','running'].includes(job.status);
function client(service:{origin:string;clientFile:string}){
  const {token}=JSON.parse(readFileSync(service.clientFile,'utf8'));
  return async(path:string,method='GET',value?:unknown)=>fetch(service.origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});
}
function mcp(clientFile:string,root:string){
  const child=spawn(process.execPath,[resolve('server/openindustries-mcp.mjs')],{env:{...process.env,OI_RENDER_CLIENT_FILE:clientFile,OI_ROOT:root},stdio:['pipe','pipe','pipe']});
  let sequence=0,errors='';child.stderr.on('data',b=>errors+=b);
  const pending=new Map<number,(result:any)=>void>();
  createInterface({input:child.stdout}).on('line',line=>{const result=JSON.parse(line);pending.get(result.id)?.(result.result);pending.delete(result.id);});
  return {child,call:(name:string,args:unknown)=>new Promise<any>((done,fail)=>{
    const id=++sequence,timer=setTimeout(()=>fail(Error('MCP timeout '+errors)),20000);
    pending.set(id,result=>{clearTimeout(timer);done(result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'openindustries.'+name,arguments:args}})+'\n');
  })};
}
function decoded(bytes:Buffer,width:number,frames:number,delay:number):void {
  const gif=new GifReader(bytes);assert.equal(gif.width,width);assert.equal(gif.height,width);assert.equal(gif.numFrames(),frames);assert.equal(gif.loopCount(),0);
  for(let i=0;i<frames;i++)assert.equal(gif.frameInfo(i).delay,delay);
  const a=Buffer.alloc(width*width*4),b=Buffer.alloc(a.length);gif.decodeAndBlitFrameRGBA(0,a);gif.decodeAndBlitFrameRGBA(Math.floor(frames/4),b);
  let changed=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])changed++;
  assert(changed>500,'Rendered frames must contain meaningful moving geometry');assert(new Set(a).size>20);
}

test('real MCP submission survives client exit; API media decodes, retry is idempotent, completed output survives restart',{timeout:180_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'oi-render-'));let service=await startService({directory,port:0});let connection=mcp(service.clientFile,directory);
  try {
    const api=client(service),request={request_id:randomUUID(),scene:oneRoom()};
    assert.equal((await fetch(service.origin+'/v1/render/jobs')).status,401);
    const {token}=JSON.parse(readFileSync(service.clientFile,'utf8'));
    assert.equal((await fetch(service.origin+'/v1/render/jobs',{headers:{authorization:'Bearer '+token,origin:'https://example.com'}})).status,403);
    writeFileSync(join(directory,'room.scene.json'),JSON.stringify(request.scene));
    const response=await connection.call('render_submit',{request_id:request.request_id,scene_path:'room.scene.json'});assert(!response.isError,JSON.stringify(response));assert.equal(response.structuredContent.status,'queued');
    connection.child.kill(); // Independent worker must continue without its OpenCode/MCP client.
    const route='/v1/render/jobs/'+request.request_id;
    const done=await wait(async()=>(await api(route)).json(),terminal);assert.equal(done.status,'completed',JSON.stringify(done));
    const bytes=Buffer.from(await (await api(route+'/media')).arrayBuffer());decoded(bytes,640,60,7);
    const metadata=await (await api(route+'/metadata')).json();assert.equal(metadata.review.frameCount,60);assert.equal(metadata.review.durationSeconds,4.2);assert.equal(metadata.review.width,640);assert.equal(metadata.scene_sha256,done.scene_sha256);assert.equal(metadata.review.assets[0].instanceId,'room-instance');assert.equal(hash(bytes),metadata.media.sha256);
    const duplicate=await (await api('/v1/render/jobs','POST',request)).json();assert.equal(duplicate.id,done.id);assert.equal(duplicate.status,'completed');
    assert.equal((await api('/v1/render/jobs','POST',{...request,options:{size:320}})).status,409);
    connection=mcp(service.clientFile,directory);const download=await connection.call('render_download',{job_id:done.id});assert(!download.isError,JSON.stringify(download));assert(readFileSync(join(directory,download.structuredContent.gif_path)).equals(bytes));
    connection.child.kill();await service.close();service=await startService({directory,port:0});
    const resumed=client(service);assert.equal((await (await resumed(route)).json()).status,'completed');assert(Buffer.from(await (await resumed(route+'/media')).arrayBuffer()).equals(bytes));
    const evidence=resolve('deliverables/backend-render');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'one-room.gif'),bytes);writeFileSync(join(evidence,'one-room.review.json'),JSON.stringify(metadata,null,2));writeFileSync(join(evidence,'one-room.scene.json'),JSON.stringify(request.scene,null,2));
    writeFileSync(join(service.store.path(done.id),'output.gif'),'corrupt');assert.equal((await resumed(route+'/media')).status,410);
    writeFileSync(join(service.store.path(done.id),'review.json'),'{}');assert.equal((await resumed(route+'/metadata')).status,410);
  }finally{connection.child.kill();await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('empty room, authored timeline and isolated sample use the shared renderer',{timeout:180_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'oi-render-scenes-')),service=await startService({directory,port:0});const api=client(service);
  try {
    const empty={...oneRoom(),assets:[],instances:[],bundledAssets:[],bundledVersions:[]};
    const animated=oneRoom();animated.animation={duration:2,loop:true,tracks:[{id:'room-instance:instance',instanceId:'room-instance',keys:[{id:'a',time:0,position:[0,0,0],rotation:[0,0,0]},{id:'b',time:2,position:[1,0,0],rotation:[0,90,0]}]}]};
    for(const [scene,options] of [[empty,{}],[animated,{motion:'animation',rangeStart:0,rangeEnd:2}],[oneRoom(),{scope:'asset',motion:'sample'}],[oneRoom(),{scope:'section',region:{x:0,z:0,width:4,depth:4},camera:{azimuthDegrees:90,elevationDegrees:45,distanceScale:1.5,fovDegrees:50}}]] as const){
      const id=randomUUID();const submit=await api('/v1/render/jobs','POST',{request_id:id,scene,options:{size:320,duration:2,fps:10,...options}});assert.equal(submit.status,202,await submit.text());
      const route='/v1/render/jobs/'+id,done=await wait(async()=>(await api(route)).json(),terminal);assert.equal(done.status,'completed',JSON.stringify(done));
      const bytes=Buffer.from(await (await api(route+'/media')).arrayBuffer()),meta=await (await api(route+'/metadata')).json();
      const gif=new GifReader(bytes);assert.equal(gif.numFrames(),20);assert.equal(gif.width,320);
      if(scene===empty){assert.equal(meta.review.emptyRoom,true);assert.deepEqual(meta.review.assets,[]);decoded(bytes,320,20,10);}
      if(scene===animated){assert.equal(meta.review.frames.length,20);assert.notDeepEqual(meta.review.frames[0].instances[0].position,meta.review.frames[19].instances[0].position);}
    }
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('malformed/missing geometry, bounded inputs, cancellation, deadline and renderer failure',{timeout:90_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'oi-render-fail-'));let service=await startService({directory,port:0});
  try {
    let api=client(service);const base={request_id:randomUUID(),scene:oneRoom(),options:{size:320,duration:2,fps:10}};
    for(const scene of [{}, {...oneRoom(),bundledAssets:[]}, {...oneRoom(),room:[Infinity,6,3]}])assert.equal((await api('/v1/render/jobs','POST',{...base,scene})).status,400);
    assert.equal((await api('/v1/render/jobs','POST',{...base,options:{size:9000}})).status,400);
    assert.equal((await api('/v1/render/jobs','POST',{...base,options:{camera:{distanceScale:100}}})).status,400);
    assert.equal((await api('/v1/render/jobs','POST',{...base,options:{scope:'section',region:{x:0,z:0,width:100,depth:2}}})).status,400);
    for(const options of [{camera:null},{rangeStart:'bad'},{snapshotTime:-1},{fps:60}])assert.equal((await api('/v1/render/jobs','POST',{...base,options})).status,400);
    assert.equal((await api('/v1/render/jobs','POST',{...base,extra:'x'})).status,400);
    const first=await (await api('/v1/render/jobs','POST',base)).json();assert(first.id);
    const second=await (await api('/v1/render/jobs','POST',{...base,request_id:randomUUID()})).json();
    const cancelled=await (await api(`/v1/render/jobs/${second.id}/cancel`,'POST')).json();assert.equal(cancelled.status,'cancelled');
    assert.equal((await api(`/v1/render/jobs/${second.id}/media`)).status,409);
    assert.equal((await (await api(`/v1/render/jobs/${first.id}/cancel`,'POST')).json()).status,'cancelled');
    assert.equal((await (await api(`/v1/render/jobs/${first.id}/cancel`,'POST')).json()).status,'cancelled');
    await service.close();service=await startService({directory,port:0,deadlineMs:100});api=client(service);
    const timed=await (await api('/v1/render/jobs','POST',{...base,request_id:randomUUID()})).json();
    const failed=await wait(async()=>(await api('/v1/render/jobs/'+timed.id)).json(),terminal);assert.equal(failed.error.code,'RENDER_TIMEOUT');
    await service.close();const previous=process.env.OI_RENDER_CHROMIUM;process.env.OI_RENDER_CHROMIUM=join(directory,'nonexistent-chromium');
    try{
      service=await startService({directory,port:0});api=client(service);
      const broken=await (await api('/v1/render/jobs','POST',{...base,request_id:randomUUID()})).json();const result=await wait(async()=>(await api('/v1/render/jobs/'+broken.id)).json(),terminal);
      assert.equal(result.status,'failed');assert.match(result.error.code,/RENDER_FAILED|WORKER_FAILED/);assert(result.error.message.length>5);
    }finally{if(previous===undefined)delete process.env.OI_RENDER_CHROMIUM;else process.env.OI_RENDER_CHROMIUM=previous;}
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('store enforces exclusive ownership, queue/retention budgets and crash recovery without replay',()=>{
  const directory=mkdtempSync(join(tmpdir(),'oi-render-store-'));let store=new RenderStore(directory);
  try{
    assert.throws(()=>new RenderStore(directory),/owns this state/);
    const jobs=[];for(let i=0;i<LIMITS.queue;i++)jobs.push(store.submit(normalize(envelope({request_id:randomUUID(),scene:oneRoom()}),oneRoom())));
    assert.throws(()=>store.submit(normalize(envelope({request_id:randomUUID(),scene:oneRoom()}),oneRoom())),/eight/);
    jobs[0].status='running';store.save(jobs[0]);store.close();store=new RenderStore(directory);
    assert(store.list().every(job=>job.status==='interrupted'));assert(store.list().every(job=>job.output===null));
    store.prune(Date.now()+LIMITS.retentionMs+1000);assert.equal(store.list().length,0);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('pinned local saved scene resolves immutable geometry, rejecting unpinned references',{timeout:30_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'oi-render-saved-')),sceneDirectory=join(directory,'scenes'),backend=new LocalSceneBackend(sceneDirectory);
  const sceneId=randomUUID();
  try{
    const fixture=JSON.parse(readFileSync('scripts/fixtures/cleanroom-scene-request.json','utf8'));fixture.request_id=sceneId;
    await executeSceneTool('astra.create_scene',fixture,{backend,origin:'http://127.0.0.1:5173',signal:new AbortController().signal});
  }finally{backend.close();}
  const service=await startService({directory:join(directory,'render'),sceneDirectory,port:0});
  try{
    const api=client(service),id=randomUUID();
    const response=await api('/v1/render/jobs','POST',{request_id:id,saved_scene:{scene_id:sceneId,revision:1},options:{size:320,duration:2,fps:10}});
    assert.equal(response.status,202,await response.text());assert.equal(service.store.input(id).source.kind,'local_revision');assert(service.store.input(id).scene.bundledVersions!.length>0);
    assert.equal((await api('/v1/render/jobs','POST',{request_id:randomUUID(),saved_scene:{scene_id:sceneId}})).status,400);
    assert.equal((await api('/v1/render/jobs','POST',{request_id:randomUUID(),saved_scene:{scene_id:sceneId,revision:999}})).status,404);
    service.worker.cancel(id);
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});


test('abrupt service process death marks in-flight work interrupted without publishing or replaying',{timeout:30_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'oi-render-crash-'));
  const processHandle=spawn(process.execPath,['--import','tsx','server/render/service.ts'],{env:{...process.env,OI_RENDER_STATE_DIR:directory,OI_RENDER_PORT:'0'},stdio:['pipe','pipe','pipe']});
  let output='',errors='';processHandle.stdout.on('data',b=>output+=b);processHandle.stderr.on('data',b=>errors+=b);
  let restarted:Awaited<ReturnType<typeof startService>>|undefined;
  try {
    await wait(async()=>output,v=>v.includes('OpenIndustries render service'),10000);
    const config=JSON.parse(readFileSync(join(directory,'client.json'),'utf8'));
    const api=client({origin:config.origin,clientFile:join(directory,'client.json')}),id=randomUUID();
    assert.equal((await api('/v1/render/jobs','POST',{request_id:id,scene:oneRoom()})).status,202,errors);
    await wait(async()=>(await api('/v1/render/jobs/'+id)).json(),job=>job.status==='running',10000);
    const exited=new Promise<void>(done=>processHandle.once('exit',()=>done()));processHandle.kill('SIGKILL');await exited;
    restarted=await startService({directory,port:0});const resumed=client(restarted);
    const job=await (await resumed('/v1/render/jobs/'+id)).json();assert.equal(job.status,'interrupted');assert.equal(job.output,null);
    assert.equal((await resumed('/v1/render/jobs/'+id+'/media')).status,409);
    const retry=await (await resumed('/v1/render/jobs','POST',{request_id:id,scene:oneRoom()})).json();assert.equal(retry.status,'interrupted');
  }finally{processHandle.kill();await restarted?.close();rmSync(directory,{recursive:true,force:true});}
});
