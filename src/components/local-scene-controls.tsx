import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LocalSceneSession, type LocalBinding, type SyncView } from '../lib/local-scene-session';
import type { Workspace } from '../lib/workspace';

/** Connect the scene editor to a local persisted scene while retaining its existing viewer. */
export function useLocalScene(binding: LocalBinding | null, workspace: Workspace, editingBusy: boolean, apply: (value: Workspace) => void) {
  const session = useRef<LocalSceneSession | null>(null), latest = useRef(apply); latest.current = apply;
  const [view, setView] = useState<SyncView>({ loaded: null, head: null, state: 'Opening', error: '', dirty: false, busy: false, ready: false, detached: false, pending: false, journalSaved: false });
  useEffect(() => {
    if (!binding) return;
    const value = new LocalSceneSession(binding, next => latest.current(next), setView); session.current = value;
    void value.start(); return () => { value.stop(); session.current = null; };
  }, [binding?.id, binding?.revision]);
  useLayoutEffect(() => { session.current?.changed(workspace); }, [workspace]);
  useLayoutEffect(() => { session.current?.setEditingBusy(editingBusy); }, [editingBusy]);
  useEffect(() => {
    if (!binding) return;
    const warn = (event: BeforeUnloadEvent) => { if (view.dirty || view.pending) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [!!binding, view.dirty, view.pending]);
  return { view, session };
}

/** Display revision identity and explicit conflict/reconnection actions. */
export function LocalSceneControls({ binding, sync, onExport }: { binding: LocalBinding; sync: ReturnType<typeof useLocalScene>; onExport: () => void }) {
  const { view, session } = sync;
  return <section aria-label="Local scene synchronization" className="local-scene-sync">
    <div className="eyebrow">PERSISTENT LOCAL SCENE</div>
    <p>Scene <code>{binding.id}</code></p>
    <p>Loaded revision <b data-testid="local-loaded-revision">{view.loaded ?? '—'}</b> · Store head <b data-testid="local-head-revision">{view.head ?? '—'}</b></p>
    <p role="status" data-testid="local-sync-state">{view.state}</p>
    {view.error && <p role="alert">{view.error}</p>}
    <small data-testid="local-draft-journal">{view.journalSaved ? 'Recovery draft saved' : 'Recovery draft not yet saved'}</small>
    <p>Edits are kept in this tab’s recovery draft. Commit explicitly to publish a revision.</p>
    <div className="capture-actions">
      <button disabled={!view.ready || view.busy || view.detached || binding.revision !== undefined || (!view.pending && (!view.dirty || view.head !== view.loaded))} onClick={() => void session.current?.commit()}>{view.pending ? 'Retry same commit' : 'Commit browser edits'}</button>
      <button disabled={view.busy || view.pending} onClick={() => session.current?.detach(!view.detached)}>{view.detached ? 'Reconnect scene' : 'Detach scene'}</button>
      <button disabled={!view.ready} onClick={onExport}>Export local draft</button>
      <button disabled={(!view.ready && view.state !== 'Recovery blocked') || view.busy || view.pending || view.detached} onClick={() => { if ((!view.dirty && view.state !== 'Recovery blocked') || window.confirm('Discard browser edits/recovery and load the stored revision? Export your draft first to keep a separate copy.')) void session.current?.discard(); }}>{view.state === 'Recovery blocked' ? 'Discard recovery and load store' : 'Discard edits and load store'}</button>
    </div>
    {binding.revision !== undefined && <p>Pinned revisions do not follow or commit to head. Export edits before <a href={`/?localSceneId=${encodeURIComponent(binding.id)}`}>opening head</a>.</p>}
    <a href="/">Return to browser-local rooms</a>
  </section>;
}

/** Open a persistent binding after flushing the ordinary browser-local draft. */
export function OpenLocalScene({ flush, disabled }: { flush: () => Promise<void>; disabled: boolean }) {
  const [id, setId] = useState(''), [revision, setRevision] = useState(''), [error, setError] = useState('');
  return <section aria-label="Open local persisted scene"><div className="eyebrow">LOCAL SCENE STORE</div><form onSubmit={event => {
    event.preventDefault();
    void flush().then(() => { location.href = `/?localSceneId=${encodeURIComponent(id)}${revision ? `&revision=${revision}` : ''}`; }).catch(e => setError(String(e)));
  }}><label>Persistent scene ID<input aria-label="Persistent scene ID" required pattern="[0-9a-fA-F-]{36}" value={id} onChange={e => setId(e.target.value)} /></label><label>Revision (blank follows head)<input aria-label="Persistent revision" type="number" min="1" step="1" value={revision} onChange={e => setRevision(e.target.value)} /></label><button disabled={disabled}>Open local scene</button></form>{error && <p role="alert">{error}</p>}</section>;
}
