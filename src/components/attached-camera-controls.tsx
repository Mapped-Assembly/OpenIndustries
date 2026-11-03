import type { Point3 } from '../lib/pov-camera';
import {
  attachedPreset, attachedRigEulerDegrees, configureAttachedRig,
  type PovCameraPreset,
} from '../lib/pov-capture';
import type { Workspace } from '../lib/workspace';
import './attached-camera-controls.css';

export type AttachedCameraControlsProps = {
  workspace: Workspace;
  rig: PovCameraPreset | null;
  onRigChange: (rig: PovCameraPreset | null) => void;
  sceneKey: string;
  sceneRevision: number | null;
};

/**
 * Camera-only configuration for an existing scene instance or declared part.
 * This does not edit the machine, create a frame, or command a physical robot.
 */
export function AttachedCameraControls({
  workspace, rig, onRigChange, sceneKey, sceneRevision,
}: AttachedCameraControlsProps) {
  const bound = rig?.binding.kind === 'attachedPose' ? rig.binding : null;
  const parent = workspace.items.find(item => item.id === bound?.instanceId);
  const angles: Point3 = rig && bound ? attachedRigEulerDegrees(rig) : [0, 0, 0];
  const offset: Point3 = bound?.position ?? [0, 0.12, 0];
  const unavailable = !!bound && (!parent || !!parent.missing || !parent.visible
    || (bound.assetId !== undefined && bound.assetId !== parent.asset.id)
    || (bound.sourceDigest !== undefined && bound.sourceDigest !== parent.asset.source.digest)
    || (bound.cloudVersionId !== undefined && bound.cloudVersionId !== parent.cloudVersionId)
    || (!!bound.partId && !parent.asset.parts.some(part => part.id === bound.partId)));

  /** Only an explicit selector change may assign a new parent identity. */
  const attach = (instanceId: string, partId?: string): void => {
    if (!instanceId) { onRigChange(null); return; }
    const next = attachedPreset(workspace, instanceId, 'Live mounted POV', sceneKey, sceneRevision, partId);
    onRigChange(rig && bound ? {
      ...next, fovDegrees: rig.fovDegrees,
      binding: next.binding.kind === 'attachedPose'
        ? { ...next.binding, position: [...bound.position], quaternion: [...bound.quaternion] }
        : next.binding,
    } : next);
  };
  const updatePosition = (axis: number, value: number): void => {
    if (!rig || !Number.isFinite(value) || Math.abs(value) > 100) return;
    const next = [...offset] as Point3;
    next[axis] = value;
    onRigChange(configureAttachedRig(rig, { position: next }));
  };
  const updateRotation = (axis: number, value: number): void => {
    if (!rig || !Number.isFinite(value) || Math.abs(value) > 360) return;
    const next = [...angles] as Point3;
    next[axis] = value;
    onRigChange(configureAttachedRig(rig, { eulerDegrees: next }));
  };

  return <div className="oi-attached-tools" role="group" aria-label="Attached camera controls">
    <div className="oi-attached-title"><strong>Mounted POV</strong><span>Synthetic · scene-driven</span></div>
    <label>Parent instance
      <select aria-label="Camera parent instance" value={bound?.instanceId ?? ''}
        onChange={event => attach(event.target.value)}>
        <option value="">Choose an instance</option>
        {bound && !workspace.items.some(item => item.id === bound.instanceId)
          && <option value={bound.instanceId} disabled>Missing: {bound.instanceId}</option>}
        {workspace.items.map(item => <option key={item.id} value={item.id} disabled={item.missing}>
          {item.name} ({item.id}){item.missing ? ' — missing geometry' : ''}
        </option>)}
      </select>
    </label>
    {bound && <label>Mount frame
      <select aria-label="Camera mount frame" value={bound.partId ?? ''}
        disabled={!parent || parent.missing}
        onChange={event => attach(bound.instanceId, event.target.value || undefined)}>
        <option value="">Instance origin</option>
        {bound.partId && !parent?.asset.parts.some(part => part.id === bound.partId)
          && <option value={bound.partId} disabled>Missing part: {bound.partId}</option>}
        {parent?.asset.parts.map(part => <option key={part.id} value={part.id}>
          {part.name} ({part.id})
        </option>)}
      </select>
    </label>}
    {bound && <div className="oi-attached-inputs">
      <fieldset><legend>Local offset (m)</legend><div className="oi-attached-fields">
        {(['X','Y','Z'] as const).map((axis,i) => <label key={axis}>{axis}
          <input aria-label={`Camera offset ${axis}`} type="number" step="0.01"
            value={offset[i]} onChange={event => updatePosition(i,Number(event.target.value))}/>
        </label>)}
      </div></fieldset>
      <fieldset><legend>Local rotation (degrees)</legend><div className="oi-attached-fields">
        {(['Pitch','Yaw','Roll'] as const).map((axis,i) => <label key={axis}>{axis}
          <input aria-label={`Camera ${axis.toLowerCase()}`} type="number" step="5"
            value={Number(angles[i].toFixed(3))}
            onChange={event => updateRotation(i,Number(event.target.value))}/>
        </label>)}
      </div></fieldset>
      <label>Field of view (degrees)
        <input aria-label="Mounted camera FOV" type="number" min="20" max="100" step="5"
          value={rig!.fovDegrees}
          onChange={event => {
            const value = Number(event.target.value);
            if (Number.isFinite(value) && value >= 20 && value <= 100) onRigChange(configureAttachedRig(rig!,{fovDegrees:value}));
          }}/>
      </label>
    </div>}
    <p role="status">{!bound ? 'Choose an existing instance to attach the camera.'
      : unavailable ? 'UNBOUND · The selected instance, part, or asset version is missing or hidden. Camera view is held.'
        : `Attached to ${parent?.name}${bound.partId ? ` / ${bound.partId}` : ''}. Transforms follow evaluated scene poses.`}</p>
    <small>Parts are geometry IDs, not inferred joints or calibrated sensor frames. No real camera or collision validation.</small>
  </div>;
}
