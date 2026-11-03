import assert from 'node:assert/strict';
import { choosePovSpawn, clampPovPosition, lookPov, stepPov, type PovAction } from '../src/lib/pov-camera';

const room = [8, 6, 3];
const origin = choosePovSpawn(room);
assert.equal(origin.verified, true);
assert.equal(origin.pose.position[1], 1.65);
assert.ok(origin.pose.position[2] > 0, 'default should face into the workspace');

const candidates: string[] = [];
const blocked = choosePovSpawn(room, position => {
  candidates.push(position.join(','));
  return candidates.length === 1;
});
assert.equal(blocked.verified, true);
assert.notDeepEqual(blocked.pose.position, origin.pose.position, 'blocked initial location must not be used');
assert.equal(choosePovSpawn(room, () => true).verified, false, 'uncertain fallback must be marked as such');

const pressed = (...items: PovAction[]): Set<PovAction> => new Set(items);
const forward = stepPov({ position: [0, 1.65, 0], yaw: 0, pitch: 0 }, pressed('forward'), .05, room);
assert.ok(forward.position[2] < 0, 'W moves forward down -Z');
const diagonal = stepPov({ position: [0, 1.65, 0], yaw: 0, pitch: 0 }, pressed('forward', 'right'), .05, room);
assert.ok(Math.abs(Math.hypot(diagonal.position[0], diagonal.position[2]) - .09) < 1e-9, 'diagonal speed is normalized');
const turned = stepPov({ position: [0, 1.65, 0], yaw: 0, pitch: 0 }, pressed('turnRight'), .05, room);
assert.ok(turned.yaw > 0, 'touch turn rotates clockwise');
const looked = lookPov(origin.pose, 4000, 4000);
assert.ok(Math.abs(looked.pitch) <= 1.48, 'look must not flip upside down');
assert.ok(Math.abs(looked.yaw) <= Math.PI, 'yaw is bounded');
assert.deepEqual(clampPovPosition([99, 99, -99], room), [3.82, 2.88, -2.82]);
const stopped = stepPov(forward, pressed(), .05, room);
assert.deepEqual(stopped.position, forward.position);
assert.equal(pressed().size, 0);
console.log('PASS POV spawn, blocked fallback, movement, diagonal normalization, yaw/pitch and room bounds.');
