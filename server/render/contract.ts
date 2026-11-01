/** Bounded backend render input using the workbench's portable scene and GIF semantics. */
import { createHash } from 'node:crypto';
import { canonicalJSON, hydrateManifest, makeManifest, readManifest, type SceneManifest } from '../../src/lib/workspace.ts';
import { defaultGifCamera, regionBounds, type GifOptions } from '../../src/lib/gif-contract.ts';

export const LIMITS = { inputBytes:8*1024*1024, instances:64, vertices:200_000, indices:600_000,
  parts:512, frames:60, outputBytes:64*1024*1024, queue:8, jobs:128, deadlineMs:120_000, retentionMs:7*86400_000 } as const;
export type SavedSource = { scene_id:string; revision:number };
export type RenderRequest = { request_id:string; scene?:unknown; saved_scene?:SavedSource; options?:Partial<GifOptions> };
export type RenderInput = { request_id:string; scene:SceneManifest; scene_sha256:string; options:GifOptions;
  source: {kind:'portable'} | ({kind:'local_revision'} & SavedSource); fingerprint:string };
export class RenderError extends Error {
  constructor(readonly code:string, message:string, readonly status=400) { super(message);this.name='RenderError'; }
}
export const hash = (value:string|Buffer):string => createHash('sha256').update(value).digest('hex');
export const uuid = (value:unknown):value is string => typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
/** Validate the outer envelope before reading any configured saved scene. */
export function envelope(raw:unknown):RenderRequest {
  const value=raw as RenderRequest;
  if(!value||typeof value!=='object'||Array.isArray(value)||!uuid(value.request_id)||Object.keys(value).some(k=>!['request_id','scene','saved_scene','options'].includes(k))||('scene' in value)===('saved_scene' in value))throw new RenderError('INVALID_REQUEST','Provide request_id and exactly one portable scene or pinned saved_scene.');
  if(value.saved_scene&&(!uuid(value.saved_scene.scene_id)||!Number.isSafeInteger(value.saved_scene.revision)||value.saved_scene.revision<1||Object.keys(value.saved_scene).some(k=>!['scene_id','revision'].includes(k))))throw new RenderError('INVALID_REVISION','Saved scenes require a UUID scene_id and explicit positive revision.');
  if(Buffer.byteLength(JSON.stringify(value))>LIMITS.inputBytes)throw new RenderError('PAYLOAD_TOO_LARGE','Render request exceeds 8 MiB.',413);
  return value;
}
/** Normalize complete immutable geometry; missing placeholders may never masquerade as renders. */
export function normalize(request:RenderRequest, scene:unknown):RenderInput {
  try {
    const manifest=readManifest(scene);
    if(manifest.instances.length>LIMITS.instances)throw new RenderError('GEOMETRY_LIMIT','At most 64 instances are supported.');
    const workspace=hydrateManifest(manifest,[]);
    if(workspace.items.some(i=>i.missing))throw new RenderError('MISSING_GEOMETRY','Bundle the exact geometry for every referenced instance.');
    let vertices=0,indices=0,parts=0;
    for(const item of workspace.items)for(const part of item.asset.parts){vertices+=part.vertices.length/3;indices+=part.indices.length;parts++;}
    if(vertices>LIMITS.vertices||indices>LIMITS.indices||parts>LIMITS.parts)throw new RenderError('GEOMETRY_LIMIT','Expanded instance geometry exceeds the render budget.');
    const raw=request.options??{};
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['scope','assetIndex','region','motion','size','duration','fps','rangeStart','rangeEnd','snapshotTime','camera'].includes(k)))throw new RenderError('INVALID_OPTIONS','Unknown render option.');
    const options:GifOptions={scope:'room',assetIndex:0,region:{x:0,z:0,width:workspace.room[0],depth:workspace.room[1]},motion:'turntable',size:640,duration:4,fps:15,...raw,allowEmptyRoom:true,camera:{...defaultGifCamera,...raw.camera}};
    if(!['room','section','asset'].includes(options.scope)||!['turntable','sample','animation'].includes(options.motion)||![320,480,640].includes(options.size)||![2,3,4].includes(options.duration)||![10,15].includes(options.fps))throw new RenderError('INVALID_OPTIONS','Use GIF studio presets: 320/480/640 px, 2/3/4 seconds, 10/15 fps.');
    if(!Number.isSafeInteger(options.assetIndex)||options.assetIndex<0||options.scope==='asset'&&!workspace.items[options.assetIndex])throw new RenderError('INVALID_ASSET','Select an existing asset index.');
    if(options.motion==='sample'&&options.scope!=='asset')throw new RenderError('INVALID_OPTIONS','Sample motion requires asset scope.');
    if(options.scope==='section')regionBounds(options.region,workspace.room);
    if(raw.camera!==undefined&&(!raw.camera||typeof raw.camera!=='object'||Array.isArray(raw.camera)))throw new RenderError('INVALID_CAMERA','Camera must be an object.');
    for(const key of ['rangeStart','rangeEnd'] as const)if(raw[key]!==undefined&&(typeof raw[key]!=='number'||!Number.isFinite(raw[key])))throw new RenderError('INVALID_TIME','Range endpoints must be finite seconds.');
    const c=options.camera!;
    if(!Object.keys(c).every(k=>['azimuthDegrees','elevationDegrees','distanceScale','fovDegrees'].includes(k))||![c.azimuthDegrees,c.elevationDegrees,c.distanceScale,c.fovDegrees].every(v=>typeof v==='number'&&Number.isFinite(v))||c.azimuthDegrees< -360||c.azimuthDegrees>360||c.elevationDegrees<5||c.elevationDegrees>85||c.distanceScale<1||c.distanceScale>3||c.fovDegrees<20||c.fovDegrees>70)throw new RenderError('INVALID_CAMERA','Invalid bounded orbit camera settings.');
    if(options.snapshotTime!=null&&(!Number.isFinite(options.snapshotTime)||options.snapshotTime<0||options.snapshotTime>workspace.animation.duration))throw new RenderError('INVALID_TIME','Snapshot time is outside the timeline.');
    const start=options.rangeStart??0,end=options.rangeEnd??Math.min(workspace.animation.duration,3);
    if(options.motion==='animation'&&(!workspace.animation.tracks.length||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>workspace.animation.duration||end-start>4))throw new RenderError('INVALID_ANIMATION','Select an authored timeline range of at most four seconds.');
    const count=options.motion==='animation'?Math.ceil((end-start)*1000/(Math.round(100/options.fps)*10)):options.duration*options.fps;
    if(count>LIMITS.frames)throw new RenderError('FRAME_LIMIT','At most 60 frames are supported.');
    if(!workspace.items.length&&options.scope!=='room')throw new RenderError('EMPTY_SCOPE','Empty scenes support room environment rendering only.');
    const portable=makeManifest(workspace,true),serialized=canonicalJSON(portable);
    if(Buffer.byteLength(serialized)>LIMITS.inputBytes)throw new RenderError('PAYLOAD_TOO_LARGE','Expanded portable scene exceeds 8 MiB.',413);
    const source:RenderInput['source']=request.saved_scene?{kind:'local_revision',...request.saved_scene}:{kind:'portable'};
    return {request_id:request.request_id,scene:portable,scene_sha256:hash(serialized),options,source,
      fingerprint:hash(canonicalJSON({scene:portable,options,source}))};
  }catch(error){if(error instanceof RenderError)throw error;throw new RenderError('INVALID_SCENE',error instanceof Error?error.message:'Invalid scene.');}
}
