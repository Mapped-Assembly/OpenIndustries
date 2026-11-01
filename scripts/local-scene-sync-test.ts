import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as tcpServer } from 'node:net';
import { createServer } from 'vite';
import { chromium, expect, type Page } from '@playwright/test';
import { startClient } from './lib/mcp-scene-workflows.mjs';
import { canonicalJSON, type SceneManifest } from '../src/lib/workspace.ts';
import { oiEnv } from '../server/oi-environment.mjs';

const directory = await mkdtemp(join(tmpdir(), 'oi-scene-sync-'));
const env = { ...process.env, OI_ROOT: directory, OI_SCENE_BACKEND: 'local', OI_SCENE_DATA_DIR: directory, OI_SCENE_TOOLS_ENABLED: 'true', VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' };
const reserve = tcpServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const apiPort = (reserve.address() as { port: number }).port; await new Promise<void>(resolveClose => reserve.close(() => resolveClose()));
const apiURL = `http://127.0.0.1:${apiPort}`;
/** Send exact request headers; fetch may normalize Host. */
async function statusWithHeaders(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest(`${apiURL}${path}`, { headers }, response => { response.resume(); resolveStatus(response.statusCode!); });
    request.on('error', reject); request.end();
  });
}
let api: ChildProcess | undefined;
/** Start the production HTTP service against the same disk store as independent MCP. */
async function startAPI(): Promise<void> {
  api = spawn(process.execPath, ['server/index.mjs'], { env: { ...env, PORT: String(apiPort) }, stdio: 'pipe' });
  api.stdout!.resume(); api.stderr!.resume();
  await expect.poll(async () => { try { return (await fetch(`${apiURL}/api/local-scenes/${randomUUID()}/head`)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(404);
}
/** Stop cleanly so the next process proves persisted data can be reopened. */
async function stopAPI(): Promise<void> { if (api && api.exitCode === null) { const done = once(api, 'exit'); api.kill(); await done; } }
const mcp = startClient({ request_ids: 'string', client: 'sync-test' }, { env, root: directory });
/** Read both standard MCP representations and reject protocol/tool errors. */
async function call(name: string, args: unknown): Promise<any> {
  const result = await mcp.call(name, args);
  assert(!result.isError, JSON.stringify(result));
  const text = JSON.parse(result.content.find((block: { type: string }) => block.type === 'text').text);
  assert.deepEqual(text, result.structuredContent); return text;
}
const web = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': apiURL } } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'browser-sync-test', version: '1' } });
  const created = await call('create_scene', { version: 1, request_id: randomUUID(), agent: 'sync-fixture', scene: {
    name: 'Nine-object monitoring station baseline', room: { width: 12, depth: 12, height: 3 },
    instances: Array.from({ length: 9 }, (_, index) => ({ id: `original-${index}`, name: `Original ${index}`, asset: { kind: 'example', id: 'cleanroom-desk' }, position: [(index % 3) * 3 - 3, 0, Math.floor(index / 3) * 3 - 3], rotation: [0, index * 5, 0], visible: index !== 8 })),
  } });
  const id = created.scene_id;
  const initial = await call('read_scene', { version: 1, scene_id: id });
  await startAPI(); await web.listen();
  const webURL = `http://127.0.0.1:${(web.httpServer!.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, ...(oiEnv('CHROME_PATH') ? { executablePath: oiEnv('CHROME_PATH') } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), pinned = await context.newPage();
  const errors: string[] = []; context.on('page', p => p.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message)); pinned.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  /** Export through the visible UI so equality checks cover the displayed workspace. */
  async function exported(p: Page): Promise<SceneManifest> {
    const download = p.waitForEvent('download'); await p.getByRole('button', { name: 'Export local draft', exact: true }).click();
    const path = join(directory, `${randomUUID()}.json`); await (await download).saveAs(path);
    return JSON.parse(await readFile(path, 'utf8'));
  }
  /** Commit a new head using a separate stdio MCP process, never the browser API. */
  async function update(edit: (scene: any) => void): Promise<number> {
    const head = await call('read_scene', { version: 1, scene_id: id }); edit(head.scene);
    const result = await call('update_scene', { version: 1, request_id: randomUUID(), agent: 'independent-agent', scene_id: id, base_revision: head.revision_id, scene: head.scene });
    return result.revision_id;
  }
  await page.goto(`${webURL}/?localSceneId=${id}`);
  await pinned.goto(`${webURL}/?localSceneId=${id}&revision=1`);
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('1');
  await expect(page.locator('.asset')).toHaveCount(9);
  await expect(pinned.getByTestId('local-loaded-revision')).toHaveText('1');
  const s0 = await exported(page);
  await expect(page.locator('.viewport canvas')).toBeVisible();
  const image0 = await page.locator('.viewport').screenshot();
  const editor = await page.locator('#workspace-panel').elementHandle();
  await call('mutate_scene', { version: 1, request_id: randomUUID(), agent: 'independent-agent', scene_id: id, base_revision: 1,
    operations: [{ op: 'add_instance', instance: { ...initial.scene.instances[0], id: 'environment-monitor-01', name: 'Environment monitor', position: [0, 2, 0], visible: true } }] });
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('2', { timeout: 15000 });
  await expect(page.locator('.asset')).toHaveCount(10);
  assert(await editor!.evaluate(element => element.isConnected), 'App/editor must not remount');
  const s1 = await exported(page);
  assert.deepEqual(s1.instances.slice(0, 9), s0.instances);
  assert.deepEqual(s1.assets, s0.assets);
  const hash = (value: unknown): string => createHash('sha256').update(canonicalJSON(value)).digest('hex');
  assert.equal(hash(s1.bundledVersions), hash(s0.bundledVersions), 'All geometry/version bindings must remain exact');
  const stored = await (await fetch(`${apiURL}/api/local-scenes/${id}`)).json();
  const { authoring: _authoring, ...storedManifest } = stored.document;
  assert.deepEqual(s1, storedManifest);
  assert.notEqual(hash(await page.locator('.viewport').screenshot()), hash(image0), 'The rendered image must change');
  await expect(pinned.getByTestId('local-head-revision')).toHaveText('2');
  assert.deepEqual(await exported(pinned), s0);
  console.log('PASS independent MCP S0→S1: 9→10 displayed/persisted instances; exact original transforms, visibility, versions and geometry; pinned revision; app retained.');

  await page.getByLabel('Original 0 X position', { exact: true }).fill('4.25');
  await update(scene => { scene.instances[1].position[1] = 1; });
  await expect(page.getByTestId('local-sync-state')).toHaveText('Conflict — draft retained');
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Commit browser edits' })).toBeDisabled();
  await expect(page.getByTestId('local-draft-journal')).toHaveText('Recovery draft saved');
  await page.reload();
  await expect(page.getByTestId('local-sync-state')).toHaveText('Conflict — draft retained');
  await expect(page.getByLabel('Original 0 X position', { exact: true })).toHaveValue('4.25');
  await page.getByRole('button', { name: 'Discard edits and load store' }).click();
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('3');
  await page.getByLabel('Original 0 X position', { exact: true }).fill('5.5');
  await expect(page.getByRole('button', { name: 'Commit browser edits' })).toBeEnabled();
  await page.getByRole('button', { name: 'Commit browser edits' }).click();
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('4', { timeout: 15000 });
  assert.equal((await call('read_scene', { version: 1, scene_id: id })).scene.instances[0].position[0], 5.5);
  console.log('PASS dirty conflict, reload recovery, explicit discard and browser→MCP commit.');

  await stopAPI();
  await expect(page.getByTestId('local-sync-state')).toHaveText('Offline — retrying', { timeout: 15000 });
  await page.getByLabel('Original 0 X position', { exact: true }).fill('6.5');
  await update(scene => { scene.instances[2].position[1] = 1; });
  await startAPI();
  await expect(page.getByTestId('local-sync-state')).toHaveText('Conflict — draft retained', { timeout: 15000 });
  await expect(page.getByLabel('Original 0 X position', { exact: true })).toHaveValue('6.5');
  const fresh = await browser.newPage(); await fresh.goto(`${webURL}/?localSceneId=${id}`);
  await expect(fresh.getByTestId('local-loaded-revision')).toHaveText('5'); await fresh.close();
  await page.getByRole('button', { name: 'Discard edits and load store' }).click();
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('5');
  await page.getByRole('button', { name: 'Detach scene', exact: true }).click();
  await update(scene => { scene.instances[3].position[1] = 1; });
  await expect(pinned.getByTestId('local-head-revision')).toHaveText('6');
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('5');
  await page.getByRole('button', { name: 'Reconnect scene' }).click();
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('6');
  console.log('PASS offline edits, restart/reconnect conflict, fresh browser reopening and detach.');

  // Lose the HTTP response after the durable commit and recover the exact request after reload.
  let lost = false;
  await page.route('**/api/local-scenes/*/commit', async route => { await route.fetch(); lost = true; await route.abort('connectionreset'); });
  await page.getByLabel('Original 0 X position', { exact: true }).fill('7.5');
  await page.getByRole('button', { name: 'Commit browser edits' }).click();
  await expect(page.getByRole('button', { name: 'Retry same commit' })).toBeEnabled({ timeout: 15000 });
  assert(lost);
  await page.getByLabel('Original 0 X position', { exact: true }).fill('7.75');
  await expect(page.getByTestId('local-draft-journal')).toHaveText('Recovery draft saved');
  await page.unroute('**/api/local-scenes/*/commit'); await page.reload();
  await expect(page.getByLabel('Original 0 X position', { exact: true })).toHaveValue('7.75');
  await expect(page.getByRole('button', { name: 'Retry same commit' })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry same commit' }).click();
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('7');
  const afterRetry = await call('read_scene', { version: 1, scene_id: id });
  assert.equal(afterRetry.revision_id, 7, 'Retry must not duplicate a revision');
  assert.equal(afterRetry.scene.instances[0].position[0], 7.5);
  await expect(page.getByLabel('Original 0 X position', { exact: true })).toHaveValue('7.75');
  await expect(page.getByTestId('local-sync-state')).toHaveText('Unsaved edits');
  await page.getByRole('button', { name: 'Discard edits and load store' }).click();
  await expect(page.getByLabel('Original 0 X position', { exact: true })).toHaveValue('7.5');

  // A delayed geometry response must not overwrite an edit made after its request began.
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const arrived = new Promise<void>(resolveArrived => { reached = resolveArrived; });
  await page.route('**/api/local-scenes/*?revision=8', async route => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
  await update(scene => { scene.instances[4].position[1] = 1; });
  await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error('Geometry request was not observed')), 15000))]);
  await page.getByLabel('Original 0 X position', { exact: true }).fill('8.5'); release();
  await expect(page.getByTestId('local-sync-state')).toHaveText('Conflict — draft retained');
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('7');
  await expect(page.getByLabel('Original 0 X position', { exact: true })).toHaveValue('8.5');
  await page.unroute('**/api/local-scenes/*?revision=8');

  const commit = { request_id: randomUUID(), base_revision: 7, document: (await exported(page)) };
  const stale = await fetch(`${apiURL}/api/local-scenes/${id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(commit) });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).current_revision, 8);
  assert.equal(await statusWithHeaders(`/api/local-scenes/${id}/head`, { Origin: 'https://evil.invalid' }), 403);
  assert.equal(await statusWithHeaders(`/api/local-scenes/${id}/head`, { Host: 'evil.invalid' }), 403);
  assert.equal(await statusWithHeaders(`/api/local-scenes/${id}/head`, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal((await fetch(`${apiURL}/api/local-scenes/${id}?revision=0`)).status, 400);
  const forged = structuredClone(commit); forged.request_id = randomUUID(); forged.base_revision = 8;
  forged.document.bundledVersions![0].asset.parts[0].vertices[0] += .1;
  const bad = await fetch(`${apiURL}/api/local-scenes/${id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forged) });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'INVALID_ASSET');
  assert.deepEqual((await call('read_scene', { version: 1, scene_id: id, revision_id: 1 })).scene, initial.scene);
  await page.getByRole('button', { name: 'Discard edits and load store' }).click();
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('8');
  await update(scene => { scene.instances.at(-1).asset = { kind: 'example', id: 'cleanroom-robot' }; });
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('9');
  const withRobot = await exported(page);
  const monitor = withRobot.instances.at(-1)!;
  const asset = structuredClone(withRobot.bundledVersions!.find(entry => entry.cloudVersionId === monitor.cloudVersionId)!.asset);
  asset.parts[0].vertices[0] += .2;
  asset.source.digest = hash(asset.parts);
  const file = join(directory, 'monitor-v2.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, asset }));
  const imported = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'cli/local-scenes.ts', 'import-asset', file], { env });
  const version = JSON.parse(imported.stdout);
  await update(scene => { scene.instances.at(-1).asset = version; });
  await expect(page.getByTestId('local-loaded-revision')).toHaveText('10');
  const withReplacement = await exported(page);
  assert.deepEqual(withReplacement.instances.slice(0, 9), withRobot.instances.slice(0, 9));
  assert.notEqual(withReplacement.instances.at(-1)!.cloudVersionId, monitor.cloudVersionId);
  assert.equal(withReplacement.instances.at(-1)!.cloudVersionId, version.version_id);
  assert.deepEqual(withReplacement.bundledVersions!.find(entry => entry.cloudVersionId === version.version_id)!.asset.parts, asset.parts);
  await expect(page.locator('.viewport canvas')).toBeVisible();
  console.log('PASS new asset and same-ID replacement version refresh with complete geometry equality.');
  assert.deepEqual(errors, []);
  console.log('PASS lost-response idempotent retry, in-flight edit protection, atomic stale rejection, origin/host checks and immutable geometry validation.');
} finally {
  await browser?.close(); await web.close(); await stopAPI(); await mcp.close(); await rm(directory, { recursive: true, force: true });
}
