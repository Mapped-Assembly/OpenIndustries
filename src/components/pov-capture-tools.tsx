import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { CameraSession } from '../lib/pov-camera';
import {
  attachedPreset, loadPovPresets, storePovPresets, worldPresetFromSession,
  type PovCameraPreset,
} from '../lib/pov-capture';
import { renderGif } from '../lib/gif';
import { renderPovScreenshot } from '../lib/pov-screenshot';
import type { Workspace } from '../lib/workspace';

type Props = {
  workspace: Workspace; selected: number; sceneKey: string; sceneRevision: number | null;
  cameraSession: RefObject<CameraSession>; viewMode: '3d' | 'plan' | 'pov';
  size: number; duration: number; fps: number; rangeStart: number; rangeEnd: number; time: number | null;
};

type CaptureResult = { blob: Blob; filename: string; metadata: unknown };
type Format = 'png' | 'static-gif' | 'animation-gif';

/** Maintain one paired blob URL; release it when the media changes or unmounts. */
function useMediaUrl(blob: Blob | undefined): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const value = URL.createObjectURL(blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  return url;
}

/** User-initiated, scene-scoped presets and synthetic POV exports. */
export function PovCaptureTools({
  workspace, selected, sceneKey, sceneRevision, cameraSession, viewMode,
  size, duration, fps, rangeStart, rangeEnd, time,
}: Props) {
  const [name, setName] = useState('My POV');
  const [presets, setPresets] = useState<PovCameraPreset[]>([]);
  const [chosenId, setChosenId] = useState('');
  const [format, setFormat] = useState<Format>('png');
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const mediaUrl = useMediaUrl(result?.blob);
  const metadataBlob = useMemo(() => result
    ? new Blob([JSON.stringify(result.metadata, null, 2)], { type: 'application/json' }) : undefined, [result]);
  const metadataUrl = useMediaUrl(metadataBlob);
  const preset = presets.find(item => item.id === chosenId);
  const stale = !!preset && preset.sceneRevision !== sceneRevision;

  useEffect(() => {
    const saved = loadPovPresets(localStorage, sceneKey, sceneKey);
    setPresets(saved);
    setChosenId(saved[0]?.id ?? '');
    setResult(null);
  }, [sceneKey]);

  useEffect(() => () => abort.current?.abort(), []);

  /** Persist only on an explicit click. Scene and history are not modified. */
  function savePreset(next: PovCameraPreset): void {
    if (presets.length >= 32) throw Error('At most 32 camera presets are supported in one scene.');
    const updated = [next, ...presets];
    storePovPresets(localStorage, sceneKey, updated);
    setPresets(updated); setChosenId(next.id); setResult(null); setError('');
    setMessage('Saved camera on this device; no scene revision created.');
  }

  function saveWorld(): void {
    try { savePreset(worldPresetFromSession(cameraSession.current, name, sceneKey, sceneRevision)); }
    catch (cause) { setError((cause as Error).message); }
  }

  function saveAttachment(): void {
    try {
      const instance = workspace.items[selected];
      if (!instance) throw Error('Select an existing scene instance for the camera mount.');
      savePreset(attachedPreset(workspace, instance.id, name, sceneKey, sceneRevision));
    } catch (cause) { setError((cause as Error).message); }
  }

  function rebind(): void {
    if (!preset) return;
    try {
      const updatedPreset = { ...preset, sceneRevision, savedAt: new Date().toISOString() };
      const updated = presets.map(candidate => candidate.id === preset.id ? updatedPreset : candidate);
      storePovPresets(localStorage, sceneKey, updated);
      setPresets(updated); setResult(null); setError('');
      setMessage('Explicitly rebound preset to the current scene revision; old revision is not implied.');
    } catch (cause) { setError((cause as Error).message); }
  }

  function remove(): void {
    if (!preset) return;
    try {
      const next = presets.filter(item => item.id !== preset.id);
      storePovPresets(localStorage, sceneKey, next);
      setPresets(next); setChosenId(next[0]?.id ?? ''); setResult(null);
      setMessage('Removed saved camera preset; scene unchanged.'); setError('');
    } catch (cause) { setError((cause as Error).message); }
  }

  async function capture(): Promise<void> {
    if (abort.current || !preset) return;
    const controller = new AbortController();
    abort.current = controller; setBusy(true); setError(''); setMessage('Capturing synthetic scene…'); setProgress(0); setResult(null);
    try {
      if (preset.sceneRevision !== sceneRevision) throw Error('Camera preset targets another revision. Explicitly rebind it before capture.');
      const shotTime = time ?? 0;
      let output: CaptureResult;
      if (format === 'png') {
        output = await renderPovScreenshot(workspace, preset, shotTime, size, controller.signal);
      } else {
        output = await renderGif(workspace.items.map(item => item.asset), workspace.room, {
          scope: 'room', assetIndex: 0, region: { x: 0, z: 0, width: workspace.room[0], depth: workspace.room[1] },
          motion: format === 'animation-gif' ? 'animation' : 'pov', size, duration, fps, rangeStart, rangeEnd,
          snapshotTime: shotTime, allowEmptyRoom: true, pov: preset,
        }, controller.signal, value => setProgress(value), workspace);
      }
      if (controller.signal.aborted) throw new DOMException('Capture cancelled.', 'AbortError');
      setResult(output);
      setMessage(`${format === 'png' ? 'PNG' : 'GIF'} ready · ${(output.blob.size / 1024).toFixed(0)} KB · SYNTHETIC SCENE RENDER`);
    } catch (cause) {
      setMessage(controller.signal.aborted ? 'Capture cancelled; scene unchanged.' : 'POV capture did not complete.');
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally { abort.current = null; setBusy(false); }
  }

  return <div className="pov-capture-tools" aria-label="POV camera capture">
    <p>Save a camera viewpoint explicitly, then export a synthetic PNG or bounded GIF with scene and camera provenance. These are not real sensor measurements.</p>
    <label>Camera name<input aria-label="POV camera name" maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="capture-actions">
      <button disabled={busy || viewMode !== 'pov' || !cameraSession.current.pov || !name.trim()} onClick={saveWorld}>Save current POV</button>
      <button disabled={busy || selected < 0 || !workspace.items[selected] || !name.trim()} onClick={saveAttachment}>Save selected instance camera</button>
    </div>
    <p className="notice">Mounted camera uses the selected instance's evaluated transform with a default +0.12 m local vertical offset. Robot link/tool camera setup belongs to #104.</p>
    <label>Saved camera<select aria-label="Saved POV camera" value={chosenId} disabled={busy} onChange={event => {setChosenId(event.target.value);setResult(null);}}>
      <option value="">Choose a saved camera</option>
      {presets.map(item => <option key={item.id} value={item.id}>{item.name} — {item.binding.kind === 'attachedPose' ? 'attached' : 'free POV'}</option>)}
    </select></label>
    {preset && <div className="pov-preset-details">
      <p>Camera: {preset.binding.kind} · 45° FOV · Y-up / meters</p>
      <p>Scene revision: {preset.sceneRevision ?? 'unversioned local draft'}{stale ? ' · changed since preset saved' : ''}</p>
      <div className="capture-actions">
        {stale && <button disabled={busy} onClick={rebind}>Rebind to current revision</button>}
        <button disabled={busy} onClick={remove}>Delete camera preset</button>
      </div>
    </div>}
    <label>POV export format<select aria-label="POV export format" disabled={busy} value={format} onChange={event => setFormat(event.target.value as Format)}>
      <option value="png">PNG screenshot at current time</option>
      <option value="static-gif">GIF with fixed POV</option>
      <option value="animation-gif">GIF over authored timeline</option>
    </select></label>
    {format === 'animation-gif' && <p>Uses the authored timeline range above. Camera mount and animated objects evaluate at the same frame timestamp.</p>}
    <button className="capture-primary" disabled={busy || !preset || stale}
      onClick={() => void capture()}>{format === 'png' ? 'Capture POV PNG' : 'Render POV GIF'}</button>
    {busy && <div className="capture-progress"><progress aria-label="POV capture progress" value={progress} max={1} />
      <button onClick={() => abort.current?.abort()}>Cancel POV capture</button></div>}
    <p role="status" aria-label="POV capture status">{message}</p>
    {error && <p className="capture-error" role="alert">{error}</p>}
    {result && mediaUrl && <div className="capture-result">
      <img src={mediaUrl} alt="Synthetic POV capture preview" />
      <p>{result.filename} · Synthetic scene render, not a real camera observation.</p>
      <div className="capture-actions"><a download={result.filename} href={mediaUrl}>Download POV media</a>
        {metadataUrl && <a download={result.filename.replace(/\.(png|gif)$/, '.json')} href={metadataUrl}>Download POV evidence</a>}</div>
    </div>}
  </div>;
}
