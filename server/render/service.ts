/** Local authenticated asynchronous GIF API, independently supervised from OpenCode. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { envelope, LIMITS, normalize, RenderError, uuid } from './contract.ts';
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
        const request=envelope(await body(req));let scene=request.scene;
        if(request.saved_scene){
          if(!options.sceneDirectory)throw new RenderError('SAVED_SCENES_DISABLED','Configure OI_RENDER_SCENE_DIR, or submit a portable scene.');
          if(!existsSync(join(options.sceneDirectory,'scenes.sqlite')))throw new RenderError('SCENE_UNAVAILABLE','Configured scene store does not exist.',404);
          const backend=new LocalSceneBackend(options.sceneDirectory);
          try{scene=await backend.exportScene(request.saved_scene.scene_id,request.saved_scene.revision);}catch(error){throw new RenderError('SCENE_UNAVAILABLE',error instanceof Error?error.message:'Saved scene could not be resolved.',404);}finally{backend.close();}
        }
        const job=store.submit(normalize(request,scene));json(res,202,job);setImmediate(()=>worker.pump());return;
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
