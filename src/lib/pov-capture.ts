import * as THREE from 'three';
import type { CameraSession, Point3, PovPose } from './pov-camera';
import type { Workspace } from './workspace';

export type Quaternion4 = [number, number, number, number];
export type CameraBinding =
  | { kind: 'worldPose'; position: Point3; quaternion: Quaternion4 }
  | { kind: 'attachedPose'; instanceId: string; partId?: string; assetId?: string; sourceDigest?: string; cloudVersionId?: string; position: Point3; quaternion: Quaternion4 };
/** A portable, explicitly saved camera preset; not a measured camera observation. */
export type PovCameraPreset = {
  schemaVersion: 1; id: string; name: string; sceneKey: string; sceneRevision: number | null;
  savedAt: string; fovDegrees: number; clip: { nearMeters: number; farMeters: number }; binding: CameraBinding;
};
export type PovCameraFrame = {
  time: number; position: Point3; quaternion: Quaternion4; parentInstanceId?: string; parentPartId?: string;
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const point = (value: unknown): value is Point3 => Array.isArray(value) && value.length === 3 && value.every(v => finite(v) && Math.abs(v) <= 1e5);
const quaternion = (value: unknown): value is Quaternion4 =>
  Array.isArray(value) && value.length === 4 && value.every(finite)
  && Math.abs(value.reduce((sum: number, v: number) => sum + v * v, 0) - 1) <= 1e-3;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validRevision = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && Number(value) > 0);

/** Strictly validate external/local persisted presets before reuse or capture. */
export function validatePovPreset(input: unknown): PovCameraPreset {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid POV camera preset.');
  const preset = input as PovCameraPreset;
  const binding = preset.binding;
  if (preset.schemaVersion !== 1 || !validId(preset.id) || !validId(preset.sceneKey)
    || !validId(preset.name) || !validRevision(preset.sceneRevision)
    || typeof preset.savedAt !== 'string' || !Number.isFinite(Date.parse(preset.savedAt))
    || !finite(preset.fovDegrees) || preset.fovDegrees < 20 || preset.fovDegrees > 100
    || !preset.clip || !finite(preset.clip.nearMeters) || !finite(preset.clip.farMeters)
    || preset.clip.nearMeters < 0.005 || preset.clip.nearMeters > 1
    || preset.clip.farMeters <= preset.clip.nearMeters || preset.clip.farMeters > 1000
    || preset.clip.farMeters / preset.clip.nearMeters > 100_000
    || !binding || !point(binding.position) || !quaternion(binding.quaternion)
    || (binding.kind !== 'worldPose' && binding.kind !== 'attachedPose')
    || (binding.kind === 'attachedPose' && (!validId(binding.instanceId)
      || (binding.partId !== undefined && !validId(binding.partId))
      || (binding.assetId !== undefined && !validId(binding.assetId))
      || (binding.sourceDigest !== undefined && !validId(binding.sourceDigest))
      || (binding.cloudVersionId !== undefined && !validId(binding.cloudVersionId))))) {
    throw Error('Invalid POV camera preset or camera frame.');
  }
  return structuredClone(preset);
}

/** Use the identical YXZ rotation convention as the interactive #103 POV viewer. */
export function worldPresetFromSession(
  session: CameraSession, name: string, sceneKey: string, sceneRevision: number | null,
  room: readonly number[] = [6, 5, 3],
): PovCameraPreset {
  if (!session.pov) throw Error('Enter POV before saving the current camera.');
  const pose: PovPose = session.pov;
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.pitch, pose.yaw, 0, 'YXZ'));
  return validatePovPreset({
    schemaVersion: 1, id: crypto.randomUUID(), name: name.trim(), sceneKey, sceneRevision,
    savedAt: new Date().toISOString(), fovDegrees: 45,
    clip: {nearMeters: .02, farMeters: Math.max(12, Math.hypot(...room) * 2)},
    binding: { kind: 'worldPose', position: [...pose.position], quaternion: rotation.toArray() },
  });
}

/** Construct an explicit camera mount against a real instance, not an inferred frame. */
export function attachedPreset(
  workspace: Workspace, instanceId: string, name: string, sceneKey: string,
  sceneRevision: number | null, partId?: string,
): PovCameraPreset {
  const item = workspace.items.find(candidate => candidate.id === instanceId);
  if (!item || item.missing) throw Error('Selected camera parent has missing geometry.');
  if (partId && !item.asset.parts.some(part => part.id === partId)) throw Error('Selected camera part does not exist.');
  return validatePovPreset({
    schemaVersion: 1, id: crypto.randomUUID(), name: name.trim(), sceneKey, sceneRevision,
    savedAt: new Date().toISOString(), fovDegrees: 45,
    clip: {nearMeters: .02, farMeters: Math.max(12, Math.hypot(...workspace.room) * 2)},
    binding: { kind: 'attachedPose', instanceId, assetId:item.asset.id, sourceDigest:item.asset.source.digest,
      ...(item.cloudVersionId ? {cloudVersionId:item.cloudVersionId} : {}), ...(partId ? { partId } : {}),
      position: [0, 0.12, 0], quaternion: [0, 0, 0, 1] },
  });
}

/** Use the evaluated world and part matrix at this exact timeline frame. */
export function resolvePovCameraFrame(
  preset: PovCameraPreset, workspace: Pick<Workspace, 'items'>, groups: THREE.Group[], time: number,
): PovCameraFrame {
  const camera = validatePovPreset(preset);
  const b = camera.binding;
  if (b.kind === 'worldPose') return { time, position: [...b.position], quaternion: [...b.quaternion] };
  const index = workspace.items.findIndex(item => item.id === b.instanceId);
  if (index < 0 || workspace.items[index].missing) throw Error('POV camera parent is missing; view is unbound.');
  const item = workspace.items[index];
  if ((b.assetId !== undefined && item.asset.id !== b.assetId)
    || (b.sourceDigest !== undefined && item.asset.source.digest !== b.sourceDigest)
    || (b.cloudVersionId !== undefined && item.cloudVersionId !== b.cloudVersionId)) {
    throw Error('POV camera parent was replaced or its asset version changed; view is unbound.');
  }
  const group = groups[index];
  if (!group?.visible) throw Error('POV camera parent is hidden or unavailable at this frame.');
  const partIndex = b.partId === undefined ? -1 : workspace.items[index].asset.parts.findIndex(part => part.id === b.partId);
  if (b.partId && partIndex < 0) throw Error('POV camera part binding is missing; capture cancelled.');
  const mount = partIndex < 0 ? group : group.children[partIndex];
  if (!mount?.visible) throw Error('POV camera mount is hidden at this frame.');
  mount.updateWorldMatrix(true, false);
  const translation = new THREE.Vector3(...b.position).applyMatrix4(mount.matrixWorld);
  const rotation = new THREE.Quaternion(); mount.getWorldQuaternion(rotation);
  rotation.multiply(new THREE.Quaternion(...b.quaternion));
  return { time, position: translation.toArray() as Point3, quaternion: rotation.toArray() as Quaternion4,
    parentInstanceId: b.instanceId, ...(b.partId ? { parentPartId: b.partId } : {}) };
}

/** Local view records remain outside workspace revisions, scoped by scene and owner. */
export function loadPovPresets(storage: Pick<Storage, 'getItem'>, scope: string, sceneKey: string): PovCameraPreset[] {
  try {
    const raw = storage.getItem('oi-pov-presets-v1:' + scope);
    if (!raw) return [];
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 32) throw Error('Invalid saved camera list.');
    return values.map(validatePovPreset).filter(preset => preset.sceneKey === sceneKey);
  } catch { return []; }
}

/** Atomic-in-one-key local save: bounded count and explicit opt-in only. */
export function storePovPresets(storage: Pick<Storage, 'setItem'>, scope: string, presets: PovCameraPreset[]): void {
  if (presets.length > 32) throw Error('At most 32 POV presets can be saved per scene.');
  const selected = presets.map(validatePovPreset);
  storage.setItem('oi-pov-presets-v1:' + scope, JSON.stringify(selected));
}

/** Bound browser capture capacity, including repeated instances, before allocating GPU buffers. */
export function assertPovSceneBudget(workspace: Workspace): void {
  if (workspace.items.some(item => item.missing)) throw Error('POV capture refused: restore missing source geometry.');
  if (workspace.items.length > 128) throw Error('POV capture budget exceeded: maximum 128 instances in browser.');
  let vertices = 0, parts = 0;
  for (const item of workspace.items) for (const part of item.asset.parts) {
    parts++;
    vertices += part.vertices.length / 3;
    if (vertices > 300_000 || parts > 1024) throw Error('POV capture geometry budget exceeded (300k vertices / 1024 parts).');
  }
}

/** Return saved world camera to the yaw/pitch representation used by the viewer. */
export function interactivePoseFromPreset(preset: PovCameraPreset): PovPose {
  const valid = validatePovPreset(preset);
  if (valid.binding.kind !== 'worldPose') throw Error('Attached camera playback requires #104.');
  const q = new THREE.Quaternion(...valid.binding.quaternion);
  const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  if (Math.abs(euler.z) > 1e-4) throw Error('Camera roll cannot be represented by the current free POV viewer.');
  return { position: [...valid.binding.position], yaw: euler.y, pitch: euler.x };
}

/** Change the declared mount transform, never an object's authored scene pose. */
export function configureAttachedRig(
  preset: PovCameraPreset,
  options: { position?: Point3; eulerDegrees?: Point3; fovDegrees?: number },
): PovCameraPreset {
  const valid = validatePovPreset(preset);
  if (valid.binding.kind !== 'attachedPose') throw Error('An attached camera binding is required.');
  const angle = options.eulerDegrees;
  if (angle && (!point(angle) || angle.some(v => Math.abs(v) > 360))) {
    throw Error('Camera mount angles must be finite degrees between -360 and 360.');
  }
  const rotation = angle ? new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...angle.map(THREE.MathUtils.degToRad) as Point3, 'YXZ'),
  ).toArray() as Quaternion4 : valid.binding.quaternion;
  return validatePovPreset({
    ...valid, fovDegrees: options.fovDegrees ?? valid.fovDegrees,
    binding: {
      ...valid.binding, position: options.position ?? valid.binding.position,
      quaternion: rotation,
    },
  });
}

/** Read a rig's parent-relative rotation using YXZ, in degrees. */
export function attachedRigEulerDegrees(preset: PovCameraPreset): Point3 {
  const valid = validatePovPreset(preset);
  if (valid.binding.kind !== 'attachedPose') throw Error('Camera is not attached.');
  const q = new THREE.Quaternion(...valid.binding.quaternion);
  const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return [euler.x,euler.y,euler.z].map(THREE.MathUtils.radToDeg) as Point3;
}
