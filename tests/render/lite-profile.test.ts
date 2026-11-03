/** End-to-end isolated GIF worker verification for the Lite profile and 79-instance budget. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startService} from '../../server/render/service.ts';
import {oneRoom} from '../../benchmarks/render/build-scene.ts';

/** Poll a single isolated renderer job without requiring network credentials. */
async function waitResult(origin:string,token:string,id:string):Promise<Record<string,unknown>> {
  const stop=Date.now()+90_000;
  while(Date.now()<stop) {
    const reply=await fetch(`${origin}/v1/render/jobs/${id}`,{headers:{authorization:`Bearer ${token}`}});
    const data=await reply.json() as Record<string,unknown>;
    if(!['queued','running'].includes(String(data.status)))return data;
    await new Promise(done=>setTimeout(done,100));
  }
  throw Error('Lite render job timed out waiting for a terminal status.');
}

test('Lite GIF preserves output/source identity and rejects 79 instances within hard worker budget',{timeout:135000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'oi-lite-backend-'));
  const service=await startService({directory,port:0});
  const {token}=JSON.parse(readFileSync(service.clientFile,'utf8')) as {token:string};
  const api=async(path:string,method='GET',body?:unknown)=>{
    const response=await fetch(service.origin+path,{
      method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  };
  try {
    const scene=oneRoom(),id=randomUUID();
    const submission=await api('/v1/render/jobs','POST',{request_id:id,scene,options:{profile:'lite',size:320,duration:2,fps:10}});
    assert.equal(submission.status,202,JSON.stringify(submission.body));
    const completed=await waitResult(service.origin,token,id);
    assert.equal(completed.status,'completed',JSON.stringify(completed));
    const media=await fetch(`${service.origin}/v1/render/jobs/${id}/media`,{headers:{authorization:`Bearer ${token}`}});
    const bytes=Buffer.from(await media.arrayBuffer());
    assert.equal(bytes.subarray(0,6).toString(),'GIF89a');
    assert.ok(bytes.length>1000,'a Lite GIF cannot be a trivial empty payload');
    const {body:meta}=await api(`/v1/render/jobs/${id}/metadata`);
    const review=meta.review as Record<string,unknown>;
    assert.equal(review.renderProfile,'lite');
    assert.equal(review.frameCount,20);
    assert.deepEqual((review.assets as {instanceId:string}[]).map(entry=>entry.instanceId),['room-instance']);
    assert.match(String(meta.scene_sha256),/^[a-f0-9]{64}$/);
    const source=readFileSync('benchmarks/kitchen-lite/79-instance-synthetic.oi.json','utf8');
    const oversized=await api('/v1/render/jobs','POST',{request_id:randomUUID(),scene:JSON.parse(source),
      options:{profile:'lite',size:320,duration:2,fps:10}});
    assert.equal(oversized.status,422);
    const error=oversized.body.error as {code:string;message:string};
    assert.equal(error.code,'GEOMETRY_LIMIT');
    assert.match(error.message,/64 instances/);
    assert.match(error.message,/79/);
    mkdirSync('test-results',{recursive:true});
    writeFileSync('test-results/lite-backend.gif',bytes);
    writeFileSync('test-results/lite-backend-metadata.json',JSON.stringify(meta,null,2));
    console.log('PASS Lite backend: real GIF89a media, 20 evaluated frames, source hash and structured 79>64 budget error.');
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});
