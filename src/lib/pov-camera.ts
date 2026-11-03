/** Stable, meter-valued first-person camera state; independent of scene mutations. */
export type Point3 = [number, number, number];

/** Session-only camera bookmarks, deliberately excluded from scene serialization. */
export type CameraSession = {
  orbit?: { position: Point3; target: Point3 };
  pov?: PovPose;
};

/** Y-up viewpoint; zero yaw looks toward negative world Z. */
export type PovPose = { position: Point3; yaw: number; pitch: number };

export type PovAction = 'forward' | 'backward' | 'left' | 'right' | 'turnLeft' | 'turnRight' | 'sprint';

const WALK_SPEED = 1.8;
const TURN_SPEED = 1.65;
const EDGE_MARGIN = 0.18;

/** Clamp the viewer inside the declared room envelope; does not assert collision clearance. */
export function clampPovPosition(position: Point3, room: readonly number[]): Point3 {
  const halfWidth = Math.max(0, room[0] / 2 - EDGE_MARGIN);
  const halfDepth = Math.max(0, room[1] / 2 - EDGE_MARGIN);
  const ceiling = Math.max(0.2, room[2] - 0.12);
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
  return [
    clamp(position[0], -halfWidth, halfWidth),
    clamp(position[1], Math.min(0.2, ceiling), ceiling),
    clamp(position[2], -halfDepth, halfDepth),
  ];
}

/**
 * Search a bounded set of candidate spawn points against available geometry.
 * If no candidate is clear, the result is explicitly uncertain; never claim safety.
 */
export function choosePovSpawn(
  room: readonly number[],
  blocked: (point: Point3) => boolean = () => false,
): { pose: PovPose; verified: boolean } {
  const eye = Math.min(1.65, Math.max(0.2, room[2] - 0.15));
  const xs = [0, -0.25, 0.25, -0.4, 0.4];
  const zs = [0.25, 0, -0.25, 0.4, -0.4];
  const fallback: Point3 = clampPovPosition([0, eye, room[1] * 0.25], room);
  for (const z of zs) for (const x of xs) {
    const candidate = clampPovPosition([room[0] * x, eye, room[1] * z], room);
    if (!blocked(candidate)) return { pose: { position: candidate, yaw: 0, pitch: 0 }, verified: true };
  }
  return { pose: { position: fallback, yaw: 0, pitch: 0 }, verified: false };
}

/** Rotate the first-person view using pointer displacement in CSS pixels. */
export function lookPov(pose: PovPose, dx: number, dy: number): PovPose {
  const sensitivity = 0.0024;
  const yaw = Math.atan2(Math.sin(pose.yaw - dx * sensitivity), Math.cos(pose.yaw - dx * sensitivity));
  const pitch = Math.max(-1.48, Math.min(1.48, pose.pitch - dy * sensitivity));
  return { ...pose, yaw, pitch };
}

/**
 * Advance camera-only navigation with a bounded delta; diagonal motion is normalized.
 * Keyboard and touch actions use the same deterministic integration path.
 */
export function stepPov(pose: PovPose, actions: ReadonlySet<PovAction>, seconds: number, room: readonly number[]): PovPose {
  const dt = Math.max(0, Math.min(seconds, 0.05));
  const turn = Number(actions.has('turnRight')) - Number(actions.has('turnLeft'));
  const yawRaw = pose.yaw + turn * TURN_SPEED * dt;
  const yaw = Math.atan2(Math.sin(yawRaw), Math.cos(yawRaw));
  const forward = Number(actions.has('forward')) - Number(actions.has('backward'));
  const right = Number(actions.has('right')) - Number(actions.has('left'));
  const length = Math.hypot(forward, right);
  if (!length || !dt) return { ...pose, yaw };
  const distance = WALK_SPEED * (actions.has('sprint') ? 2 : 1) * dt / length;
  const dx = (forward * Math.sin(yaw) + right * Math.cos(yaw)) * distance;
  const dz = (-forward * Math.cos(yaw) + right * Math.sin(yaw)) * distance;
  return {
    ...pose,
    yaw,
    position: clampPovPosition([pose.position[0] + dx, pose.position[1], pose.position[2] + dz], room),
  };
}
