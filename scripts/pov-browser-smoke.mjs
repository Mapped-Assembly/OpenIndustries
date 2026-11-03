import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

/**
 * Browser-level check for the first-person viewport. Run against an already
 * started local production server (npm run build && npm start).
 */
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:8787/?scene=cleanroom');
  await page.locator('canvas').waitFor();
  await page.getByRole('button', { name: 'POV', exact: true }).click();
  const canvas = page.locator('.oi-pov-viewport canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.getAttribute('data-camera-mode')).toBe('pov');
  const starting = await canvas.getAttribute('data-camera-position');
  assert.ok(starting, 'POV exposes a camera pose for inspection');

  // Focus the viewport while avoiding reliance on browser pointer-lock policy.
  await canvas.evaluate(element => element.focus());
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  const moved = await canvas.getAttribute('data-camera-position');
  assert.notEqual(starting, moved, 'W should change the camera position');

  await page.getByRole('button', { name: '2D Plan' }).click();
  await expect(page.getByLabel('Interactive 2D floor plan')).toBeVisible();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect.poll(() => page.locator('canvas').getAttribute('data-camera-mode')).toBe('orbit');
  await page.getByRole('button', { name: 'POV', exact: true }).click();
  await expect.poll(() => page.locator('canvas').getAttribute('data-camera-mode')).toBe('pov');
  const returned = await page.locator('canvas').getAttribute('data-camera-position');
  assert.equal(returned, moved, 'a POV pose should survive switching through Plan');

  await page.getByRole('button', { name: 'Reset POV' }).click();
  const reset = await page.locator('canvas').getAttribute('data-camera-position');
  await expect.poll(() => page.locator('canvas').getAttribute('data-camera-position')).not.toBe(moved);
  assert.notEqual(reset, moved, 'reset should return to a new valid spawn');

  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect.poll(() => page.locator('canvas').getAttribute('data-camera-mode')).toBe('orbit');
  await expect(page.getByRole('button', { name: 'POV', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('Width', { exact: true })).toHaveValue(/^[0-9.]+$/);
  assert.deepEqual(errors, [], 'no uncaught browser exceptions');
  console.log('PASS POV keyboard movement, switching through 2D Plan, camera restoration and reset.');
} finally {
  await browser.close();
}
