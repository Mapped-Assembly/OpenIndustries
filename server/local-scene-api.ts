import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { LocalSceneBackend } from './local-scene-backend.ts';
import { oiEnv } from './oi-environment.mjs';
import { SceneToolError } from './mcp-scene-contract.mjs';
import { canonicalJSON, hydrateManifest, makeManifest, readManifest } from '../src/lib/workspace.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Local HTTP bridge uses the same store, immutable assets and atomic revision check as MCP. */
export async function localSceneRequest(root: string, id: string, operation: string, revisionText?: string, body?: unknown): Promise<unknown> {
  if (oiEnv('SCENE_BACKEND') !== 'local') throw new SceneToolError('DISABLED', 'Set OI_SCENE_BACKEND=local and restart the local service.');
  if (!uuid.test(id)) throw new SceneToolError('INVALID_REQUEST', 'Scene ID must be a UUID.');
  const revision = revisionText === undefined ? undefined : Number(revisionText);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new SceneToolError('INVALID_REQUEST', 'Revision must be a positive integer.');
  const backend = new LocalSceneBackend(resolve(oiEnv('ROOT') || root, oiEnv('SCENE_DATA_DIR') || '.astra/scenes'));
  try {
    if (operation === 'head') {
      const head = await backend.read(id);
      return { scene_id: id, revision: head.revision, name: head.name };
    }
    if (operation === 'read') {
      const saved = await backend.read(id, revision);
      return { scene_id: id, revision: saved.revision, name: saved.name, document: await backend.exportScene(id, saved.revision) };
    }
    const input = body as { request_id: string; base_revision: number; document: unknown };
    if (!input || !uuid.test(input.request_id) || !Number.isSafeInteger(input.base_revision) || input.base_revision < 1)
      throw new SceneToolError('INVALID_REQUEST', 'A request UUID and positive base revision are required.');
    const previous = await backend.read(id, input.base_revision);
    const workspace = hydrateManifest(readManifest(input.document), []);
    if (workspace.items.some(item => item.missing)) throw new SceneToolError('MISSING_ASSETS', 'Export or import complete geometry before committing.');
    const digest = createHash('sha256').update(canonicalJSON({ id, ...input })).digest('hex');
    const versions = new Map<string, string>();
    const verified = new Map<object, string>();
    for (const item of workspace.items) {
      // Never trust client-supplied immutable version bindings; verify the complete geometry.
      const actual = verified.get(item.asset) ?? await backend.persistAsset(item.asset);
      verified.set(item.asset, actual);
      if (item.cloudVersionId && item.cloudVersionId !== actual)
        throw new SceneToolError('INVALID_ASSET', 'Geometry does not match its immutable local asset version.');
      const existing = versions.get(item.asset.id);
      if (existing && existing !== actual) throw new SceneToolError('INVALID_ASSET', 'One asset ID cannot name different versions.');
      versions.set(item.asset.id, actual); item.cloudVersionId = actual;
    }
    const document = { ...makeManifest(workspace), authoring: { via: 'workbench', agent: 'browser', parent_revision: input.base_revision, request_id: input.request_id, request_digest: digest } };
    if (Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024) throw new SceneToolError('PAYLOAD_TOO_LARGE', 'Scene metadata exceeds 1 MiB.');
    const saved = await backend.save(id, previous.name, document, input.base_revision, input.request_id);
    return { scene_id: id, revision: saved.revision, name: saved.name, document: await backend.exportScene(id, saved.revision) };
  } finally { backend.close(); }
}
