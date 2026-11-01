/** Verify generated cabinet geometry provenance through OI's existing portable/local storage. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runWorkspace, type RunSnapshot } from '../src/lib/embodied-scene';
import { makeManifest, readManifest, hydrateManifest, assertSourceMatches } from '../src/lib/workspace';
import { parseCloudBundle } from '../src/lib/cloud-storage';
import { LocalSceneBackend } from '../server/local-scene-backend';

const directory=await mkdtemp(join(tmpdir(),'oi-cabinet-scene-'));
try {
  for(const fixture of ['joint','packaged']) {
    const cabinet=JSON.parse(await readFile(`benchmarks/cabinet/${fixture}.json`,'utf8'));
    cabinet.sha256=createHash('sha256').update(JSON.stringify(cabinet)).digest('hex');
    const run={run_id:'synthetic-test-only',scene_id:cabinet.id,scene_revision:1,revision:0,mode:'edit',policy_mode:'manual',healthy:true,skills:[],objects:cabinet.objects,
      destination:{id:'unused',position_m:[0,0,0],size_m:[1,1,1]},robot:{frames:{},tcp_m:[0,0,0],model_sha256:cabinet.model_sha256},task:null,messages:[],observations:[],cabinet} as RunSnapshot;
    const workspace=runWorkspace(run,{});
    const roundTrip=hydrateManifest(readManifest(JSON.parse(JSON.stringify(makeManifest(workspace,true)))),[]);
    assert.equal(JSON.stringify(makeManifest(roundTrip,true)),JSON.stringify(makeManifest(workspace,true)));
    const restoredFixture=JSON.parse(roundTrip.items[0].asset.parts[0].metadata.fixture_contract);
    assert.deepEqual(restoredFixture.target_assembly,cabinet.target_assembly);
    assert.deepEqual(restoredFixture.connections,cabinet.connections);
    assert.deepEqual(restoredFixture.inventory,cabinet.inventory);
    assert.deepEqual(restoredFixture.units,cabinet.units);
    const backend=new LocalSceneBackend(join(directory,fixture));
    try {
      for(const item of workspace.items) {
        assert.equal(item.asset.source.kind,'generated');assert.equal(item.asset.source.generator,'oi-fixture');
        const id=await backend.persistAsset(item.asset),version=await backend.asset(id);assert(version);
        const restored=parseCloudBundle(await backend.geometry(version)).asset;
        assert.deepEqual(restored.source,item.asset.source);
        assert.deepEqual(JSON.parse(JSON.stringify(restored.parts)),JSON.parse(JSON.stringify(item.asset.parts)));
        assert.equal(JSON.parse(restored.parts[0].metadata.component_contract).id,item.id);
        const bad=structuredClone(restored);(bad.source as {generator:string}).generator='unregistered';
        assert.throws(()=>parseCloudBundle(JSON.stringify({schemaVersion:1,asset:bad})));
        const swapped=structuredClone(restored);if(swapped.source.kind==='generated')swapped.source.generator='opencad-robot';
        assert.throws(()=>assertSourceMatches(item.asset,swapped));
      }
    } finally {await backend.close();}
  }
  console.log('PASS both cabinet fixtures through OI portable scene and immutable local asset storage, including provenance rejection');
} finally {await rm(directory,{recursive:true,force:true});}
