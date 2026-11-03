import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

/** Exercise the shared 3D viewer and real mounted camera controls with a generated scene fixture. */
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1450,height:950},acceptDownloads:true});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:8787');
  await page.locator('canvas').waitFor();
  // Asynchronous local-draft hydration can briefly disable imports after the canvas mounts.
  await expect(page.getByRole('button',{name:'+ Import project',exact:true})).toBeEnabled({timeout:25000});
  const fixture={name:'robot-camera-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({
    hardware_ir_version:'0.2',
    overview:{title:'Robot camera fixture'},
    mechanical:{render_dimensions:{x_mm:500,y_mm:600,z_mm:400}},
  }))};
  await page.getByLabel('Import files').setInputFiles([fixture]);
  await expect(page.locator('.asset')).toHaveCount(1,{timeout:20000});
  await page.getByRole('button',{name:'Mounted POV',exact:true}).click();

  const canvas=page.locator('.oi-mounted-viewport canvas');
  const controls=page.getByRole('group',{name:'Attached camera controls'});
  await expect(controls).toBeVisible();
  await expect.poll(()=>canvas.getAttribute('data-camera-mode')).toBe('mounted');
  await expect.poll(()=>canvas.getAttribute('data-camera-status')).toBe('unbound');
  await controls.getByLabel('Camera parent instance').selectOption({index:1});
  const pinnedParent=await controls.getByLabel('Camera parent instance').inputValue();
  await expect.poll(()=>canvas.getAttribute('data-camera-status')).toBe('bound');
  const before=await canvas.getAttribute('data-camera-position');
  await controls.getByLabel('Camera offset X').fill('0.6');
  await expect.poll(()=>canvas.getAttribute('data-camera-position')).not.toBe(before);
  await controls.getByLabel('Camera yaw').fill('30');
  await controls.getByLabel('Mounted camera FOV').fill('60');
  await expect(controls.getByLabel('Mounted camera FOV')).toHaveValue('60');
  const frame=controls.getByLabel('Camera mount frame');
  await expect(frame.locator('option')).not.toHaveCount(0);
  if(await frame.locator('option').count()>1){
    await frame.selectOption({index:1});
    await expect.poll(()=>canvas.getAttribute('data-camera-status')).toBe('bound');
  }

  // The same mounted viewpoint is consumable by the #105 capture/preset workflow.
  await page.getByRole('button',{name:'GIF studio',exact:true}).click();
  const studio=page.getByRole('region',{name:'GIF studio',exact:true});
  await studio.getByRole('button',{name:'POV capture'}).click();
  await studio.getByLabel('POV camera name').fill('Robot wrist camera');
  await studio.getByRole('button',{name:'Save current mounted camera'}).click();
  await expect(studio.getByRole('status',{name:'POV capture status'})).toContainText('Saved camera');
  await page.getByRole('button',{name:'3D',exact:true}).click();
  await expect.poll(()=>page.locator('canvas').getAttribute('data-camera-mode')).toBe('orbit');
  await studio.getByRole('button',{name:'Use saved POV in viewer'}).click();
  await expect.poll(()=>page.locator('canvas').getAttribute('data-camera-mode')).toBe('mounted');
  await expect.poll(()=>page.locator('canvas').getAttribute('data-camera-status')).toBe('bound');

  // Removing its parent cannot silently move the mounted camera to another item.
  await studio.getByRole('button',{name:'Close GIF studio'}).click();
  await page.getByRole('button',{name:'Delete instance'}).click();
  await expect(page.locator('.asset')).toHaveCount(0);
  await expect.poll(()=>page.locator('canvas').getAttribute('data-camera-status')).toBe('unbound');
  await expect(page.locator('.oi-mounted-indicator')).toContainText(/missing|unavailable|unbound/i);
  await expect(controls.getByLabel('Camera parent instance')).toHaveValue(pinnedParent);

  await page.getByRole('button',{name:'3D',exact:true}).click();
  await expect.poll(()=>page.locator('canvas').getAttribute('data-camera-mode')).toBe('orbit');
  await page.getByRole('button',{name:'POV',exact:true}).click();
  await expect.poll(()=>page.locator('canvas').getAttribute('data-camera-mode')).toBe('pov');
  assert.deepEqual(errors,[]);
  console.log('PASS mounted POV: explicit binding, local offset/angle, saved rig restoration, identity loss, orbit/free POV, no page errors.');
}finally {await browser.close();}
