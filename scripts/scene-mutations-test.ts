import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Ajv from 'ajv';
import { createClient } from '@supabase/supabase-js';
import { startClient } from './lib/mcp-scene-workflows.mjs';
import { sceneTestService } from './lib/scene-test-service.ts';
import { LocalSceneBackend } from '../server/local-scene-backend.ts';
import { SupabaseSceneBackend, type SceneBackend } from '../server/scene-backend.ts';
import { canonicalJSON } from '../src/lib/workspace.ts';
import { CloudStorage } from '../src/lib/cloud-storage.ts';
import type { Asset } from '../src/lib/scene.ts';

const hash = (value: unknown): string => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const cli = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'oi-mutations-'));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OI_') && !key.startsWith('ASTRA_')));
const asset: Asset = { schemaVersion: 1, id: 'environment-monitor-asset', name: 'Environment monitor', units: 'm', upAxis: 'Y',
  dimensions: [1, 1, 1], originOffset: [0, 0, 0], source: { kind: 'generated', generator: 'form-industries', filename: 'monitor.json', digest: 'monitor-v1' },
  parts: [{ id: 'monitor-body', name: 'Body', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 1], indices: [0, 1, 2], metadata: {} }],
  hierarchy: { id: 'monitor', name: 'Monitor', partIds: ['monitor-body'], children: [] }, warnings: [] };

/** Run the public stdio + CLI contract against both real SQLite and the migration-backed cloud fixture. */
async function suite(kind: 'local' | 'cloud'): Promise<void> {
  const root = join(directory, kind);
  const service = kind === 'cloud' ? await sceneTestService() : null;
  const owner = randomUUID();
  const session = service ? await service.account(owner) : null;
  const config = join(directory, `${kind}-auth.json`);
  if (session) await writeFile(config, JSON.stringify(session));
  const env = { ...cleanEnv, OI_ROOT: root, OI_SCENE_BACKEND: kind === 'cloud' ? 'supabase' : 'local', OI_SCENE_DATA_DIR: root,
    OI_SCENE_TOOLS_ENABLED: 'true', OI_CLI_CONFIG: config, VITE_SUPABASE_URL: service?.origin ?? '', VITE_SUPABASE_PUBLISHABLE_KEY: service ? 'fixture-public-key' : '' };
  const client = service && session ? createClient(service.origin, 'fixture-public-key', { global: { headers: { Authorization: `Bearer ${session.access_token}` } }, auth: { persistSession: false } }) : null;
  const backend: SceneBackend = kind === 'local' ? new LocalSceneBackend(root) : new SupabaseSceneBackend(client!, owner);
  const processes: ReturnType<typeof startClient>[] = [];
  const connect = () => { const mcp = startClient({ request_ids: 'string', client: 'object-mutations' }, { env, root }); processes.push(mcp); return mcp; };
  let mcp = connect();
  const validators = new Map<string, ReturnType<Ajv['compile']>>();
  /** Check both standard MCP response representations against discovery's output schema. */
  async function ok(name: string, args: unknown, process = mcp): Promise<any> {
    const result = await process.call(name, args);
    assert(!result.isError, JSON.stringify(result));
    const data = result.structuredContent;
    assert.deepEqual(JSON.parse(result.content[0].text), data);
    const validate = validators.get(name); assert(validate?.(data), JSON.stringify(validate?.errors));
    return data;
  }
  const counts = async (): Promise<unknown> => service ? (await service.sql('select (select count(*) from scene_revisions)::int revisions,(select count(*) from asset_file_versions)::int versions')).rows[0]
    : { versions: (await readdir(join(root, 'assets'))).length };
  try {
    await mcp.rpc('initialize');
    const listed = await mcp.rpc('tools/list');
    for (const tool of listed.tools.filter((tool: { name: string }) => tool.name.includes('scene'))) validators.set(tool.name.replace('openindustries.', ''), new Ajv({ strict: false }).compile(tool.outputSchema));
    assert(validators.has('mutate_scene'));
    /** Import separately through the existing immutable asset mechanism. */
    async function importAsset(value: Asset): Promise<{ kind: string; version_id: string }> {
      if (kind === 'local') {
        const path = join(directory, `${randomUUID()}.asset.json`);
        await writeFile(path, JSON.stringify({ schemaVersion: 1, asset: value }));
        const imported = await cli(process.execPath, ['--import', 'tsx', 'cli/local-scenes.ts', 'import-asset', path], { env });
        return JSON.parse(imported.stdout);
      }
      const uploaded = await new CloudStorage(client!, owner).upload({ id: value.id, asset: value, updatedAt: Date.now() }, () => {});
      return { kind, version_id: uploaded.id };
    }
    const assetRef = await importAsset(asset);
    const created = await ok('create_scene', { version: 1, request_id: randomUUID(), agent: 'baseline-fixture', scene: {
      name: 'Nine-instance S0', room: { width: 12, depth: 10, height: 3 },
      instances: Array.from({ length: 9 }, (_, i) => ({ id: `original-${i}`, name: `Original ${i}`, asset: { kind: 'example', id: 'cleanroom-desk' }, position: [i, 0, i / 2], rotation: [0, i * 10, 0], visible: i !== 8 })),
      animation: { duration: 3, loop: true, tracks: [{ instance_id: 'original-0', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0], visible: true }, { time: 3, position: [1, 0, 0], rotation: [0, 45, 0], visible: false }] }] },
    } });
    const id = created.scene_id, s0 = await backend.read(id);
    const originalVersions = [...new Set(s0.document.instances.map(item => item.cloudVersionId!))];
    const originalHashes = await Promise.all(originalVersions.map(async version => hash(await backend.geometry((await backend.asset(version))!))));
    /** Every success must preserve the original fields, asset records, room, animation and full geometry. */
    async function originals(): Promise<void> {
      const stored = await backend.read(id);
      assert.deepEqual(stored.document.instances.filter(item => item.id.startsWith('original-')), s0.document.instances);
      assert.deepEqual(stored.document.assets.filter(entry => s0.document.assets.some(original => original.id === entry.id)), s0.document.assets);
      assert.deepEqual(stored.document.room, s0.document.room); assert.deepEqual(stored.document.animation, s0.document.animation);
      assert.deepEqual(await Promise.all(originalVersions.map(async version => hash(await backend.geometry((await backend.asset(version))!)))), originalHashes);
    }
    const request = (base: number, operations: unknown[]) => ({ version: 1, request_id: randomUUID(), scene_id: id, base_revision: base, agent: 'mutation-agent', operations });
    const add = { op: 'add_instance', instance: { id: 'environment-monitor-01', name: 'Environment monitor', asset: assetRef, position: [2, 0, 2], rotation: [0, 0, 0], visible: true } };
    const addition = request(1, [add]);
    const added = await ok('mutate_scene', addition); assert.equal(added.revision_id, 2);
    assert.deepEqual(added.summary, { added: 1, updated: 0, removed: 0 });
    assert.equal(added.changes[0].instance_id, 'environment-monitor-01');
    assert.equal(added.provenance.parent_revision, 1); assert.equal(added.provenance.agent, 'mutation-agent');
    assert.deepEqual(await ok('mutate_scene', addition), added);
    await originals(); await mcp.close(); mcp = connect();
    const reopened = await ok('read_scene', { version: 1, scene_id: id }); assert.equal(reopened.scene.instances.length, 10);
    assert.deepEqual(reopened.scene.instances.at(-1).asset, assetRef);
    await originals();
    const move = request(2, [{ op: 'update_instance', instance_id: 'environment-monitor-01', patch: { position: [3, .5, 4], rotation: [0, 90, 0] }, preconditions: { position: [2, 0, 2], asset: assetRef } }]);
    const moved = await ok('mutate_scene', move); assert.equal(moved.revision_id, 3);
    assert.deepEqual(moved.changes[0].fields, ['position', 'rotation']);
    await originals();
    const monitor = (await ok('read_scene', { version: 1, scene_id: id })).scene.instances.at(-1);
    assert.deepEqual(monitor.position, [3, .5, 4]); assert.equal(monitor.name, 'Environment monitor');
    const removal = request(3, [{ op: 'remove_instance', instance_id: 'environment-monitor-01', preconditions: { visible: true } }]);
    const requestPath = join(directory, `${kind}-request.json`); await writeFile(requestPath, JSON.stringify(removal));
    const cliResult = JSON.parse((await cli(process.execPath, [resolve('cli/openindustries.mjs'), 'scenes', 'mutate', requestPath], { env })).stdout);
    assert.equal(cliResult.revision_id, 4); assert.equal(cliResult.summary.removed, 1);
    assert.deepEqual((await backend.read(id)).document.instances, s0.document.instances); await originals();
    assert.deepEqual(await ok('mutate_scene', addition), added, 'Older identical retry resolves the immutable receipt after later edits');
    const reused = await mcp.call('mutate_scene', { ...addition, agent: 'different' }); assert.equal(reused.structuredContent.error.code, 'REQUEST_ID_REUSED');
    const before = await backend.read(id), beforeCounts = await counts();
    /** Failure cannot publish any operation, alter geometry, or advance the scene head. */
    async function bad(operations: unknown[], code: string, index?: number, base = 4): Promise<void> {
      const result = await mcp.call('mutate_scene', request(base, operations));
      assert(result.isError, JSON.stringify(result)); assert.equal(result.structuredContent.error.code, code, JSON.stringify(result));
      if (index !== undefined) { assert.equal(result.structuredContent.error.applied, false); assert.equal(result.structuredContent.error.operation_errors[0].operation_index, index); }
      assert.deepEqual(await backend.read(id), before); assert.deepEqual(await counts(), beforeCounts);
      await assert.rejects(() => backend.read(id, 5), { code: 'SCENE_UNAVAILABLE' });
    }
    await bad([{ ...add, instance: { ...add.instance, id: 'original-0' } }], 'DUPLICATE_INSTANCE', 0);
    await bad([add, { op: 'remove_instance', instance_id: 'missing' }], 'INSTANCE_UNAVAILABLE', 1);
    await bad([add, { op: 'update_instance', instance_id: 'original-1', patch: { position: [1, 2] } }], 'INVALID_REQUEST', 1);
    await bad([add, { op: 'update_instance', instance_id: 'original-1', patch: { position: [0, null, 0] } }], 'INVALID_REQUEST', 1);
    await bad([add, { op: 'update_instance', instance_id: 'original-1', patch: { position: [1e7, 0, 0] } }], 'INVALID_REQUEST', 1);
    await bad([add, { op: 'update_instance', instance_id: 'original-1', patch: { id: 'renamed' } }], 'INVALID_REQUEST', 1);
    await bad([add, { op: 'update_instance', instance_id: 'original-1', patch: {} }], 'INVALID_REQUEST', 1);
    await bad([add, { op: 'update_instance', instance_id: 'original-1', patch: { visible: false }, preconditions: { name: 'wrong name' } }], 'PRECONDITION_FAILED', 1);
    await bad([add, { op: 'add_instance', instance: { ...add.instance, id: 'bad-ref', asset: { kind, version_id: randomUUID() } } }], 'ASSET_UNAVAILABLE', 1);
    await bad([{ ...add, instance: { ...add.instance, asset: { kind: kind === 'local' ? 'cloud' : 'local', version_id: assetRef.version_id } } }], 'ASSET_UNAVAILABLE', 0);
    await bad([{ op: 'remove_instance', instance_id: 'original-0' }], 'ANIMATION_REFERENCE', 0);
    await bad([add], 'CONFLICT', undefined, 2);
    await bad([add], 'INVALID_REQUEST', undefined, 0);
    const missingBase = request(4, [add]) as { base_revision?: number }; delete missingBase.base_revision;
    assert.equal((await mcp.call('mutate_scene', missingBase)).structuredContent.error.code, 'INVALID_REQUEST');
    const noOps = await mcp.call('mutate_scene', request(4, [])); assert.equal(noOps.structuredContent.error.code, 'INVALID_REQUEST');
    await writeFile(requestPath, JSON.stringify(request(2, [add])));
    await assert.rejects(() => cli(process.execPath, ['cli/openindustries.mjs', 'scenes', 'mutate', requestPath], { env }), error => {
      const stderr = (error as { stderr: string }).stderr.trim().split('\n').at(-1)!;
      assert.equal(JSON.parse(stderr).error.code, 'CONFLICT'); return true;
    });
    // One successful batch = one revision; later operations observe earlier operations in that batch.
    const batch = await ok('mutate_scene', request(4, [add, { op: 'update_instance', instance_id: 'environment-monitor-01', patch: { visible: false }, preconditions: { name: 'Environment monitor' } }]));
    assert.equal(batch.revision_id, 5); assert.deepEqual(batch.summary, { added: 1, updated: 1, removed: 0 }); await originals();
    // Existing complete-scene clients can still read and replace a scene after object mutations.
    const full = await ok('read_scene', { version: 1, scene_id: id });
    const replaced = await ok('update_scene', { version: 1, request_id: randomUUID(), scene_id: id, base_revision: 5, agent: 'legacy-full-client', scene: full.scene });
    assert.equal(replaced.revision_id, 6); await originals();
    // Independent writers race on one base: exactly one revision is published.
    const peer = connect();
    const race = await Promise.all([mcp, peer].map((process, i) => process.call('mutate_scene', request(6, [{ op: 'update_instance', instance_id: 'environment-monitor-01', patch: { position: [i, 0, 0] } }]))));
    assert.equal(race.filter(result => !result.isError).length, 1);
    assert.equal(race.find(result => result.isError).structuredContent.error.code, 'CONFLICT');
    assert.equal((await backend.read(id)).revision, 7); await originals();
    // Rebind the same asset ID to a new immutable version and refresh its metadata.
    const revised = structuredClone(asset); revised.source.digest = 'monitor-v2'; revised.parts[0].vertices[3] = 2;
    const replacement = await importAsset(revised);
    await ok('mutate_scene', request(7, [{ op: 'update_instance', instance_id: 'environment-monitor-01', patch: { asset: replacement } }]));
    const rebind = await backend.read(id); assert.equal(rebind.revision, 8);
    assert.equal(rebind.document.instances.at(-1)!.cloudVersionId, replacement.version_id);
    assert.equal(rebind.document.assets.find(entry => entry.id === asset.id)!.dimensions[0], 2);
    await originals();
    const mixed = await mcp.call('mutate_scene', request(8, [{ ...add, instance: { ...add.instance, id: 'old-version-copy' } }]));
    assert.equal(mixed.structuredContent.error.code, 'INVALID_ASSET'); assert.deepEqual(await backend.read(id), rebind);
    const huge = structuredClone(asset); huge.id = 'oversized-monitor'; huge.parts[0].vertices[3] = 2e6;
    const hugeRef = await importAsset(huge);
    const oversized = await mcp.call('mutate_scene', request(8, [{ ...add, instance: { ...add.instance, id: 'oversized', asset: hugeRef } }]));
    assert.equal(oversized.structuredContent.error.code, 'INVALID_SCENE');
    assert.equal(oversized.structuredContent.error.operation_errors[0].operation_index, 0);
    assert.deepEqual(await backend.read(id), rebind); await assert.rejects(() => backend.read(id, 9), { code: 'SCENE_UNAVAILABLE' });
    if (service) {
      const other = await service.account(randomUUID()); const otherConfig = join(directory, 'other.json'); await writeFile(otherConfig, JSON.stringify(other));
      const outsider = startClient({ client: 'outsider' }, { env: { ...env, OI_CLI_CONFIG: otherConfig }, root }); processes.push(outsider);
      const denied = await outsider.call('mutate_scene', request(8, [{ op: 'remove_instance', instance_id: 'environment-monitor-01' }]));
      assert.equal(denied.structuredContent.error.code, 'SCENE_UNAVAILABLE');
    }
    console.log(`PASS ${kind}: public MCP/CLI 9→10→move→9, exact originals/geometry/animation, fresh process, receipts, rollback, preconditions, stale writes, full-update compatibility and concurrent writers.`);
  } finally {
    await Promise.all(processes.map(process => process.close()));
    if (backend instanceof LocalSceneBackend) backend.close();
    await service?.close();
  }
}
try { await suite('local'); await suite('cloud'); }
finally { await rm(directory, { recursive: true, force: true }); }
