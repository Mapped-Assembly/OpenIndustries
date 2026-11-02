import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SPACE_IR_PROVIDER, accessibleRegions, canonicalSpaceJSON, parseSpaceIR,
  polygonValid, resolveMetricPoint, validateSpaceIR, type SpaceIR,
} from '../packages/space-ir/src/index';
import { compileSpaceIR, SpaceCompilationError } from '../src/lib/space-ir-compiler';
import { hydrateManifest, makeManifest, readManifest } from '../src/lib/workspace';
import { planContains, projectWorkspacePlan } from '../src/lib/plan-projection';

const fixture = JSON.parse(readFileSync(new URL('../packages/space-ir/fixtures/SPACE-001.json', import.meta.url), 'utf-8')) as SpaceIR;
const copy = <T>(v: T): T => structuredClone(v);
const errorCodes = (s: unknown) => validateSpaceIR(s).findings.filter(f => f.severity === 'error').map(f => f.code);
assert.equal(SPACE_IR_PROVIDER.domain, 'space');
assert.equal(SPACE_IR_PROVIDER.provider, 'openindustries');
assert.equal(validateSpaceIR(fixture).valid, true);
assert.deepEqual(accessibleRegions(fixture, 'room-a'), ['room-a', 'room-b']);
assert.equal(canonicalSpaceJSON(fixture), canonicalSpaceJSON(parseSpaceIR(JSON.parse(canonicalSpaceJSON(fixture)))));
const reordered = Object.fromEntries(Object.entries(fixture).reverse());
assert.equal(canonicalSpaceJSON(reordered), canonicalSpaceJSON(fixture));

const windowOnly = copy(fixture);
windowOnly.portals[0].kind = 'window';
windowOnly.portals[0].traversable = false;
windowOnly.relations = windowOnly.relations.filter(r => r.kind !== 'connected');
assert.equal(validateSpaceIR(windowOnly).valid, true);
assert.deepEqual(accessibleRegions(windowOnly, 'room-a'), ['room-a']);

function fail(modify: (s: SpaceIR) => void, code: string): void {
  const broken = copy(fixture);
  modify(broken);
  assert(errorCodes(broken).includes(code), code + ': ' + JSON.stringify(validateSpaceIR(broken).findings));
}
fail(s => { s.regions[0].id = s.regions[1].id; }, 'DUPLICATE_ID');
fail(s => { s.portals[0].boundary_id = 'nonexistent'; }, 'DANGLING_REFERENCE');
fail(s => { s.regions[0].parent_id = 'room-b'; s.regions[1].parent_id = 'room-a'; }, 'PARENT_CYCLE');
fail(s => { s.regions[0].polygon = [[-3,-3], [0,0], [-3,0], [0,-3]]; }, 'POLYGON');
fail(s => { s.frames[0].units = 'px'; }, 'FRAME');
fail(s => { s.boundaries[0].frame_id = 'no-frame'; }, 'DANGLING_REFERENCE');
fail(s => { s.portals[0].span = [-0.5, .3]; }, 'PORTAL_SPAN');
fail(s => { s.portals[0].kind = 'window'; }, 'PORTAL_SEMANTICS');
fail(s => { s.relations[1].via_portal_id = 'no-portal'; }, 'DANGLING_REFERENCE');
fail(s => { s.evidence[0].digest_sha256 = 'f00'; }, 'EVIDENCE');
fail(s => { s.regions[0].evidence_ids = ['missing']; }, 'DANGLING_REFERENCE');
fail(s => { s.frames.push({ id:'image', units:'px', axes:'image_xy', to_world:[1,2,2,4,0,0] }); }, 'TRANSFORM');
assert.equal(polygonValid([[0,0],[3,0],[3,2],[0,2]]), true);
assert.equal(polygonValid([[0,0],[3,3],[0,3],[3,0]]), false);

// Pixel-only observations are valid partial SpaceIR, but cannot be compiled in meters.
const pixel = copy(fixture);
pixel.frames = [{ id:'image', units:'px', axes:'image_xy' }];
pixel.site = null;
for (const region of pixel.regions) {
  region.frame_id = 'image';
  region.polygon = region.polygon?.map(p => [p[0] * 100, p[1] * 100]) ?? null;
}
for (const boundary of pixel.boundaries) {
  boundary.frame_id = 'image';
  boundary.path = boundary.path?.map(p => [p[0] * 100, p[1] * 100]) as [number[], number[]] as [typeof boundary.path[0], typeof boundary.path[1]] ?? null;
}
assert.equal(validateSpaceIR(pixel).valid, true);
assert(validateSpaceIR(pixel).findings.some(f => f.code === 'UNSCALED'));
assert.deepEqual(resolveMetricPoint(pixel.frames[0], [100,100]), null);
await assert.rejects(() => compileSpaceIR(pixel), (err: unknown) => err instanceof SpaceCompilationError && err.code === 'UNSCALED_SITE');
pixel.frames[0].to_world = [.01,0,0,.01,0,0];
pixel.site = { frame_id:'image',width_m:8,depth_m:6,height_m:3 };
assert.deepEqual(resolveMetricPoint(pixel.frames[0], [100, 200]), [1, 2]);

const original = canonicalSpaceJSON(fixture);
const compiled = await compileSpaceIR(fixture);
const calibrated = await compileSpaceIR(pixel);
assert.equal(canonicalSpaceJSON(fixture), original, 'Compiler must not mutate input SpaceIR.');
assert.equal(compiled.workspace.room[0], 8);
assert.equal(compiled.workspace.room[1], 6);
assert.equal(compiled.workspace.items.length, 8, 'Seven boundaries, one doorway split into two segments.');
assert.equal(compiled.bindings.length, 8);
assert.equal(compiled.bindings.filter(b => b.entity_id === 'shared').length, 2);
assert.equal(calibrated.workspace.items.length, compiled.workspace.items.length);
assert.deepEqual(calibrated.workspace.items.map(i => i.position), compiled.workspace.items.map(i => i.position));
assert.equal(compiled.source_sha256.length, 64);
assert(compiled.diagnostics.some(d => d.code === 'OPENING_ONLY'));
assert.deepEqual(compiled.workspace.items.map(i => i.id), (await compileSpaceIR(fixture)).workspace.items.map(i => i.id));

const project = projectWorkspacePlan(compiled.workspace);
assert.equal(project.footprints.length, 8);
const gap = project.footprints.filter(f => f.instanceId.includes(':shared:'));
assert.equal(gap.length, 2);
assert(gap.every(f => !planContains([0,0], f.points)), 'Portal must have a real gap in the wall geometry.');
const portable = readManifest(makeManifest(compiled.workspace, true));
const reopened = hydrateManifest(portable, []);
assert(reopened.items.every(item => !item.missing));
assert.deepEqual(reopened.items.map(i => i.id), compiled.workspace.items.map(i => i.id));
assert.deepEqual(projectWorkspacePlan(reopened).footprints.map(p => p.instanceId), project.footprints.map(p => p.instanceId));
assert.deepEqual(reopened.items.map(i => i.asset.source.digest), compiled.workspace.items.map(i => i.asset.source.digest));

const partial = copy(fixture);
partial.boundaries[0].path = null;
partial.regions[0].polygon = null;
partial.unresolved = ['west.path', 'room-a.polygon'];
assert.equal(validateSpaceIR(partial).valid, true);
const partialResult = await compileSpaceIR(partial);
assert.equal(partialResult.workspace.items.length, 7);
assert(partialResult.diagnostics.some(d => d.code === 'UNKNOWN_BOUNDARY_GEOMETRY'));
assert(partialResult.diagnostics.some(d => d.code === 'UNKNOWN_REGION_GEOMETRY'));
const badPortal = copy(fixture);
badPortal.portals.push({ ...badPortal.portals[0], id:'overlap', span:[.5,.65] });
await assert.rejects(() => compileSpaceIR(badPortal), (err: unknown) => err instanceof SpaceCompilationError && err.code === 'OVERLAPPING_PORTALS');

console.log('PASS SPACE-001: topology, unknown scale, invalid inputs, calibrated compile, door gap, portable 2D/3D scene');
