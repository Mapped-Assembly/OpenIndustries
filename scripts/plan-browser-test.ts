import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const output = process.env.OI_PLAN_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'oi-plan-'));
await mkdir(output, { recursive: true });
const web = await createServer({
  envFile: false,
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
    'import.meta.env.VITE_FORM_GENERATION_ENABLED': JSON.stringify('false'),
  },
  server: { host: '127.0.0.1', port: 4196, strictPort: true },
});
let browser;
try {
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1450, height: 980 }, acceptDownloads: true });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4196/');
  await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
  const input = page.getByLabel('Import files');
  const source = { hardware_ir_version: '0.2', overview: { title: 'Plan fixture' },
    mechanical: { render_dimensions: { x_mm: 1000, y_mm: 1000, z_mm: 2000 } } };
  await input.setInputFiles({ name: 'plan-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await expect(page.locator('.asset')).toHaveCount(1);
  await page.getByRole('group', { name: 'Viewport mode' }).getByRole('button', { name: '2D Plan' }).click();
  await expect(page.getByRole('img', { name: /Metric X Z plan/ })).toBeVisible();
  await expect(page.locator('.oi-plan-object')).toHaveCount(1);
  await page.screenshot({ path: join(output, 'plan-initial.png') });
  const polygon = page.locator('.oi-plan-object polygon').first();
  await polygon.click();
  await expect(page.locator('.oi-plan-object.selected')).toHaveCount(1);
  const xInput = page.locator('.placement').first().locator('input[type=number]').first();
  const before = Number(await xInput.inputValue());
  const bounds = await polygon.boundingBox();
  assert(bounds && bounds.width > 0 && bounds.height > 0);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2, { steps: 7 });
  await page.mouse.up();
  const after = Number(await xInput.inputValue());
  assert(after > before, '2D drag must change the same X coordinate as the workspace editor.');
  const rotation = page.locator('.placement').first().locator('input[type=number]').nth(4);
  const angle = Number(await rotation.inputValue());
  await page.getByRole('button', { name: 'Rotate selected object right' }).click();
  assert.equal(Number(await rotation.inputValue()), angle + 5);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SVG' }).click();
  const exported = await download;
  const svgPath = join(output, 'plan-export.svg');
  await exported.saveAs(svgPath);
  assert.match(String(await readFile(svgPath)), /<svg/);
  await page.getByRole('group', { name: 'Viewport mode' }).getByRole('button', { name: '3D' }).click();
  await expect(page.locator('.viewport canvas')).toHaveCount(1);
  await page.getByRole('group', { name: 'Viewport mode' }).getByRole('button', { name: '2D Plan' }).click();
  assert.equal(Number(await xInput.inputValue()), after, 'Switching renderer must not mutate the workspace.');
  await page.screenshot({ path: join(output, 'plan-edited.png') });
  assert.deepEqual(errors, [], 'Unexpected browser errors.');
  console.log('PASS 2D plan browser toggle, shared selection, X/Z edit, rotation, SVG, 3D round-trip. Evidence: ' + output);
} finally {
  await browser?.close();
  await web.close();
}
