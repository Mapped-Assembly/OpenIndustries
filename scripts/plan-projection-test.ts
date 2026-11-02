import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { finalizeAsset } from '../src/lib/scene';
import { planContains, planHull, projectWorkspacePlan, snapPlan } from '../src/lib/plan-projection';
import { evaluateWorkspace, makeManifest, readManifest, hydrateManifest, writeKeyframe, type Workspace } from '../src/lib/workspace';

const box = new BoxGeometry(1, 2, 3);
const asset = finalizeAsset({
  id: 'test-equipment', name: 'Test bench',
  source: { kind: 'generated', generator: 'oi-fixture', filename: 'plan-test', digest: 'plan-1' },
  parts: [{ id: 'main', name: 'Main enclosure', vertices: Array.from(box.attributes.position.array),
    indices: Array.from(box.index!.array), metadata: {} }],
  hierarchy: { id: 'root', name: 'Test bench', partIds: ['main'], children: [] },
  warnings: [],
});
box.dispose();

const base: Workspace = {
  room: [10, 8, 4],
  items: [
    { id: 'test-1', name: 'Bench A', asset, visible: true, position: [2, 0, -1], rotation: [0, 0, 0] },
    { id: 'test-2', name: 'Bench B', asset, visible: true, position: [-3, 0, 2], rotation: [0, 90, 0] },
    { id: 'hidden', name: 'Hidden', asset, visible: false, position: [0, 0, 0], rotation: [0, 0, 0] },
  ],
  animation: { duration: 3, loop: false, tracks: [] },
};
const original = JSON.stringify(base);
const result = projectWorkspacePlan(base);
assert.deepEqual(result.room, { width: 10, depth: 8, height: 4 });
assert.equal(result.visibleCount, 2);
assert.deepEqual(result.footprints.map(p => p.instanceId), ['test-1', 'test-2']);
const width = (points: readonly (readonly [number, number])[]) => Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
const depth = (points: readonly (readonly [number, number])[]) => Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
assert(Math.abs(width(result.footprints[0].points) - 1) < 1e-8);
assert(Math.abs(depth(result.footprints[0].points) - 3) < 1e-8);
assert(Math.abs(width(result.footprints[1].points) - 3) < 1e-8);
assert(Math.abs(depth(result.footprints[1].points) - 1) < 1e-8);
assert(planContains([2, -1], result.footprints[0].points));
assert(!planContains([9, 9], result.footprints[0].points));
assert.equal(JSON.stringify(base), original, 'Projection must not mutate authoritative scene data.');

const animated: Workspace = {
  ...base, animation: writeKeyframe(writeKeyframe(base.animation, 'test-1', undefined, {
    id: 'start', time: 0, position: [2, 0, -1], rotation: [0, 0, 0],
  }), 'test-1', undefined, {
    id: 'end', time: 2, position: [4, 0, 1], rotation: [0, 90, 0],
  }),
};
const pose = evaluateWorkspace(animated.items, animated.animation, 2);
const projected = projectWorkspacePlan(animated, 2);
assert(Math.abs(width(projected.footprints[0].points) - 3) < 1e-8);
assert(planContains([pose[0].position[0], pose[0].position[2]], projected.footprints[0].points));
assert.equal(animated.items[0].position[0], 2, 'Animated time must not rewrite the base transform.');

const missing: Workspace = { ...base, items: [{ ...base.items[0], missing: true }] };
assert.equal(projectWorkspacePlan(missing).footprints[0].missing, true);
assert.equal(projectWorkspacePlan(missing).footprints[0].points.length, 4);

const huge: Workspace = { ...base, items: Array.from({ length: 79 }, (_, i) => ({
  ...base.items[0], id: 'kitchen-' + i, position: [i % 10 - 5, 0, Math.floor(i / 10) - 4] as [number, number, number],
})) };
assert.equal(projectWorkspacePlan(huge).footprints.length, 79, 'Reused asset identities must not merge placed instances.');
const persisted = hydrateManifest(readManifest(makeManifest(huge, true)), []);
assert.deepEqual(projectWorkspacePlan(persisted).footprints.map(p => p.instanceId),
  projectWorkspacePlan(huge).footprints.map(p => p.instanceId), 'Portable scene round trip retains plan identities.');

assert.deepEqual(planHull([[0, 0], [1, 0], [1, 1], [0, 1], [.5, .5], [0, 0]]),
  [[0, 0], [1, 0], [1, 1], [0, 1]]);
assert.equal(snapPlan(.26), .3);
assert.equal(snapPlan(-.26), -.3);
assert.throws(() => snapPlan(1, 0), /Invalid plan snap/);
console.log('PASS native 2D plan metric projection, selection geometry, animation, missing assets, and round trip');
