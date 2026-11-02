import { canonicalJSON, hydrateManifest, makeManifest, readManifest, type SceneManifest, type Workspace } from './workspace';

export type LocalBinding = { id: string; revision?: number };
type Snapshot = { scene_id: string; revision: number; name: string; document: SceneManifest };
type Commit = { request_id: string; base_revision: number; document: SceneManifest };
type Recovery = { base: Snapshot; document: SceneManifest; pending: Commit | null; detached: boolean };
export type SyncView = { loaded: number | null; head: number | null; state: string; error: string; dirty: boolean; busy: boolean; ready: boolean; detached: boolean; pending: boolean; journalSaved: boolean };

/** Parse local bindings separately from authenticated cloud scene links. */
export function localBinding(url: URL): LocalBinding | null {
  const id = url.searchParams.get('localSceneId');
  if (id === null) return null;
  const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
  return { id, revision };
}

/** A tab-scoped recovery journal keeps drafts and ambiguous write receipts across reloads. */
async function journal(key: string, value?: Recovery): Promise<Recovery | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('oi-local-scene-drafts', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts');
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Draft storage is blocked. Close other workbench tabs.'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('drafts', value ? 'readwrite' : 'readonly');
      const request = value ? tx.objectStore('drafts').put(value, key) : tx.objectStore('drafts').get(key);
      tx.oncomplete = () => { db.close(); resolve(value ?? request.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Draft recovery storage failed.')); };
    };
  });
}

/** One serialized polling/commit owner; stale fetches never replace an edited workspace. */
export class LocalSceneSession {
  private base: Snapshot | null = null;
  private workspace: Workspace | null = null;
  private baseline = '';
  private dirty = false;
  private head: number | null = null;
  private detached = false;
  private pending: Commit | null = null;
  private running = false;
  private pollTask: Promise<void> | null = null;
  private stopped = false;
  private error = '';
  private fetchError = '';
  private storageError = '';
  private offline = false;
  private recoveryBlocked = false;
  private editingBusy = false;
  private journalVersion = 0;
  private savedJournalVersion = 0;
  private timer?: ReturnType<typeof setInterval>;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly key: string;
  constructor(readonly binding: LocalBinding, private readonly apply: (workspace: Workspace) => void, private readonly publish: (view: SyncView) => void) {
    let tab = sessionStorage.getItem('oi-local-scene-tab');
    if (!tab) { tab = crypto.randomUUID(); sessionStorage.setItem('oi-local-scene-tab', tab); }
    this.key = `${tab}:${binding.id}:${binding.revision ?? 'head'}`;
  }
  /** Restore a private draft before contacting the service, then start bounded polling. */
  async start(): Promise<void> {
    try {
      const saved = await journal(this.key);
      if (this.stopped) return;
      if (saved) {
        this.base = saved.base; this.baseline = canonicalJSON(makeManifest(hydrateManifest(readManifest(saved.base.document), []), true));
        this.workspace = hydrateManifest(readManifest(saved.document), []);
        this.dirty = canonicalJSON(makeManifest(this.workspace, true)) !== this.baseline;
        this.pending = saved.pending; this.detached = saved.detached;
        this.apply(this.workspace);
      }
    } catch (error) {
      this.base = null; this.workspace = null; this.recoveryBlocked = true;
      this.storageError = `Recovery unavailable: ${String(error)}. Stored draft data is retained. Retry by reloading, or explicitly discard recovery to open the store.`;
    }
    if (this.stopped) return;
    this.emit(); await this.poll();
    if (!this.stopped) this.timer = setInterval(() => void this.poll(), 2000);
  }
  /** Stop callbacks when the owning workbench unmounts. */
  stop(): void { this.stopped = true; clearInterval(this.timer); }
  /** Observe all editor mutations, including undo and redo, without changing the loaded base. */
  changed(workspace: Workspace): void {
    if (!this.base || workspace === this.workspace) return;
    this.workspace = workspace;
    this.dirty = canonicalJSON(makeManifest(workspace, true)) !== this.baseline;
    void this.checkpoint().catch(() => {}); this.emit();
  }
  /** Defer remote replacement while an import/generation operation owns the editor. */
  setEditingBusy(value: boolean): void {
    if (value === this.editingBusy) return;
    this.editingBusy = value; this.emit();
  }
  private emit(): void {
    if (this.stopped) return;
    const state = this.recoveryBlocked ? 'Recovery blocked' : this.detached ? 'Detached' : this.offline ? 'Offline — retrying' : this.pending ? 'Commit outcome pending' : !this.base ? 'Opening' : this.dirty && this.head !== null && this.head !== this.base.revision ? 'Conflict — draft retained' : this.dirty ? 'Unsaved edits' : this.binding.revision !== undefined ? 'Pinned revision' : 'Following head';
    this.publish({ loaded: this.base?.revision ?? null, head: this.head, state, error: [this.error, this.fetchError, this.storageError].filter(Boolean).join(' '), dirty: this.dirty, busy: (this.running && !!this.pending) || (this.editingBusy && !!this.base), ready: !!this.base, detached: this.detached, pending: !!this.pending, journalSaved: this.journalVersion === this.savedJournalVersion && !this.storageError });
  }
  private checkpoint(): Promise<unknown> {
    if (!this.base || !this.workspace) return Promise.resolve();
    const version = ++this.journalVersion;
    const value: Recovery = { base: this.base, document: makeManifest(this.workspace, true), pending: this.pending, detached: this.detached };
    const next = this.writes.catch(() => {}).then(() => journal(this.key, value));
    this.writes = next;
    void next.then(() => { this.savedJournalVersion = version; this.storageError = ''; this.emit(); }, error => { this.storageError = `Draft not saved on this device: ${String(error)}. Export before leaving.`; this.emit(); });
    return next;
  }
  private async request<T>(path: string, body?: Commit): Promise<T> {
    const response = await fetch(`/api/local-scenes/${encodeURIComponent(this.binding.id)}${path}`, {
      signal: AbortSignal.timeout(10000), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
      const changes = result.code === 'CONFLICT' ? result.changed_instances?.slice(0, 5).map((item: { instance_id: string; fields: string[] }) => `${item.instance_id}: ${item.fields.join(', ')}`).join('; ') : '';
      throw Object.assign(new Error(`${result.error ?? 'Local service unavailable.'}${changes ? ` Changed objects: ${changes}. Your draft is retained.` : ''}`), { code: result.code, head: result.current_revision });
    }
    return result;
  }
  private install(snapshot: Snapshot): void {
    const next = hydrateManifest(readManifest(snapshot.document), []);
    if (next.items.some(item => item.missing)) throw new Error('Revision contains unavailable geometry. Current draft retained.');
    // Reuse unchanged immutable geometry and instance objects in the existing editor.
    const previous = new Map(this.workspace?.items.map(item => [item.id, item]));
    next.items = next.items.map(item => {
      const old = previous.get(item.id);
      if (old?.cloudVersionId === item.cloudVersionId && old?.asset.id === item.asset.id) {
        item.asset = old.asset;
        if (canonicalJSON({ ...old, asset: undefined }) === canonicalJSON({ ...item, asset: undefined })) return old;
      }
      return item;
    });
    this.base = snapshot; this.workspace = next; this.baseline = canonicalJSON(makeManifest(next, true)); this.dirty = false;
    this.apply(next); void this.checkpoint().catch(() => {});
  }
  /** Poll metadata first; fetch geometry only when an eligible revision changes. */
  poll(): Promise<void> {
    if (this.running || this.stopped || this.detached || this.recoveryBlocked) return this.pollTask ?? Promise.resolve();
    this.pollTask = this.refresh().finally(() => { this.pollTask = null; });
    return this.pollTask;
  }
  private async refresh(): Promise<void> {
    this.running = true;
    try {
      const head = await this.request<{ revision: number }>('/head');
      if (this.stopped || this.detached) return;
      this.head = head.revision; this.offline = false; this.fetchError = '';
      const target = this.binding.revision ?? head.revision;
      if (!this.pending && !this.dirty && (!this.base || !this.editingBusy) && this.base?.revision !== target) {
        const before = this.workspace;
        const snapshot = await this.request<Snapshot>(`?revision=${target}`);
        // User may have edited, detached or unmounted while geometry was in flight.
        if (!this.stopped && !this.detached && !this.dirty && (!this.base || !this.editingBusy) && this.workspace === before) this.install(snapshot);
      }
    } catch (error) { this.offline = true; this.fetchError = `${String(error)} Start the local service with the same scene data directory.`; }
    finally { this.running = false; this.emit(); }
  }
  /** Commit with compare-and-swap and persist the request ID before sending for safe retries. */
  async commit(): Promise<void> {
    await this.pollTask;
    if (this.stopped) return;
    if (this.running || this.editingBusy || !this.base || !this.workspace || this.detached || this.binding.revision !== undefined) return;
    if (!this.pending && (!this.dirty || this.head !== this.base.revision)) return;
    this.running = true;
    this.pending ??= { request_id: crypto.randomUUID(), base_revision: this.base.revision, document: makeManifest(this.workspace, true) };
    const submitted = canonicalJSON(this.pending.document);
    this.emit();
    try {
      await this.checkpoint();
      const saved = await this.request<Snapshot>('/commit', this.pending);
      if (this.stopped) return;
      this.pending = null; this.head = saved.revision; this.offline = false; this.error = '';
      if (canonicalJSON(makeManifest(this.workspace, true)) === submitted) this.install(saved);
      else {
        // Edits made after a lost response belong to the next commit, not this receipt.
        this.base = saved; this.baseline = canonicalJSON(makeManifest(hydrateManifest(readManifest(saved.document), []), true));
        this.dirty = canonicalJSON(makeManifest(this.workspace, true)) !== this.baseline;
      }
      await this.checkpoint();
    } catch (error) {
      const failure = error as Error & { code?: string; head?: number };
      this.error = failure.message;
      if (failure.code) { this.pending = null; this.head = failure.head ?? this.head; await this.checkpoint().catch(() => {}); }
      else this.error += ' Retry the same commit to resolve its outcome; your draft is retained.';
    } finally { this.running = false; this.emit(); }
  }
  /** Pause or resume store following without discarding the current workspace. */
  detach(value: boolean): void { this.detached = value; void this.checkpoint().catch(() => {}); this.emit(); if (!value) void this.poll(); }
  /** Explicit discard is the only operation allowed to replace a dirty draft. */
  async discard(): Promise<void> {
    await this.pollTask;
    if (this.stopped) return;
    if (this.running || (this.editingBusy && !!this.base) || this.pending || this.detached) return;
    this.running = true;
    const before = this.workspace;
    try {
      const snapshot = await this.request<Snapshot>(this.binding.revision ? `?revision=${this.binding.revision}` : '');
      if (!this.stopped && !this.detached && this.workspace === before) { this.recoveryBlocked = false; this.install(snapshot); this.error = ''; }
    } catch (error) { this.error = String(error); }
    finally { this.running = false; this.emit(); }
  }
}
