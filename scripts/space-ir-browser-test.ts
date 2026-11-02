import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { compileSpaceIR } from '../src/lib/space-ir-compiler';
import { makeManifest, readManifest } from '../src/lib/workspace';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('../packages/space-ir/fixtures/SPACE-001.json', import.meta.url), 'utf8'));
const result = await compileSpaceIR(fixture);
const portable = readManifest(makeManifest(result.workspace, true));
const evidence = process.env.OI_SPACE_IR_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'oi-space-ir-'));
await mkdir(evidence, { recursive: true });
const web = await createServer({
  envFile: false,
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
    'import.meta.env.VITE_FORM_GENERATION_ENABLED': JSON.stringify('false'),
  },
  server: { host: '127.0.0.1', port: 4197, strictPort: true },
});
let browser;
try {
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto('http://127.0.0.1:4197/');
  await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
  await page.getByLabel('Import OI project file').setInputFiles({
    name: 'SPACE-001.oi.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)),
  });
  const confirm = page.getByRole('dialog', { name: 'Unsaved room changes' });
  if (await confirm.isVisible()) await confirm.getByRole('button', { name: 'Discard and continue' }).click();
  await expect(page.locator('.asset')).toHaveCount(8, { timeout: 15000 });
  await page.getByRole('group', { name: 'Viewport mode' }).getByRole('button', { name: '2D Plan' }).click();
  await expect(page.locator('.oi-plan-object')).toHaveCount(8);
  await page.screenshot({ path: join(evidence, 'SPACE-001-plan.png') });
  const first = page.locator('.oi-plan-object').first();
  await first.locator('polygon').click();
  await expect(page.locator('.oi-plan-object.selected')).toHaveCount(1);
  const selectedId = await first.getAttribute('data-instance-id');
  assert(selectedId && portable.instances.some(i => i.id === selectedId));
  await page.getByRole('group', { name: 'Viewport mode' }).getByRole('button', { name: '3D' }).click();
  await expect(page.locator('.viewport canvas')).toHaveCount(1);
  await page.screenshot({ path: join(evidence, 'SPACE-001-3d.png') });
  await page.getByRole('group', { name: 'Viewport mode' }).getByRole('button', { name: '2D Plan' }).click();
  await expect(page.locator('.oi-plan-object.selected')).toHaveCount(1);
  assert.deepEqual(errors, []);
  console.log('PASS SPACE-001 UI import, 2D/3D render, same instance selection. Evidence: ' + evidence);
} finally {
  await browser?.close();
  await web.close();
}
