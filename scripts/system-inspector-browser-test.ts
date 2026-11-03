import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { meshFingerprint, readSystemInspection } from '../src/lib/system-inspection.ts';
import { hydrateManifest, readManifest } from '../src/lib/workspace.ts';

/** Exercise public import/export, real WebGL picking, IndexedDB recovery and OCCT STEP conversion. */
const server = await createServer({ envFile: false, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
}, server: { host: '127.0.0.1', port: 4192, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.OI_CHROME_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
await mkdir('test-results/system-inspector', { recursive: true });

async function openPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4192/');
  await expect(page.getByRole('button', { name: 'Import OI project', exact: true })).toBeEnabled();
  return page;
}
async function importFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '+ Import project', exact: true }).click();
  await (await chooser).setFiles(file);
}
async function exportFile(page: Page, filename: string): Promise<ReturnType<typeof readManifest>> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export OI project', exact: true }).click();
  const path = `test-results/system-inspector/${filename}`;
  await (await download).saveAs(path);
  return readManifest(JSON.parse(await readFile(path, 'utf8')));
}
try {
  const page = await openPage();
  await importFile(page, 'public/examples/system-inspector.oi.json');
  const inspector = page.getByRole('region', { name: 'System inspector', exact: true });
  const components = inspector.getByLabel('Semantic components');
  const details = inspector.getByRole('article', { name: 'Binding details' });
  await components.getByRole('button', { name: /Irrigation pump/ }).click();
  await expect(details).toHaveAttribute('data-binding-status', 'resolved');
  await expect(details).toContainText('20 W');
  const initialCamera = await page.locator('canvas').getAttribute('data-camera-position');
  await details.getByRole('button', { name: 'Locate Irrigation station / Irrigation pump', exact: true }).click();
  await expect.poll(() => page.locator('canvas').getAttribute('data-camera-position')).not.toBe(initialCamera);
  await expect(page.locator('.inspector .part-select', { hasText: 'Irrigation pump' }).locator('..').locator('..')).toHaveAttribute('open', '');
  // Change inspected semantics, then click the centered pump in actual WebGL.
  // This deliberately tests clicking geometry that was already selected.
  await components.getByRole('button', { name: /Water tank/ }).click();
  await expect(details.getByRole('heading', { name: 'Water tank', exact: true })).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await canvas.click();
  await expect(details.getByRole('heading', { name: 'Irrigation pump', exact: true })).toBeVisible();
  await details.getByRole('button', { name: /Discharges to/ }).click();
  await expect(details.getByRole('heading', { name: 'Irrigation bed', exact: true })).toBeVisible();
  await components.getByRole('button', { name: /Irrigation pump/ }).click();
  await page.screenshot({ path: 'test-results/system-inspector/inspector.png', fullPage: true });
  const exported = await exportFile(page, 'roundtrip.oi.json');
  assert.equal(exported.inspection?.systems[0].targets.length, 3);
  // Reload waits for the same draft persistence path used by normal editing.
  await expect(page.getByLabel('Local draft status')).toHaveText('Local draft saved');
  await page.reload();
  await expect(components.getByRole('button', { name: /Irrigation pump/ })).toBeVisible();
  await components.getByRole('button', { name: /Irrigation pump/ }).click();
  await expect(details).toHaveAttribute('data-binding-status', 'resolved');
  // Invalid sidecars are atomic: existing bindings survive a failed import.
  await importFile(page, { name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'oi.system-inspection', version: 99, systems: [] })) });
  await expect(page.getByRole('alert')).toContainText('Invalid system inspection');
  await expect(components.getByRole('button', { name: /Irrigation pump/ })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  const stale = structuredClone(exported.inspection!); stale.systems[0].targets[1].sourceDigest = 'b'.repeat(64);
  await importFile(page, { name: 'stale.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(stale)) });
  await components.getByRole('button', { name: /Irrigation pump/ }).click();
  await expect(details).toHaveAttribute('data-binding-status', 'stale');
  await expect(details.getByRole('button', { name: /Locate/ })).toHaveCount(0);
  await page.context().close();

  // Real STEP file → browser OCCT worker → exported geometry → binding sidecar → selection.
  const stepPage = await openPage();
  await importFile(stepPage, 'scripts/fixtures/form-workflows/opencode/models/block.step');
  await expect(stepPage.locator('footer [role=status]')).toContainText('Imported 1 asset', { timeout: 120_000 });
  const stepScene = await exportFile(stepPage, 'real-step.oi.json');
  const workspace = hydrateManifest(stepScene, []); const item = workspace.items[0];
  assert.equal(item.asset.source.kind, 'step'); assert.equal(item.asset.parts.length, 1);
  const sidecar = structuredClone(exported.inspection!); const system = sidecar.systems[0];
  system.manifest.geometry = { ...system.manifest.geometry, artifact_id: 'real-block-step', sha256: item.asset.source.digest, format: 'step', producer: 'OpenCascade via occt-import-js', producer_version: '0.0.23' };
  system.manifest.entities = [{ entity_id: 'body-0', selector: 'body-0', kind: 'body', fidelity: 'detailed', source: 'supplied_cad', verified_from_artifact: true }];
  system.manifest.bindings = [{ ...system.manifest.bindings[1], selector: 'body-0', role: 'physical_body', fidelity: 'detailed', source: 'supplied_cad', semantic: { ...system.manifest.bindings[1].semantic, label: 'Real STEP block' } }];
  system.targets = [{ bindingId: 'pump', instanceId: item.id, assetId: item.asset.id, sourceDigest: item.asset.source.digest, meshSha256: await meshFingerprint(item.asset), partId: item.asset.parts[0].id }];
  system.annotations = []; readSystemInspection(sidecar);
  await importFile(stepPage, { name: 'block.bindings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sidecar)) });
  const stepInspector = stepPage.getByRole('region', { name: 'System inspector', exact: true });
  await stepInspector.getByRole('button', { name: /Real STEP block/ }).click();
  await expect(stepInspector.getByRole('article')).toHaveAttribute('data-binding-status', 'resolved');
  await stepInspector.getByRole('button', { name: /Locate/ }).click();
  const realRoundtrip = await exportFile(stepPage, 'real-step-bound.oi.json');
  assert.equal(realRoundtrip.inspection?.systems[0].manifest.geometry.sha256, item.asset.source.digest);
  await stepPage.context().close();
  assert.deepEqual(errors, []);
  console.log('PASS browser: semantic → highlight, real WebGL → semantic, connections, persisted reload/export, atomic invalid/stale sidecars, real OCCT STEP import and sidecar selection.');
} finally { await browser.close(); await server.close(); }
