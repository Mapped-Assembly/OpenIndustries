import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectSystem, meshFingerprint, readSystemInspection } from '../src/lib/system-inspection.ts';
import { hydrateManifest, readManifest, makeManifest, sceneContent } from '../src/lib/workspace.ts';
import { inspectorFixture } from './system-inspector-fixture.ts';

const original = await inspectorFixture();
const originalJSON = JSON.stringify(original);
const report = await inspectSystem(original);
assert.deepEqual(report.map(r => r.status), ['resolved', 'resolved', 'resolved']);
assert.deepEqual(report.map(r => r.targets), [[{ instance: 0, part: 0 }], [{ instance: 0, part: 1 }], [{ instance: 0, part: 2 }]]);
assert.equal(JSON.stringify(original), originalJSON, 'inspection never mutates the scene');
const copy = () => structuredClone(original);
const status = async (w: typeof original) => (await inspectSystem(w))[1].status;

// Portable save/reopen, current source identity and authored notes all survive.
const reopened = hydrateManifest(readManifest(JSON.parse(JSON.stringify(makeManifest(original, true)))), []);
assert.deepEqual(reopened.inspection, original.inspection);
assert.deepEqual(await inspectSystem(reopened), report);
assert.deepEqual(sceneContent(makeManifest(original)).inspection, original.inspection);
assert.deepEqual(readManifest(JSON.parse(await readFile('public/examples/system-inspector.oi.json', 'utf8'))).inspection, original.inspection);

const renamed = copy(); renamed.items[0].name = 'New display name'; renamed.items[0].asset.parts[1].name = 'Renamed pump';
renamed.items[0].position = [2, 0, 1]; renamed.items[0].rotation = [0, 90, 0];
assert.equal(await status(renamed), 'resolved', 'labels and world placement do not rebind semantic identities');
const repeated = copy(); repeated.items.unshift({ ...structuredClone(repeated.items[0]), id: 'station-02' });
assert.deepEqual((await inspectSystem(repeated))[1].targets, [{ instance: 1, part: 1 }], 'repeated shared assets resolve by instance ID');
const changedSource = copy(); changedSource.items[0].asset.source.digest = 'b'.repeat(64);
assert.equal(await status(changedSource), 'stale');
const changedMesh = copy(); changedMesh.items[0].asset.parts[1].vertices[0] += .1;
assert.equal(await status(changedMesh), 'stale', 'source label alone cannot hide edited geometry');
const missing = copy(); missing.items = [];
assert.equal(await status(missing), 'unresolved');
const hidden = copy(); hidden.items[0].visible = false;
assert.equal(await status(hidden), 'unresolved');
const wrongPart = copy(); wrongPart.inspection!.systems[0].targets[1].partId = 'missing-part';
assert.equal(await status(wrongPart), 'unresolved');
const wrongArtifact = copy(); wrongArtifact.inspection!.systems[0].manifest.geometry.sha256 = 'b'.repeat(64);
assert.equal(await status(wrongArtifact), 'stale');
const ambiguous = copy(); ambiguous.inspection!.systems[0].manifest.entities.push({ ...ambiguous.inspection!.systems[0].manifest.entities[1], entity_id: 'duplicate-selector' });
assert.equal(await status(ambiguous), 'ambiguous');
const face = copy(); face.inspection!.systems[0].manifest.bindings[1].role = 'mounting_face';
assert.equal(await status(face), 'unsupported');
const unmapped = copy(); unmapped.inspection!.systems[0].targets = [];
assert.equal(await status(unmapped), 'unresolved');
for (const declared of ['stale', 'unsupported', 'unresolved', 'ambiguous', 'not_applicable'] as const) {
  const w = copy(); const b = w.inspection!.systems[0].manifest.bindings[1]; b.resolution = declared;
  if (declared === 'not_applicable') b.selector = null;
  assert.equal(await status(w), declared, 'source diagnostics are never promoted to resolved');
}
const duplicates = copy(); duplicates.inspection!.systems[0].manifest.bindings.push(duplicates.inspection!.systems[0].manifest.bindings[0]);
assert.throws(() => readSystemInspection(duplicates.inspection), /Duplicate binding/);
const broken = copy(); broken.inspection!.systems[0].targets[0].bindingId = 'missing';
assert.throws(() => readSystemInspection(broken.inspection), /unknown binding/);
assert.throws(() => readSystemInspection({ format: 'oi.system-inspection', version: 99, systems: [] }), /Invalid/);
assert.throws(() => readManifest({ ...makeManifest(original), inspection: { surprise: true } }), /Invalid/);
assert.equal(makeManifest({ ...original, inspection: undefined }).inspection, undefined, 'old scenes remain extension-free');
assert.equal((await meshFingerprint(original.items[0].asset)).length, 64);
console.log('PASS system inspector: source/mesh pins, repeated instances, reverse selection, roundtrip, unknown/stale/ambiguous/unsupported and invalid inputs.');
