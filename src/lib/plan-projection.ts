import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { Part, Vec3 } from './scene';
import { evaluateWorkspace, type Workspace } from './workspace';

/** Metric X/Z coordinate in the horizontal, Y-up OpenIndustries world. */
export type PlanPoint = readonly [number, number];
export type PlanFootprint = {
  instanceId: string;
  instanceIndex: number;
  name: string;
  points: PlanPoint[];
  missing: boolean;
  /** A footprint is a conservative envelope of actual geometry, not a certified clearance polygon. */
  approximate: boolean;
};
export type PlanProjection = {
  room: { width: number; depth: number; height: number };
  footprints: PlanFootprint[];
  visibleCount: number;
};

type Bounds = { min: Vector3; max: Vector3 };
const boundsCache = new WeakMap<Part, Bounds>();

/** Cache immutable part bounds; do not recalculate large CAD meshes every animation frame. */
function partBounds(part: Part): Bounds | null {
  const saved = boundsCache.get(part);
  if (saved) return saved;
  if (part.vertices.length < 3) return null;
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i + 2 < part.vertices.length; i += 3) {
    const x = part.vertices[i], y = part.vertices[i + 1], z = part.vertices[i + 2];
    if (![x, y, z].every(Number.isFinite)) return null;
    min.min(new Vector3(x, y, z));
    max.max(new Vector3(x, y, z));
  }
  const result = { min, max };
  boundsCache.set(part, result);
  return result;
}

/** Monotone chain convex hull; input is metric X/Z, output has stable winding. */
export function planHull(points: readonly PlanPoint[]): PlanPoint[] {
  const sorted = [...new Map(points.map(p => [p[0] + ',' + p[1], p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const cross = (a: PlanPoint, b: PlanPoint, c: PlanPoint) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const lower: PlanPoint[] = [], upper: PlanPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function corners(min: Vector3, max: Vector3): Vector3[] {
  const result: Vector3[] = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) result.push(new Vector3(x, y, z));
  return result;
}

function rotation(angles: Vec3): Quaternion {
  return new Quaternion().setFromEuler(new Euler(
    MathUtils.degToRad(angles[0]),
    MathUtils.degToRad(angles[1]),
    MathUtils.degToRad(angles[2]),
    'XYZ',
  ));
}

/**
 * Project existing, evaluated asset poses into a conservative X/Z footprint.
 *
 * Parts are transformed using the same pivot convention as applyWorldPoses.
 * This intentionally uses a convex envelope of per-part 3D bounding boxes:
 * no inferred walls, passages, zones, scale, accessibility or clearance.
 * Missing geometry uses the declared asset dimensions and remains flagged.
 */
export function projectWorkspacePlan(workspace: Workspace, time: number | null = null): PlanProjection {
  const poses = evaluateWorkspace(workspace.items, workspace.animation, time);
  const footprints: PlanFootprint[] = [];
  let visibleCount = 0;
  for (const [index, item] of workspace.items.entries()) {
    const pose = poses[index];
    if (!pose.visible) continue;
    visibleCount++;
    const instanceRotation = rotation(pose.rotation);
    const origin = new Vector3(...pose.position);
    const points: PlanPoint[] = [];
    const parts = item.missing ? [] : item.asset.parts;
    for (const part of parts) {
      const bounds = partBounds(part);
      if (!bounds) continue;
      const center = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
      const partPose = pose.parts[part.id];
      const partRotation = partPose ? rotation(partPose.rotation) : null;
      for (const corner of corners(bounds.min, bounds.max)) {
        if (partPose && partRotation) {
          corner.sub(center).applyQuaternion(partRotation).add(center).add(new Vector3(...partPose.position));
        }
        corner.applyQuaternion(instanceRotation).add(origin);
        points.push([corner.x, corner.z]);
      }
    }
    if (points.length === 0) {
      const [x, y, z] = item.asset.dimensions;
      for (const corner of corners(new Vector3(-x / 2, 0, -z / 2), new Vector3(x / 2, y, z / 2))) {
        corner.applyQuaternion(instanceRotation).add(origin);
        points.push([corner.x, corner.z]);
      }
    }
    const hull = planHull(points);
    // Zero-area geometry is still selectable; do not falsely imply nonzero physical clearance.
    if (hull.length < 3) {
      const x = pose.position[0], z = pose.position[2], r = 0.025;
      hull.push([x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]);
      approximate = true;
    }
    footprints.push({
      instanceId: item.id, instanceIndex: index, name: item.name,
      points: hull, missing: !!item.missing || !parts.length, approximate: true,
    });
  }
  return {
    room: { width: workspace.room[0], depth: workspace.room[1], height: workspace.room[2] },
    footprints, visibleCount,
  };
}

/** Geometric point-in-polygon for plan hit testing and integration tests. */
export function planContains(point: PlanPoint, polygon: readonly PlanPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Explicit metric snap for editor moves, without changing Y or rotation. */
export function snapPlan(value: number, step = 0.1): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) throw new Error('Invalid plan snap.');
  return Number((Math.round(value / step) * step).toFixed(10));
}
