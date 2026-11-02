import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { startClient } from './lib/mcp-scene-workflows.mjs';
import { sceneTestService } from './lib/scene-test-service.ts';
import { LocalSceneBackend } from '../server/local-scene-backend.ts';
import { SupabaseSceneBackend, type SceneBackend, type SavedScene } from '../server/scene-backend.ts';
import { executeSceneTool } from '../server/mcp-scenes.ts';
import { conflictDetails } from '../server/scene-conflicts.ts';

const directory = await mkdtemp(join(tmpdir(), 'oi-conflicts-'));
/** Independent public MCP processes exercise the same recovery contract on both stores. */
async function suite(kind: 'local' | 'cloud'): Promise<void> {
  const service = kind === 'cloud' ? await sceneTestService() : null;
  const owner = randomUUID(), session = await service?.account(owner);
  const config = join(directory, `${kind}-auth.json`), root = join(directory, kind);
  if (session) await writeFile(config, JSON.stringify(session));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OI_') && !key.startsWith('ASTRA_'))),
    OI_ROOT: root, OI_SCENE_BACKEND: kind === 'cloud' ? 'supabase' : 'local', OI_SCENE_DATA_DIR: root, OI_SCENE_TOOLS_ENABLED: 'true', OI_CLI_CONFIG: config,
    VITE_SUPABASE_URL: service?.origin ?? '', VITE_SUPABASE_PUBLISHABLE_KEY: service ? 'fixture-public-key' : '' };
  const client = service && session ? createClient(service.origin, 'fixture-public-key', { global: { headers: { Authorization: `Bearer ${session.access_token}` } }, auth: { persistSession: false } }) : null;
  const backend: SceneBackend = client ? new SupabaseSceneBackend(client, owner) : new LocalSceneBackend(root);
  const processes: ReturnType<typeof startClient>[] = [];
  const connect = () => { const process = startClient({ client: 'conflict-test' }, { env, root }); processes.push(process); return process; };
  const first = connect(), second = connect();
  const id = randomUUID();
  const creation = { version: 1, request_id: id, agent: 'conflict-test', scene: { name: 'Concurrent scene', room: { width: 10, depth: 10, height: 3 },
    instances: ['a', 'b'].map(id => ({ id, name: id, asset: { kind: 'example', id: 'cleanroom-desk' }, position: [0, 0, 0], rotation: [0, 0, 0], visible: true })) } };
  /** Fail with the actual structured error instead of obscuring the rejected operation. */
  async function ok(process: typeof first, name: string, args: unknown): Promise<any> {
    const response = await process.call(name, args); assert(!response.isError, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent); return response.structuredContent;
  }
  const read = (process = first) => ok(process, 'read_scene', { version: 1, scene_id: id });
  const snapshots = new Map<number, SavedScene>();
  try {
    const [created, duplicateCreate] = await Promise.all([first, second].map(process => ok(process, 'create_scene', creation)));
    assert.deepEqual(duplicateCreate, created);
    snapshots.set(1, await backend.read(id));
    for (const mode of ['update_scene', 'mutate_scene']) {
      const [a, b] = await Promise.all([read(first), read(second)]);
      assert.equal(a.revision_id, b.revision_id);
      const base = a.revision_id;
      const writes = [a, b].map((snapshot, index) => {
        const common = { version: 1, scene_id: id, base_revision: base, request_id: randomUUID(), agent: 'independent-writer' };
        const position = [base + index, 1, 2];
        if (mode === 'mutate_scene') return { ...common, operations: [{ op: 'update_instance', instance_id: index ? 'b' : 'a', patch: { position }, preconditions: { position: snapshot.scene.instances[index].position } }] };
        const scene = structuredClone(snapshot.scene); scene.instances[index].position = position;
        return { ...common, scene };
      });
      const responses = await Promise.all([first, second].map((process, i) => process.call(mode, writes[i])));
      const winner = responses.findIndex(response => !response.isError), loser = 1 - winner;
      assert.equal(responses.filter(response => !response.isError).length, 1);
      const error = responses[loser].structuredContent.error;
      assert.equal(error.code, 'CONFLICT');
      assert.equal(error.scene_id, id); assert.equal(error.expected_revision, base); assert.equal(error.actual_revision, base + 1);
      assert.equal(error.current_revision, base + 1); assert.equal(error.applied, false); assert.equal(error.base_available, true);
      assert.deepEqual(error.changed_instances, [{ instance_id: winner ? 'b' : 'a', change: 'updated', fields: ['position'] }]);
      assert.deepEqual(error.scene_fields, []);
      const head = await backend.read(id); snapshots.set(head.revision, head);
      // A complete replacement must be rebuilt from the fresh read; changing only its base would overwrite the winner.
      const fresh = await read(second), desired = [base + loser, 1, 2];
      const retry = structuredClone(writes[loser]) as any; retry.request_id = randomUUID(); retry.base_revision = fresh.revision_id;
      if (mode === 'update_scene') { retry.scene = fresh.scene; retry.scene.instances[loser].position = desired; }
      const saved = await ok(second, mode, retry); assert.equal(saved.revision_id, base + 2);
      const recovered = await read();
      assert.deepEqual(recovered.scene.instances[winner].position, [base + winner, 1, 2]);
      assert.deepEqual(recovered.scene.instances[loser].position, desired);
      // Historical receipts, including full replacements, survive new processes and later head revisions.
      const restarted = connect();
      assert.deepEqual(await ok(restarted, mode, writes[winner]), responses[winner].structuredContent);
      const reuse = await restarted.call(mode, { ...writes[winner], base_revision: base + 2 });
      assert.equal(reuse.structuredContent.error.code, 'REQUEST_ID_REUSED');
      const overlap = await first.call('mutate_scene', { version: 1, scene_id: id, request_id: randomUUID(), base_revision: base + 2, agent: 'overlap',
        operations: [{ op: 'update_instance', instance_id: winner ? 'b' : 'a', patch: { position: [99, 0, 0] }, preconditions: { position: a.scene.instances[winner].position } }] });
      assert.equal(overlap.structuredContent.error.code, 'PRECONDITION_FAILED');
      assert.equal((await backend.read(id)).revision, base + 2);
      snapshots.set(base + 2, await backend.read(id));
      const staleOverlap = await first.call('mutate_scene', { version: 1, scene_id: id, request_id: randomUUID(), base_revision: base, agent: 'stale-overlap',
        operations: [{ op: 'update_instance', instance_id: winner ? 'b' : 'a', patch: { position: [99, 0, 0] } }] });
      assert.equal(staleOverlap.structuredContent.error.code, 'CONFLICT');
      // Concurrent delivery of one identical request must return one stable receipt to both callers.
      const duplicate = structuredClone(retry); duplicate.request_id = randomUUID(); duplicate.base_revision = base + 2;
      if (mode === 'mutate_scene') delete duplicate.operations[0].preconditions;
      const duplicates = await Promise.all([first, second].map(process => ok(process, mode, duplicate)));
      assert.deepEqual(duplicates[0], duplicates[1]); assert.equal(duplicates[0].revision_id, base + 3);
      snapshots.set(base + 3, await backend.read(id));
    }
    // Fail after the durable store commits but before a caller can receive success, then advance head.
    for (const mode of ['update_scene', 'mutate_scene']) {
      const before = await read();
      const args: any = { version: 1, scene_id: id, request_id: randomUUID(), base_revision: before.revision_id, agent: 'lost-response' };
      if (mode === 'update_scene') { args.scene = before.scene; args.scene.name = 'Response lost'; }
      else args.operations = [{ op: 'update_instance', instance_id: 'a', patch: { visible: false } }];
      const interrupted = new Proxy(backend, { get(target, property) {
        if (property === 'save') return async (...values: Parameters<SceneBackend['save']>) => { await target.save(...values); throw new Error('Injected lost commit response'); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(() => executeSceneTool(`astra.${mode}`, args, { backend: interrupted, origin: 'http://localhost:5173', signal: AbortSignal.timeout(30000) }), /Injected lost commit response/);
      const committed = await backend.read(id); assert.equal(committed.revision, before.revision_id + 1);
      const next = await read();
      await ok(second, 'update_scene', { version: 1, scene_id: id, request_id: randomUUID(), base_revision: next.revision_id, agent: 'later-writer', scene: { ...next.scene, name: 'Later edit' } });
      const restarted = connect();
      const recovered = await ok(restarted, mode, args); assert.equal(recovered.revision_id, committed.revision);
      assert.deepEqual(await ok(restarted, mode, args), recovered);
      assert.equal((await backend.read(id)).revision, committed.revision + 1);
      snapshots.set(committed.revision, committed);
    }
    assert.deepEqual(await ok(connect(), 'create_scene', creation), created);
    // Store-level CAS still protects writers that both passed the earlier MCP head check.
    const base = await backend.read(id), doc = structuredClone(base.document);
    doc.authoring = { via: 'mcp', agent: 'store-race', parent_revision: base.revision, request_id: randomUUID(), request_digest: '1'.repeat(64) };
    doc.instances[0].rotation = [0, 45, 0]; doc.instances[0].name = 'Renamed'; doc.instances[0].visible = !doc.instances[0].visible;
    const removed = doc.instances.pop()!; doc.instances.push({ ...removed, id: 'c' });
    doc.room = [11, 10, 3]; doc.animation.loop = !doc.animation.loop; doc.assets[0].name = 'Changed metadata';
    const saved = await backend.save(id, base.name + ' renamed', doc, base.revision, doc.authoring.request_id);
    const rejected = structuredClone(doc); rejected.authoring.request_id = randomUUID(); rejected.authoring.request_digest = '2'.repeat(64);
    await assert.rejects(() => backend.save(id, base.name, rejected, base.revision, rejected.authoring.request_id), (error: any) => {
      assert.equal(error.code, 'CONFLICT'); assert.deepEqual(error.details, conflictDetails(id, base.revision, saved, base)); return true;
    });
    assert.deepEqual(conflictDetails(id, base.revision, saved, base).scene_fields, ['name', 'room', 'assets', 'animation', 'instance_order']);
    await assert.rejects(() => backend.save(id, base.name, { ...doc, room: [12, 10, 3] }, base.revision, doc.authoring.request_id), { code: 'REQUEST_ID_REUSED' });
    await assert.rejects(() => backend.save(id, base.name, rejected, saved.revision + 100, randomUUID()), (error: any) => {
      assert.equal(error.code, 'CONFLICT'); assert.equal(error.details.base_available, false); assert.deepEqual(error.details.changed_instances, []); return true;
    });
    const crossScene = await first.call('update_scene', { version: 1, scene_id: randomUUID(), request_id: doc.authoring.request_id, base_revision: 1, agent: 'reuse', scene: (await read()).scene });
    assert.equal(crossScene.structuredContent.error.code, 'REQUEST_ID_REUSED');
    if (client) {
      for (const value of [null, -1]) {
        const invalid = await client.rpc('delete_workspace_scene', { p_id: id, p_expected_revision: value }); assert(invalid.error);
        const write = await client.rpc('save_workspace_scene', { p_id: id, p_name: base.name, p_document: doc, p_expected_revision: value, p_write_id: randomUUID() }); assert(write.error);
      }
      const outsider = await service!.account(randomUUID());
      const other = createClient(service!.origin, 'fixture-public-key', { global: { headers: { Authorization: `Bearer ${outsider.access_token}` } }, auth: { persistSession: false } });
      const hidden = await other.rpc('get_scene_write_receipt', { p_id: id, p_write_id: doc.authoring.request_id }); assert.equal(hidden.data, null);
    } else {
      await assert.rejects(() => backend.save(id, base.name, doc, undefined as any, randomUUID()), { code: 'INVALID_REQUEST' });
    }
    for (const [revision, snapshot] of snapshots) assert.deepEqual(await backend.read(id, revision), snapshot);
    console.log(`PASS ${kind}: concurrent MCP replacements and patches, structured CAS conflicts, disjoint recovery, overlap rejection, lost responses, durable retries, immutable history and request identity.`);
  } finally {
    await Promise.all(processes.map(process => process.close()));
    if (backend instanceof LocalSceneBackend) backend.close();
    await service?.close();
  }
}
try { await suite('local'); await suite('cloud'); }
finally { await rm(directory, { recursive: true, force: true }); }
