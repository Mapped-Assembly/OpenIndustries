/** Local authenticated asynchronous GIF API, independently supervised from OpenCode. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { envelope, LIMITS, normalize, RenderError, requestSHA256, uuid, type RenderAssetBinding, type RenderRequest, type ResolvedSavedSource } from './contract.ts';
import { readManifest } from '../../src/lib/workspace.ts';
import { atomicJSON, RenderStore } from './store.ts';
import { RenderWorker } from './worker.ts';
import { LocalSceneBackend } from '../local-scene-backend.ts';

export type ServiceOptions={directory:string;port?:number;concurrency?:number;deadlineMs?:number;web?:string;sceneDirectory?:string};
/** Read JSON with a byte cap even when Content-Length is missing or dishonest. */
async function body(req:IncomingMessage):Promise<unknown> {
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new RenderError('CONTENT_TYPE','Use application/json.',415);
  if(Number(req.headers['content-length']??0)>LIMITS.inputBytes)throw new RenderError('PAYLOAD_TOO_LARGE','Render request exceeds 8 MiB.',413);
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>LIMITS.inputBytes)throw new RenderError('PAYLOAD_TOO_LARGE','Render request exceeds 8 MiB.',413);chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new RenderError('INVALID_JSON','Malformed JSON.');}
}
function json(res:ServerResponse,status:number,value:unknown):void {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
/** Resolve a persistent revision and its integrity-checked immutable assets before enqueueing. */
async function resolveSavedScene(directory:string, request:RenderRequest):Promise<{scene:unknown;source:ResolvedSavedSource}> {
  const source=request.saved_scene!;
  if(!existsSync(join(directory,'scenes.sqlite')))throw new RenderError('SCENE_STORE_UNAVAILABLE','Configured local scene store does not exist.',503);
  let backend:LocalSceneBackend;
  try{backend=new LocalSceneBackend(directory);}catch{throw new RenderError('SCENE_STORE_UNAVAILABLE','Could not open configured local scene store.',503);}
  try {
    const head=await backend.head(source.scene_id);
    if(!head)throw new RenderError('SCENE_NOT_FOUND','Saved scene ID was not found.',404);
    let revision=head.revision;
    if(source.revision!==undefined) {
      try{revision=(await backend.read(source.scene_id,source.revision)).revision;}
      catch{throw new RenderError('SCENE_REVISION_NOT_FOUND','Requested immutable scene revision was not found.',404);}
    }
    // Pin head immediately: a concurrent writer may advance the head while assets load.
    let scene:Awaited<ReturnType<LocalSceneBackend['exportScene']>>;
    try{scene=await backend.exportScene(source.scene_id,revision);}
    catch{throw new RenderError('ASSET_UNAVAILABLE','Saved revision geometry or its immutable asset versions cannot be loaded.',422);}
    const manifest=readManifest(scene);
    const digest=new Map(manifest.assets.map(asset=>[asset.id,asset.source.digest]));
    const assets:RenderAssetBinding[]=[];
    const versions=new Set<string>();
    for(const item of manifest.instances) {
      if(!item.cloudVersionId)throw new RenderError('ASSET_UNAVAILABLE','Saved scene has an unversioned instance.',422);
      if(versions.has(item.cloudVersionId))continue;
      versions.add(item.cloudVersionId);
      const version=await backend.asset(item.cloudVersionId);
      const file=version?.files.find(file=>file.name==='asset.json');
      if(!version||!file||version.asset?.asset_key!==item.assetId||!/^[a-f0-9]{64}$/.test(version.fingerprint)||!/^[a-f0-9]{64}$/.test(file.sha256))
        throw new RenderError('ASSET_UNAVAILABLE','Saved asset version metadata is missing or inconsistent.',422);
      try{await backend.geometry(version);}catch{throw new RenderError('ASSET_UNAVAILABLE','Saved asset version file is missing or failed integrity verification.',422);}
      assets.push({asset_id:item.assetId,version_id:version.id,fingerprint:version.fingerprint,sha256:file.sha256,source_digest:digest.get(item.assetId)??''});
    }
    assets.sort((a,b)=>a.version_id.localeCompare(b.version_id));
    return {scene,source:{kind:'saved_scene',scene_id:source.scene_id,revision,assets}};
  }catch(error){
    if(error instanceof RenderError)throw error;
    throw new RenderError('SCENE_STORE_UNAVAILABLE','Saved scene store could not be read.',503);
  }finally{backend.close();}
}
/** Start a loopback-only single-user authority; return an explicit shutdown handle for supervisors/tests. */
export async function startService(options:ServiceOptions) {
  const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
  const web=resolve(options.web??join(root,'dist-render'));
  if(!existsSync(join(web,'index.html')))throw new RenderError('RENDER_BUILD_MISSING','Run npm run build:render before starting the service.',500);
  const store=new RenderStore(options.directory);
  let worker:RenderWorker;
  try{worker=new RenderWorker(store,web,options.concurrency??1,options.deadlineMs??LIMITS.deadlineMs);}catch(error){store.close();throw error;}
  let token:string;try{token=store.token();}catch(error){store.close();throw error;}
  let origin='',closing=false;
  const server=createServer(async(req,res)=>{
    try {
      if(req.headers.host!==origin.slice('http://'.length))throw new RenderError('HOST_REQUIRED','Use the configured loopback origin.',403);
      if(req.url==='/health'&&req.method==='GET')return json(res,200,{service:'openindustries-render',healthy:!closing});
      const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new RenderError('AUTH_REQUIRED','Renderer bearer capability required.',401);
      if(req.headers.origin&&req.headers.origin!==origin)throw new RenderError('ORIGIN_REFUSED','Cross-origin requests are refused.',403);
      if(closing)throw new RenderError('SHUTTING_DOWN','Renderer is shutting down.',503);
      if(req.url==='/v1/render/jobs'&&req.method==='POST'){
        const request=envelope(await body(req));
        // A network retry of a head render must return its original pinned revision.
        const receipt=store.receipt(request.request_id,requestSHA256(request));
        if(receipt){json(res,202,receipt);return;}
        let scene=request.scene;let savedSource:ResolvedSavedSource|undefined;
        if(request.saved_scene){
          if(!options.sceneDirectory)throw new RenderError('SAVED_SCENES_DISABLED','Configure OI_RENDER_SCENE_DIR, or submit a portable scene.');
          ({scene,source:savedSource}=await resolveSavedScene(options.sceneDirectory,request));
        }
        const job=store.submit(normalize(request,scene,savedSource));json(res,202,job);setImmediate(()=>worker.pump());return;
      }
      if(req.url==='/v1/render/jobs'&&req.method==='GET')return json(res,200,{jobs:store.list()});
      const match=/^\/v1\/render\/jobs\/([^/]+)(?:\/(cancel|media|metadata))?$/.exec(req.url??'');
      if(!match||!uuid(match[1]))throw new RenderError('NOT_FOUND','Unknown render endpoint.',404);
      const [,id,action]=match;
      if(!action&&req.method==='GET')return json(res,200,store.get(id));
      if(action==='cancel'&&req.method==='POST')return json(res,200,worker.cancel(id));
      if(!action&&req.method==='DELETE'){store.delete(id);return json(res,200,{deleted:id});}
      if((action==='media'||action==='metadata')&&req.method==='GET'){
        const bytes=worker.artifact(id,action);res.writeHead(200,{'content-type':action==='media'?'image/gif':'application/json',
          'content-length':bytes.length,'content-disposition':`attachment; filename="${id}.${action==='media'?'gif':'json'}"`,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);return;
      }
      throw new RenderError('METHOD_NOT_ALLOWED','Unsupported render operation.',405);
    }catch(error){const known=error instanceof RenderError;json(res,known?error.status:500,{error:{code:known?error.code:'RENDER_UNAVAILABLE',message:known?error.message:'Render service unavailable.'}});}
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.maxConnections=32;
  try {
    await new Promise<void>((done,fail)=>server.once('error',fail).listen(options.port??4198,'127.0.0.1',done));
    origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    atomicJSON(join(store.directory,'client.json'),{origin,token});
  }catch(error){server.close();await worker.close();store.close();throw error;}
  const prune=setInterval(()=>store.prune(),60_000);prune.unref();
  return {origin,store,worker,clientFile:join(store.directory,'client.json'),async close():Promise<void>{
    if(closing)return;closing=true;clearInterval(prune);server.close();server.closeIdleConnections();await worker.close();store.close();
  }};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const service=await startService({directory:process.env.OI_RENDER_STATE_DIR??join(homedir(),'.local/share/open-industries/render'),
    port:Number(process.env.OI_RENDER_PORT??4198),concurrency:Number(process.env.OI_RENDER_CONCURRENCY??1),
    sceneDirectory:process.env.OI_RENDER_SCENE_DIR});
  console.log(`OpenIndustries render service: ${service.origin}\nPrivate client configuration: ${service.clientFile}`);
  const stop=()=>{void service.close().then(()=>process.exit(0));};process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
