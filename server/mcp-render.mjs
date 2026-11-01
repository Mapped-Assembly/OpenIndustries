/** MCP is only a client of the independently running local render service. */
import { readFileSync, mkdirSync, writeFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';
import { createHash } from 'node:crypto';

const job={type:'string',pattern:'^[0-9a-fA-F-]{36}$'};
const options={type:'object',properties:{scope:{enum:['room','section','asset']},assetIndex:{type:'integer',minimum:0},motion:{enum:['turntable','sample','animation']},size:{enum:[320,480,640]},duration:{enum:[2,3,4]},fps:{enum:[10,15]},rangeStart:{type:'number'},rangeEnd:{type:'number'},snapshotTime:{type:['number','null']},region:{type:'object'},camera:{type:'object'}},additionalProperties:false};
export const renderTools=[
  {name:'astra.render_submit',description:'Submit a portable scene or an explicitly pinned local saved revision for a backend GIF. No workbench or model session is required. Reuse request_id for uncertain retries.',inputSchema:{type:'object',properties:{request_id:job,scene:{type:'object'},scene_path:{type:'string',description:'Checkout-relative portable scene JSON file; mutually exclusive with scene and saved_scene.'},saved_scene:{type:'object',properties:{scene_id:job,revision:{type:'integer',minimum:1}},required:['scene_id','revision'],additionalProperties:false},options},required:['request_id'],additionalProperties:false}},
  ...['status','cancel','download'].map(action=>({name:`astra.render_${action}`,description:{status:'Read durable backend render progress, failure and completed download paths.',cancel:'Cancel queued or running rendering directly. Partial outputs are never published.',download:'Download completed GIF and review metadata into .astra/render-downloads under the checkout; return local paths and verified hash.'}[action],inputSchema:{type:'object',properties:{job_id:job},required:['job_id'],additionalProperties:false}})),
];
/** Stable errors are returned as MCP tool errors, without exposing private configuration. */
export class RenderToolError extends Error {constructor(code,message){super(message);this.name='RenderToolError';this.code=code;}}
async function bounded(response,maxBytes){
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new RenderToolError('RESPONSE_TOO_LARGE','Renderer response exceeded its download limit.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
/** Dispatch only fixed local routes with the capability retained outside tool responses. */
export async function callRenderTool(root,name,args={}){
  if(!args||typeof args!=='object'||Array.isArray(args))throw new RenderToolError('INVALID_REQUEST','Tool arguments must be an object.');
  let config;
  try{
    config=JSON.parse(readFileSync(process.env.OI_RENDER_CLIENT_FILE,'utf8'));
    const url=new URL(config.origin);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash||typeof config.token!=='string')throw Error();
  }catch{throw new RenderToolError('RENDER_NOT_CONFIGURED','Set OI_RENDER_CLIENT_FILE to the independently running renderer client.json.');}
  async function fetchRoute(path,method='GET',payload){
    let response;
    try{response=await fetch(config.origin+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});}
    catch{throw new RenderToolError('RENDER_UNAVAILABLE','Renderer unavailable. Inspect status or retry the identical request_id after reconnecting.');}
    const bytes=await bounded(response,64*1024*1024);
    if(!response.ok){let value;try{value=JSON.parse(bytes);}catch{}throw new RenderToolError(value?.error?.code??'RENDER_FAILED',value?.error?.message??'Renderer request failed.');}
    return bytes;
  }
  if(name==='astra.render_submit'){
    if(args.scene_path!==undefined){
      if(typeof args.scene_path!=='string'||args.scene!==undefined||args.saved_scene!==undefined)throw new RenderToolError('INVALID_REQUEST','Provide exactly one scene, saved_scene or scene_path.');
      let scene;
      try{
        const base=realpathSync(root),file=realpathSync(resolve(base,args.scene_path));
        if(!file.startsWith(base+sep)||statSync(file).size>8*1024*1024)throw Error();
        scene=JSON.parse(readFileSync(file,'utf8'));
      }catch{throw new RenderToolError('SCENE_FILE_UNAVAILABLE','Use an existing portable scene JSON file inside the checkout, at most 8 MiB.');}
      const {scene_path,...rest}=args;args={...rest,scene};
    }
    return JSON.parse(await fetchRoute('/v1/render/jobs','POST',args));
  }
  if(!args||Object.keys(args).some(k=>k!=='job_id')||typeof args.job_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.job_id))throw new RenderToolError('INVALID_JOB','Provide a UUID job_id.');
  const path='/v1/render/jobs/'+args.job_id;
  if(name==='astra.render_status')return JSON.parse(await fetchRoute(path));
  if(name==='astra.render_cancel')return JSON.parse(await fetchRoute(path+'/cancel','POST'));
  if(name!=='astra.render_download')throw new RenderToolError('UNKNOWN_TOOL','Unknown render tool.');
  const status=JSON.parse(await fetchRoute(path)),media=await fetchRoute(path+'/media'),metadata=await fetchRoute(path+'/metadata');
  const digest=createHash('sha256').update(media).digest('hex');
  if(digest!==status.output?.sha256||createHash('sha256').update(metadata).digest('hex')!==status.output?.metadata_sha256)throw new RenderToolError('OUTPUT_INTEGRITY','Downloaded GIF does not match its recorded hash.');
  const base=realpathSync(root),parent=join(base,'.astra'),directory=join(parent,'render-downloads');
  if(existsSync(parent)&&!realpathSync(parent).startsWith(base+sep))throw new RenderToolError('UNSAFE_OUTPUT_PATH','Download directory must remain inside the checkout.');
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(!realpathSync(directory).startsWith(base+sep))throw new RenderToolError('UNSAFE_OUTPUT_PATH','Download directory must remain inside the checkout.');
  for(const [extension,bytes] of [['gif',media],['json',metadata]]){
    const target=join(directory,args.job_id+'.'+extension);
    if(existsSync(target)){if(!realpathSync(target).startsWith(base+sep)||!readFileSync(target).equals(bytes))throw new RenderToolError('OUTPUT_EXISTS','Refusing to replace a different existing download.');}
    else writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  }
  return {job_id:args.job_id,gif_path:relative(base,join(directory,args.job_id+'.gif')),metadata_path:relative(base,join(directory,args.job_id+'.json')),sha256:digest,bytes:media.length};
}
