import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseRenderProfile,pixelRatioForProfile } from '../src/lib/render-profile';
import { readManifest,hydrateManifest,makeManifest,evaluateWorkspace,canonicalJSON } from '../src/lib/workspace';
import { applyWorldPoses,createWorld } from '../src/lib/world';
import { normalize,RenderError } from '../server/render/contract';

const fixture=JSON.parse(readFileSync('benchmarks/kitchen-lite/79-instance-synthetic.oi.json','utf8'));
const manifest=readManifest(fixture);
const workspace=hydrateManifest(manifest,[]);
assert.equal(workspace.items.length,79);
assert.equal(new Set(workspace.items.map(item=>item.asset.id)).size,60);
assert.equal(new Set(manifest.assets.map(asset=>asset.id)).size,60);
assert.equal(workspace.items.filter(item=>item.missing).length,0);
const original=canonicalJSON(makeManifest(workspace,true));
const world=createWorld(workspace.items.map(item=>item.asset),workspace.room,-1,-1,undefined,'lite');
const lite=world.resourceStats();
assert.deepEqual({instances:lite.instances,meshes:lite.meshes,geometries:lite.geometries},{instances:79,meshes:79,geometries:60});
assert.equal(lite.materials,79,'per-instance material ownership preserves independent selection');
assert.ok(world.groups[0].children[0].material instanceof THREE.MeshLambertMaterial);
assert.strictEqual(world.groups[0].children[0].geometry,world.groups[60].children[0].geometry,'identical asset mesh reuses the exact BufferGeometry');
assert.notStrictEqual(world.groups[0],world.groups[60],'instances remain independent groups');
const first=world.groups[0].children[0] as THREE.Mesh;
const other=world.groups[60].children[0] as THREE.Mesh;
const geometry=first.geometry,material=first.material;
(first.material as THREE.MeshLambertMaterial).emissive.setHex(0x314622);
assert.equal((other.material as THREE.MeshLambertMaterial).emissive.getHex(),0,'individual highlighting cannot bleed to another instance');
world.setProfile('detailed');
assert.strictEqual(first.geometry,geometry);
assert.strictEqual(first,world.groups[0].children[0]);
assert.notStrictEqual(first.material,material);
assert.ok(first.material instanceof THREE.MeshStandardMaterial);
assert.equal((first.material as THREE.MeshStandardMaterial).emissive.getHex(),0x314622,'selection highlight must survive profile toggle');
world.setProfile('lite');
assert.strictEqual(first.geometry,geometry);
assert.ok(first.material instanceof THREE.MeshLambertMaterial);
const poses=evaluateWorkspace(workspace.items,workspace.animation,null);
applyWorldPoses(world.groups,poses);
assert.equal(world.groups[0].position.x,workspace.items[0].position[0]);
assert.equal(world.groups[60].position.x,workspace.items[60].position[0]);
world.groups[0].visible=false;
assert.equal(world.groups[60].visible,true,'visibility independent after GPU reuse');
world.dispose();
assert.equal(canonicalJSON(makeManifest(workspace,true)),original,'render profiles must never mutate scene sources');

assert.equal(parseRenderProfile('lite'),'lite');
assert.equal(parseRenderProfile('detailed'),'detailed');
assert.throws(()=>parseRenderProfile('ultra'),/Unsupported/);
assert.equal(pixelRatioForProfile('lite',3),1);
assert.equal(pixelRatioForProfile('detailed',3),2);
assert.equal(pixelRatioForProfile('lite',0),1);
const req={request_id:'a9cf7d8d-0123-4444-8444-000000000097',scene:fixture,
  options:{scope:'room' as const,assetIndex:0,region:{x:0,z:0,width:18,depth:12},motion:'turntable' as const,
    size:320,duration:2,fps:10,profile:'lite' as const}};
assert.throws(()=>normalize(req,fixture),(error:unknown)=>
  error instanceof RenderError && error.code==='GEOMETRY_LIMIT' && /64 instances/.test(error.message) && /79/.test(error.message));
const reduced={...fixture,instances:fixture.instances.slice(0,60)};
const normalized=normalize({...req,scene:reduced},reduced);
assert.equal(normalized.options.profile,'lite');
assert.equal(normalized.scene.instances.length,60);
assert.throws(()=>normalize({...req,scene:reduced,options:{...req.options,profile:'fake' as 'lite'}},reduced),
  (error:unknown)=>error instanceof RenderError && error.code==='INVALID_PROFILE');

console.log('PASS #97: 60 immutable geometries / 79 independent instances, shader toggles, selection/visibility, scene immutability and bounded backend rejection.');
