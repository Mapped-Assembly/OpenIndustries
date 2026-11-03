import assert from 'node:assert/strict';
import * as THREE from 'three';
import { canonicalJSON, evaluateWorkspace, makeManifest, type Workspace } from '../src/lib/workspace';
import type { Asset, Vec3 } from '../src/lib/scene';
import { applyWorldPoses, createWorld } from '../src/lib/world';
import {
  attachedPreset, attachedRigEulerDegrees, configureAttachedRig, resolvePovCameraFrame,
} from '../src/lib/pov-capture';

const robot: Asset = {
  schemaVersion: 1, id: 'pinned-robot-model', name:'SO-101 link fixture', units:'m', upAxis:'Y',
  dimensions:[.5,.5,.5], originOffset:[0,0,0],
  source:{kind:'generated',generator:'opencad-robot',filename:'pinned.urdf',digest:'robot-model-sha256-a'},
  parts:[
    {id:'base',name:'Base link',vertices:[0,0,0,.2,0,0,0,.2,0],indices:[0,1,2],metadata:{link:'base'}},
    {id:'gripper',name:'Gripper visual',vertices:[0,0,.1,.1,0,.1,0,.1,.1],indices:[0,1,2],metadata:{link:'gripper'}},
  ],
  hierarchy:{id:'robot',name:'Robot',partIds:['base','gripper'],children:[]},warnings:[],
};
const item={
  id:'robot-instance',name:'Robot link',asset:robot,visible:true,
  position:[0,0,0] as Vec3, rotation:[0,0,0] as Vec3, cloudVersionId:'pinned-version',
};
const workspace:Workspace = {
  room:[6,5,3], items:[item], animation:{duration:2,loop:false,tracks:[
    {id:'robot-instance:instance',instanceId:item.id,keys:[
      {id:'t0',time:0,position:[0,0,0],rotation:[0,0,0]},
      {id:'t2',time:2,position:[1,0,.5],rotation:[0,90,0]},
    ]},
    {id:'robot-instance:gripper',instanceId:item.id,partId:'gripper',keys:[
      {id:'p0',time:0,position:[0,0,0],rotation:[0,0,0]},
      {id:'p2',time:2,position:[.2,0,0],rotation:[0,45,0]},
    ]},
  ]},
};
const original=canonicalJSON(makeManifest(workspace,true));
const rig = attachedPreset(workspace,item.id,'Tool camera','test:robot',null,'gripper');
const changed=configureAttachedRig(rig,{
  position:[0.04,.11,-.06], eulerDegrees:[-10,30,5], fovDegrees:55,
});
assert.equal(changed.fovDegrees,55);
assert.deepEqual(changed.binding.kind==='attachedPose' ? changed.binding.position : null,[.04,.11,-.06]);
const angles=attachedRigEulerDegrees(changed);
angles.forEach((v,i)=>assert.ok(Math.abs(v-[-10,30,5][i])<1e-7));
assert.throws(()=>configureAttachedRig(changed,{eulerDegrees:[Infinity,0,0]}),/finite/);
assert.throws(()=>configureAttachedRig(changed,{fovDegrees:200}),/Invalid POV/);
assert.equal(canonicalJSON(makeManifest(workspace,true)),original,'camera adjustments must not change scene geometry, animation, or revisions');

const world=createWorld(workspace.items.map(v=>v.asset),workspace.room);
const sample=(t:number)=>{
  const poses=evaluateWorkspace(workspace.items,workspace.animation,t);
  applyWorldPoses(world.groups,poses);
  return resolvePovCameraFrame(changed,workspace,world.groups,t);
};
const start=sample(0), middle=sample(1), end=sample(2);
assert.equal(start.parentInstanceId,item.id);
assert.equal(start.parentPartId,'gripper');
assert.equal(end.time,2);
assert.notDeepEqual(start.position,end.position,'parent motion must update camera translation');
assert.notDeepEqual(start.quaternion,end.quaternion,'parent and part rotation must update camera orientation');
assert.notDeepEqual(middle.position,end.position,'timeline midpoint must not jump to terminal pose');
const mount=world.groups[0].children[1];
mount.updateWorldMatrix(true,false);
const localBack=new THREE.Vector3(...end.position).applyMatrix4(mount.matrixWorld.clone().invert());
assert.ok(localBack.distanceTo(new THREE.Vector3(.04,.11,-.06))<1e-6,'world→part-local position must round-trip');
const expected=new THREE.Quaternion();
mount.getWorldQuaternion(expected);
expected.multiply(new THREE.Quaternion(...(changed.binding.quaternion)));
assert.ok(Math.abs(1-Math.abs(expected.dot(new THREE.Quaternion(...end.quaternion))))<1e-8,'orientation must follow full parent and part rotation');
world.groups[0].visible=false;
assert.throws(()=>resolvePovCameraFrame(changed,workspace,world.groups,2),/hidden or unavailable/);
world.dispose();

const replacement:Workspace={...workspace,items:[{...item,asset:{...robot,id:'new-model'}}]};
const staleWorld=createWorld([replacement.items[0].asset],workspace.room);
applyWorldPoses(staleWorld.groups,evaluateWorkspace(replacement.items,replacement.animation,0));
assert.throws(()=>resolvePovCameraFrame(changed,replacement,staleWorld.groups,0),/replaced or its asset version changed/);
staleWorld.dispose();
const missing:Workspace={...workspace,items:[]};
assert.throws(()=>resolvePovCameraFrame(changed,missing,[],0),/unbound/);
const wrongPart={...workspace,items:[{...item,asset:{...robot,parts:[robot.parts[0]]}}]};
const noPartWorld=createWorld([wrongPart.items[0].asset],wrongPart.room);
applyWorldPoses(noPartWorld.groups,evaluateWorkspace(wrongPart.items,wrongPart.animation,0));
assert.throws(()=>resolvePovCameraFrame(changed,wrongPart,noPartWorld.groups,0),/part binding is missing/);
noPartWorld.dispose();
console.log('PASS live attached camera: parent+part motion, offset quaternion, scene immutability, hidden, replacement, deleted and missing frame.');
