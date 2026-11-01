import type { Asset, Vec3 } from '../src/lib/scene.ts';
import { canonicalJSON, hydrateManifest, makeManifest, readManifest, type SceneManifest } from '../src/lib/workspace.ts';
import { SceneToolError, validateSceneResult } from './mcp-scene-contract.mjs';
import type { SavedScene, SceneBackend, SceneDocument } from './scene-backend.ts';

export type ImmutableAssetRef = { kind: 'local' | 'cloud'; version_id: string };
type Fields = { name: string; asset: ImmutableAssetRef; position: Vec3; rotation: Vec3; visible: boolean };
type Operation = { op: 'add_instance'; instance: Fields & { id: string } }
  | { op: 'update_instance'; instance_id: string; patch: Partial<Fields>; preconditions?: Partial<Fields> }
  | { op: 'remove_instance'; instance_id: string; preconditions?: Partial<Fields> };
export type MutationRequest = { version: 1; request_id: string; scene_id: string; base_revision: number; agent: string; operations: Operation[] };
export type MutationChange = { operation_index: number; op: Operation['op']; instance_id: string; status: 'applied'; fields: (keyof Fields)[] };
export type MutationReceipt = { changes: MutationChange[]; summary: { added: number; updated: number; removed: number } };
type Loader = (ref: ImmutableAssetRef) => Promise<{ asset: Asset; version?: string }>;
type StoredInstance = SceneManifest['instances'][number];

/** Return a bounded public receipt from the immutable revision, including on identical retries. */
export function mutationResult(saved: SavedScene, urls: (saved: SavedScene) => object): object {
  const author = saved.document.authoring;
  if (!author.mutation) throw new SceneToolError('REQUEST_ID_REUSED', 'Request ID belongs to a different scene operation.');
  return { ...urls(saved), ...author.mutation, provenance: { agent: author.agent, parent_revision: author.parent_revision,
    request_id: author.request_id, request_digest: author.request_digest } };
}

/** Apply ordered operations in memory; the existing backend performs the only durable scene write. */
export async function mutateScene(args: MutationRequest, head: SavedScene, backend: SceneBackend, load: Loader,
  digest: string, active: () => void, urls: (saved: SavedScene) => object): Promise<object> {
  // This preserves original records (including key IDs and source metadata), rather than round-tripping a full update request.
  const document = structuredClone(head.document);
  const manifest = readManifest(document);
  const geometry = new Map<string, Asset>();
  const changes: MutationChange[] = [];
  const lastOperation = new Map<string, number>();
  const failOperation = (index: number, code: string, message: string): never => {
    const operation = args.operations[index];
    throw new SceneToolError(code, message, { applied: false, operation_errors: [{ operation_index: index, op: operation.op,
      instance_id: operation.op === 'add_instance' ? operation.instance.id : operation.instance_id, code, message }] });
  };
  const operationError = (index: number, error: unknown): never => {
    if (error instanceof SceneToolError && error.details && 'operation_errors' in error.details) throw error;
    return failOperation(index, error instanceof SceneToolError ? error.code : 'INVALID_SCENE',
      error instanceof SceneToolError ? error.message : 'Operation would violate the scene or animation schema.');
  };
  const loadVersion = async (ref: ImmutableAssetRef): Promise<Asset> => {
    active();
    if (ref.kind !== backend.kind) throw new SceneToolError('ASSET_UNAVAILABLE', 'Asset reference belongs to another persistence backend.');
    if (!geometry.has(ref.version_id)) geometry.set(ref.version_id, (await load(ref)).asset);
    return geometry.get(ref.version_id)!;
  };
  // Validate the existing snapshot and geometry first. No asset uploads or metadata writes occur here.
  for (const item of manifest.instances) {
    if (!item.cloudVersionId) throw new SceneToolError('MISSING_ASSETS', 'Persist existing scene geometry before applying object mutations.');
    await loadVersion({ kind: backend.kind, version_id: item.cloudVersionId });
  }
  hydrateManifest(manifest, [], geometry);
  const bind = async (item: StoredInstance, ref: ImmutableAssetRef): Promise<void> => {
    const asset = await loadVersion(ref);
    item.assetId = asset.id; item.cloudVersionId = ref.version_id;
    const reference = makeManifest({ room: document.room, animation: document.animation,
      items: [{ ...item, asset }] }).assets[0];
    // Match complete-scene authoring's source allowlist, never embedding runtime/provider data.
    reference.source = { kind: asset.source.kind, filename: asset.source.filename, digest: asset.source.digest,
      ...(asset.source.projectId ? { projectId: asset.source.projectId } : {}), ...(asset.source.version ? { version: asset.source.version } : {}),
      ...(asset.source.kind === 'generated' ? { generator: asset.source.generator } : {}) } as Asset['source'];
    const existing = document.assets.findIndex(entry => entry.id === asset.id);
    if (existing < 0) document.assets.push(reference);
    else {
      // Preserve metadata exactly when reusing the same immutable identity.
      const original = head.document.instances.some(entry => entry.assetId === asset.id && entry.cloudVersionId === ref.version_id);
      document.assets[existing] = original ? structuredClone(head.document.assets.find(entry => entry.id === asset.id)!) : reference;
    }
  };
  for (const [index, operation] of args.operations.entries()) {
    active();
    const id = operation.op === 'add_instance' ? operation.instance.id : operation.instance_id;
    lastOperation.set(id, index);
    try {
      const at = document.instances.findIndex(item => item.id === id);
      if (operation.op === 'add_instance') {
        if (at !== -1) failOperation(index, 'DUPLICATE_INSTANCE', 'An instance with this ID already exists.');
        const { asset, ...fields } = operation.instance;
        const item: StoredInstance = { ...fields, assetId: '' };
        await bind(item, asset); document.instances.push(item);
      } else {
        if (at === -1) failOperation(index, 'INSTANCE_UNAVAILABLE', 'The target instance does not exist at this point in the batch.');
        const item = document.instances[at];
        const actual: Fields = { name: item.name, position: item.position, rotation: item.rotation, visible: item.visible,
          asset: { kind: backend.kind, version_id: item.cloudVersionId! } };
        for (const [field, expected] of Object.entries(operation.preconditions ?? {})) {
          if (canonicalJSON(actual[field as keyof Fields]) !== canonicalJSON(expected))
            failOperation(index, 'PRECONDITION_FAILED', 'An explicitly expected instance field does not match.');
        }
        if (operation.op === 'remove_instance') document.instances.splice(at, 1);
        else {
          const { asset, ...fields } = operation.patch;
          Object.assign(item, fields);
          if (asset) await bind(item, asset);
        }
      }
      changes.push({ operation_index: index, op: operation.op, instance_id: id, status: 'applied',
        fields: operation.op === 'remove_instance' ? [] : operation.op === 'add_instance' ? ['name', 'asset', 'position', 'rotation', 'visible'] : Object.keys(operation.patch).sort() as (keyof Fields)[] });
    } catch (error) { operationError(index, error); }
  }
  // Validate the final graph: batches may replace multiple bindings or remove/re-add a tracked ID together.
  const identities = new Map<string, StoredInstance>();
  for (const item of document.instances) {
    const previous = identities.get(item.assetId);
    if (previous && previous.cloudVersionId !== item.cloudVersionId) {
      const index = lastOperation.get(item.id) ?? lastOperation.get(previous.id) ?? args.operations.length - 1;
      failOperation(index, 'INVALID_ASSET', 'One asset ID cannot refer to multiple immutable versions in a scene.');
    }
    identities.set(item.assetId, item);
  }
  for (const track of document.animation.tracks) {
    const item = document.instances.find(item => item.id === track.instanceId);
    if (!item || (track.partId && !geometry.get(item.cloudVersionId!)?.parts.some(part => part.id === track.partId)))
      failOperation(lastOperation.get(track.instanceId) ?? args.operations.length - 1, 'ANIMATION_REFERENCE', 'Operation would invalidate a preserved animation target. Update the animation through update_scene first.');
  }
  try { hydrateManifest(readManifest(document), [], geometry); }
  catch (error) { operationError(args.operations.length - 1, error); }
  const summary = { added: 0, updated: 0, removed: 0 };
  for (const change of changes) summary[change.op === 'add_instance' ? 'added' : change.op === 'update_instance' ? 'updated' : 'removed']++;
  document.authoring = { via: 'mcp', agent: args.agent, parent_revision: args.base_revision, request_id: args.request_id,
    request_digest: digest, mutation: { changes, summary } };
  if (Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024) throw new SceneToolError('PAYLOAD_TOO_LARGE', 'Resulting scene metadata exceeds 1 MiB.');
  const candidate: SavedScene = { ...head, revision: args.base_revision + 1, last_write_id: args.request_id, document: document as SceneDocument };
  // Result validation also precedes the commit, so a successful write never returns a schema error.
  validateSceneResult('astra.mutate_scene', mutationResult(candidate, urls));
  active();
  const saved = await backend.save(args.scene_id, head.name, document, args.base_revision, args.request_id);
  if (saved.document.authoring.request_digest !== digest) throw new SceneToolError('REQUEST_ID_REUSED', 'Request ID belongs to different content.');
  return mutationResult(saved, urls);
}
