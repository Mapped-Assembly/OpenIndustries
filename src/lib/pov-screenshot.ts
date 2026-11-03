import * as THREE from 'three';
import { applyWorldPoses, createWorld } from './world';
import { evaluateWorkspace, type Workspace } from './workspace';
import { captureSceneHash, povEvidence, type PovEvidence } from './gif';
import { assertPovSceneBudget, resolvePovCameraFrame, validatePovPreset, type PovCameraPreset } from './pov-capture';

/** Still image and signed-by-source (not cryptographically signed) review metadata. */
export type PovScreenshotResult = {
  blob: Blob; filename: string;
  metadata: PovEvidence & { mediaType: 'image/png'; width: number; height: number;
    assets: { instanceId: string; assetId: string; sourceDigest: string; cloudVersionId?: string }[] };
};

/** Capture exact evaluated world/frame as PNG via the existing Three.js scene builder. */
export async function renderPovScreenshot(
  workspace: Workspace, preset: PovCameraPreset, time: number, size: number,
  signal: AbortSignal,
): Promise<PovScreenshotResult> {
  assertPovSceneBudget(workspace);
  const cameraPreset = validatePovPreset(preset);
  if (![320,480,640].includes(size)) throw Error('POV PNG size must be 320, 480 or 640 pixels.');
  if (!Number.isFinite(time) || time < 0 || time > workspace.animation.duration) throw Error('POV screenshot time must lie within the authored timeline.');
  if (signal.aborted) throw new DOMException('Capture cancelled.', 'AbortError');
  const sha = await captureSceneHash(workspace);
  const world = createWorld(workspace.items.map(item => item.asset), workspace.room);
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    const poses = evaluateWorkspace(workspace.items, workspace.animation, time);
    applyWorldPoses(world.groups, poses);
    const frame = resolvePovCameraFrame(cameraPreset, workspace, world.groups, time);
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(size,size);
    const camera = new THREE.PerspectiveCamera(cameraPreset.fovDegrees, 1, cameraPreset.clip.nearMeters, cameraPreset.clip.farMeters);
    camera.position.fromArray(frame.position);
    camera.quaternion.fromArray(frame.quaternion);
    renderer.render(world.scene, camera);
    if (signal.aborted) throw new DOMException('Capture cancelled.', 'AbortError');
    const canvas = renderer.domElement;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
      if (value) resolve(value);
      else reject(Error('Browser failed to encode the POV PNG.'));
    }, 'image/png'));
    if (signal.aborted) throw new DOMException('Capture cancelled.', 'AbortError');
    const evidence = povEvidence(cameraPreset, sha);
    evidence.frames.push(frame);
    const metadata: PovScreenshotResult['metadata'] = {
      ...evidence, mediaType: 'image/png', width:size, height:size,
      assets:workspace.items.map(item => ({
        instanceId:item.id, assetId:item.asset.id, sourceDigest:item.asset.source.digest,
        ...(item.cloudVersionId?{cloudVersionId:item.cloudVersionId}:{}),
      })),
    };
    return {blob, filename:`pov-${cameraPreset.name.replace(/[^a-z0-9_-]+/gi,'-').slice(0,60)||'camera'}.png`,metadata};
  } finally {world.dispose(); renderer?.dispose();renderer?.forceContextLoss();}
}
