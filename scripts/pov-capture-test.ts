import assert from 'node:assert/strict';
import { Group, Mesh, BoxGeometry } from 'three';
import type { Asset } from '../src/lib/scene';
import { evaluateWorkspace, type Workspace } from '../src/lib/workspace';
import { createWorld, applyWorldPoses } from '../src/lib/world';
import {
  attachedPreset, loadPovPresets, resolvePovCameraFrame, storePovPresets,
  validatePovPreset, worldPresetFromSession, assertPovSceneBudget,
} from '../src/lib/pov-capture';
import { normalize, RenderError } from '../server/render/contract';
import { makeManifest } from '../src/lib/workspace';

const asset: Asset = {
  schemaVersion:1, units:'m', upAxis:'Y', id:'test-camera-mount', name:'Camera mount', dimensions:[.3,.3,.3], originOffset:[0,0,0],
  source:{kind:'generated',filename:'mount.fixture',digest:'a'.repeat(64),generator:'oi-fixture'},
  parts:[{id:'gripper',name:'Gripper',vertices:[0,0,0,.2,0,0,0,.2,0],indices:[0,1,2],metadata:{}}],
  hierarchy:{id:'root',name:'root',partIds:['gripper'],children:[]},warnings:[],
};
const item={id:'robot-1',name:'Robot',position:[0,0,0] as [number,number,number],rotation:[0,0,0] as [number,number,number],visible:true,asset};
const workspace:Workspace={
  room:[6,5,3],items:[item],
  animation:{duration:2,loop:false,tracks:[{
    id:'robot-1:instance',instanceId:'robot-1',keys:[
      {id:'a',time:0,position:[0,0,0],rotation:[0,0,0]},
      {id:'b',time:2,position:[1,0,0],rotation:[0,90,0]},
    ],
  }]},
};
const saved=worldPresetFromSession({pov:{position:[0,1.65,1],yaw:.2,pitch:.1}},'Workbench','user:scene',null);
assert.equal(validatePovPreset(saved).binding.kind,'worldPose');
assert.throws(()=>validatePovPreset({...saved,fovDegrees:180}),/Invalid POV/);
assert.throws(()=>validatePovPreset({...saved,binding:{kind:'worldPose',position:[0,0,0],quaternion:[1,1,1,1]}}),/Invalid POV/);
const local=new Map<string,string>();
const storage={
  getItem:(key:string)=>local.get(key)??null,
  setItem:(key:string,value:string)=>{local.set(key,value);},
};
storePovPresets(storage,'user:scene',[saved]);
assert.equal(loadPovPresets(storage,'user:scene','user:scene')[0].id,saved.id);
assert.equal(loadPovPresets(storage,'user:scene','other-scene').length,0);
assertPovSceneBudget(workspace);
assert.throws(()=>assertPovSceneBudget({...workspace,items:[{...item,missing:true}]}),/missing source geometry/);

const rig=attachedPreset(workspace,item.id,'Mounted','user:scene',null,'gripper');
const world=createWorld([asset],workspace.room);
const at=(time:number)=>{
  const evaluated=evaluateWorkspace(workspace.items,workspace.animation,time);
  applyWorldPoses(world.groups,evaluated);
  return resolvePovCameraFrame(rig,workspace,world.groups,time);
};
const start=at(0), end=at(2);
assert.equal(start.parentPartId,'gripper');
assert.equal(end.time,2);
assert.ok(Math.abs(end.position[0]-start.position[0])>.4, 'moving parent changes POV position');
assert.notDeepEqual(start.quaternion,end.quaternion,'rotating parent changes POV direction');
world.groups[0].visible=false;
assert.throws(()=>resolvePovCameraFrame(rig,workspace,world.groups,1),/hidden or unavailable/);
world.dispose();
assert.throws(()=>attachedPreset(workspace,item.id,'Bad','user:scene',null,'absent'),/part does not exist/);

const request={request_id:'19de2601-1111-4111-8111-111111111111',scene:makeManifest(workspace,true),options:{
  scope:'room' as const, assetIndex:0, motion:'pov' as const,
  size:320, duration:2, fps:10, region:{x:0,z:0,width:6,depth:5}, pov:saved,
}};
const normalized=normalize(request,request.scene);
assert.equal(normalized.options.pov?.id,saved.id);
assert.equal(normalized.options.motion,'pov');
const backendFailure=(options:typeof request.options,code:string)=>{
  assert.throws(()=>normalize({...request,options},request.scene),error=>error instanceof RenderError&&error.code===code);
};
backendFailure({...request.options,pov:{...saved,sceneRevision:5}},'CAMERA_REVISION_UNVERIFIED');
backendFailure({...request.options,pov:{...saved,binding:{...saved.binding,position:[NaN,0,0]}}},'INVALID_CAMERA');
backendFailure({...request.options,motion:'turntable' as 'pov'},'INVALID_OPTIONS');
console.log('PASS scene-scoped presets, validated rigs, animated attachment transforms, missing frames, and backend POV input guards.');
