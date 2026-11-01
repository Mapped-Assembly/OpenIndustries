import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { oiEnv } from '../server/oi-environment.mjs';

/** Run a bounded batch against a real stdio server process, isolating operator settings. */
function rpcBatch(entry, environment, requests) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OI_') && !key.startsWith('ASTRA_')));
  const input = requests.map((request, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...request })).join('\n') + '\n';
  const child = spawnSync(process.execPath, [resolve(entry)], {
    env: { ...env, ...environment }, input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, requests.length);
  for (const reply of replies) assert.equal(reply.error, undefined);
  return replies.map(reply => reply.result);
}

/** Form a standard MCP tool request without rewriting its namespace. */
function call(name, args = {}) {
  return { method: 'tools/call', params: { name, arguments: args } };
}

test('canonical environment settings override legacy names, including explicit disabling', () => {
  assert.equal(oiEnv('SCENE_TOOLS_ENABLED', { ASTRA_SCENE_TOOLS_ENABLED: 'true' }), 'true');
  assert.equal(oiEnv('SCENE_TOOLS_ENABLED', { OI_SCENE_TOOLS_ENABLED: 'false', ASTRA_SCENE_TOOLS_ENABLED: 'true' }), 'false');
  assert.equal(oiEnv('GAME_SESSION', { OI_GAME_SESSION: '', ASTRA_GAME_SESSION: 'old-token' }), '');
});

test('new and legacy MCP entry points share saved scenes, receipts and revision conflicts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oi-branding-'));
  try {
    const sceneId = randomUUID();
    const fixture = JSON.parse(readFileSync('scripts/fixtures/cleanroom-scene-request.json', 'utf8'));
    fixture.request_id = sceneId;
    const env = { OI_ROOT: directory, OI_SCENE_BACKEND: 'local', OI_SCENE_DATA_DIR: directory, OI_SCENE_TOOLS_ENABLED: 'true' };
    const [initialized, listed, created, repeated, read, oldError, newError] = rpcBatch('server/openindustries-mcp.mjs', env, [
      { method: 'initialize' }, { method: 'tools/list' },
      call('openindustries.create_scene', fixture), call('astra.create_scene', fixture),
      call('openindustries.read_scene', { version: 1, scene_id: sceneId }),
      call('astra.vision_read_frame', { frame_id: randomUUID() }),
      call('openindustries.vision_read_frame', { frame_id: randomUUID() }),
    ]);
    assert.equal(initialized.serverInfo.name, 'openindustries');
    assert(listed.tools.length > 20);
    assert(listed.tools.every(tool => tool.name.startsWith('openindustries.')));
    assert.equal(new Set(listed.tools.map(tool => tool.name)).size, listed.tools.length);
    assert.equal(created.isError, undefined, JSON.stringify(created));
    assert.equal(created.structuredContent.revision_id, 1);
    assert.deepEqual(repeated, created);
    assert.equal(read.structuredContent.scene_id, sceneId);
    assert.equal(oldError.isError, true);
    assert.deepEqual(newError, oldError);
    const update = { version: 1, scene_id: sceneId, base_revision: 1, request_id: randomUUID(), agent: 'branding-test',
      scene: { ...read.structuredContent.scene, name: 'OpenIndustries renamed scene' } };
    const legacyEnv = { ASTRA_ROOT: directory, ASTRA_SCENE_BACKEND: 'local', ASTRA_SCENE_DATA_DIR: directory, ASTRA_SCENE_TOOLS_ENABLED: 'true' };
    const [legacyListed, reopened, updated, retry, conflict, pinned] = rpcBatch('server/astra-mcp.mjs', legacyEnv, [
      { method: 'tools/list' },
      call('astra.read_scene', { version: 1, scene_id: sceneId }),
      call('openindustries.update_scene', update), call('astra.update_scene', update),
      call('openindustries.update_scene', { ...update, request_id: randomUUID() }),
      call('openindustries.read_scene', { version: 1, scene_id: sceneId, revision_id: 1 }),
    ]);
    assert.deepEqual(legacyListed.tools, listed.tools.map(tool => ({ ...tool,
      name: tool.name.replace(/^openindustries\./, 'astra.') })));
    assert.deepEqual(reopened, read);
    assert.equal(updated.structuredContent.revision_id, 2);
    assert.deepEqual(retry, updated);
    assert.equal(conflict.structuredContent.error.code, 'CONFLICT');
    assert.deepEqual(pinned, read);
    const [disabled] = rpcBatch('server/openindustries-mcp.mjs', { ...legacyEnv, OI_SCENE_TOOLS_ENABLED: 'false' }, [
      call('openindustries.list_scene_assets', { version: 1 }),
    ]);
    assert.equal(disabled.structuredContent.error.code, 'DISABLED');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('new CLI and compatibility entry point expose the product name', () => {
  for (const entry of ['cli/openindustries.mjs', 'cli/astra.mjs']) {
    const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^OpenIndustries CLI/);
    assert.match(result.stdout, /openindustries rooms validate/);
  }
});
