import * as THREE from 'three';
import { captureBytesHash, captureSceneHash } from './gif';
import type { Workspace } from './workspace';
import type { RenderProfile } from './render-profile';

/** An exact rendered camera snapshot; user-initiated, not a machine observation. */
export type LiteSnapshotMetadata = {
  schemaVersion: 1;
  sourceClassification: 'synthetic_scene_render';
  renderProfile: 'lite';
  sceneKey: string | null; sceneRevision: number | null;
  sceneSha256: string; mediaSha256: string;
  timeSeconds: number | null;
  capturedAt: string; width: number; height: number; units: 'm'; upAxis: 'Y';
  camera: {position: [number,number,number]; quaternion: [number,number,number,number]; fovDegrees: number; near: number; far: number};
  instances: {id:string;assetId:string;sourceDigest:string;cloudVersionId?:string;missing:boolean;visible:boolean}[];
  performance: {cpuRasterAndReadMs:number;drawCalls:number;triangles:number;gpuGeometries:number;gpuTextures:number};
};
export type LiteSnapshotResult={blob:Blob; filename:string; metadata:LiteSnapshotMetadata};

/** Snapshot from the *active* shared WebGL scene/camera without recreating geometry. */
export async function captureLiteSnapshot(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  workspace: Workspace,
  options: {size:320|480|640;time:number|null;sceneKey?:string|null;sceneRevision?:number|null;profile:RenderProfile},
):Promise<LiteSnapshotResult>{
  if(options.profile!=='lite')throw Error('Select 3D Lite to capture a Lite snapshot.');
  if(workspace.items.some(item=>item.missing))throw Error('Missing geometry: restore original assets before exporting Lite evidence.');
  if(workspace.items.length>128)throw Error('Lite browser snapshot limit: 128 scene instances.');
  if(![320,480,640].includes(options.size))throw Error('Lite snapshot must be 320, 480 or 640 px.');
  const {size}=options;
  const originalAspect=camera.aspect,originalTarget=renderer.getRenderTarget();
  const target=new THREE.WebGLRenderTarget(size,size,{depthBuffer:true,stencilBuffer:false});
  const sourceWorkspace={room:[...workspace.room] as Workspace['room'],items:[...workspace.items],animation:workspace.animation};
  const bounds=sourceWorkspace.items.map(item=>({id:item.id,assetId:item.asset.id,
    sourceDigest:item.asset.source.digest,...(item.cloudVersionId?{cloudVersionId:item.cloudVersionId}:{}),
    missing:!!item.missing,visible:item.visible}));
  const pose={
    position:camera.position.toArray() as [number,number,number],
    quaternion:camera.quaternion.toArray() as [number,number,number,number],
    fovDegrees:camera.fov,near:camera.near,far:camera.far,
  };
  const started=performance.now();
  const read=new Uint8Array(size*size*4);
  let stats:{cpuRasterAndReadMs:number;drawCalls:number;triangles:number;gpuGeometries:number;gpuTextures:number};
  try{
    camera.aspect=1;camera.updateProjectionMatrix();
    renderer.setRenderTarget(target);
    renderer.render(scene,camera);
    renderer.readRenderTargetPixels(target,0,0,size,size,read);
    stats={
      cpuRasterAndReadMs:performance.now()-started,
      drawCalls:renderer.info.render.calls,
      triangles:renderer.info.render.triangles,
      gpuGeometries:renderer.info.memory.geometries,
      gpuTextures:renderer.info.memory.textures,
    };
  }finally{
    renderer.setRenderTarget(originalTarget);
    camera.aspect=originalAspect;camera.updateProjectionMatrix();
    target.dispose();
  }
  const pixels=new Uint8ClampedArray(read.length),stride=size*4;
  for(let y=0;y<size;y++)pixels.set(read.subarray((size-1-y)*stride,(size-y)*stride),y*stride);
  const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;
  const context=canvas.getContext('2d');
  if(!context)throw Error('A 2D canvas is required to encode Lite snapshots.');
  context.putImageData(new ImageData(pixels,size,size),0,0);
  context.fillStyle='#111a18';context.fillRect(0,size-26,size,26);
  context.fillStyle='#e4f3db';context.font='10px sans-serif';
  context.fillText('OPENINDUSTRIES | 3D LITE | SYNTHETIC VIEW',8,size-9);
  const blob=await new Promise<Blob>((resolve,reject)=>{
    canvas.toBlob(value=>value?resolve(value):reject(Error('Browser could not encode Lite PNG.')),'image/png');
  });
  const [sceneSha256,mediaSha256]=await Promise.all([captureSceneHash(sourceWorkspace),captureBytesHash(blob)]);
  const metadata:LiteSnapshotMetadata={
    schemaVersion:1,sourceClassification:'synthetic_scene_render',renderProfile:'lite',
    sceneKey:options.sceneKey??null,sceneRevision:options.sceneRevision??null,
    sceneSha256,mediaSha256,
    timeSeconds:options.time,capturedAt:new Date().toISOString(),width:size,height:size,units:'m',upAxis:'Y',
    camera:pose,instances:bounds,performance:stats!,
  };
  return {blob,filename:`oi-lite-${size}.png`,metadata};
}
