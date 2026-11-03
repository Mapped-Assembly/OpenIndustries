import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

/** Browser contract: synthetic POV PNG/GIF, mounted transform, and paired evidence. */
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1400,height:900},acceptDownloads:true});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));

/** Download a fully realized Blob-backed capture without guessing object URLs. */
async function download(link) {
  const item=page.waitForEvent('download');
  await link.click();
  const result=await item;
  const stream=await result.createReadStream();
  const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  return Buffer.concat(chunks);
}
try{
  await page.goto('http://127.0.0.1:8787');
  await page.locator('canvas').waitFor();
  // Canvas mounting precedes async draft/auth restoration; importing while busy
  // causes load() to return without processing any file.
  await expect(page.getByRole('button',{name:'+ Import project',exact:true})).toBeEnabled({timeout:20000});
  const fixture={name:'pov-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({
    hardware_ir_version:'0.2',overview:{title:'POV camera fixture'},
    mechanical:{render_dimensions:{x_mm:750,y_mm:620,z_mm:540}},
  }))};
  await page.getByLabel('Import files').setInputFiles([fixture]);
  await expect(page.locator('.asset')).toHaveCount(1,{timeout:20000});
  await expect(page.locator('footer [role=status]')).toContainText('Imported 1 asset(s)',{timeout:20000});
  await page.getByRole('button',{name:'POV',exact:true}).click();
  await expect.poll(()=>page.locator('canvas').getAttribute('data-camera-mode')).toBe('pov');
  await page.getByRole('button',{name:'GIF studio',exact:true}).click();
  const studio=page.getByRole('region',{name:'GIF studio',exact:true});
  await studio.getByRole('button',{name:'POV capture'}).click();
  await studio.getByLabel('GIF resolution').selectOption('320');
  await studio.getByLabel('Duration').selectOption('2');
  await studio.getByLabel('POV camera name').fill('Inspection POV');
  await studio.getByRole('button',{name:'Save current POV'}).click();
  await expect(studio.getByRole('status',{name:'POV capture status'})).toContainText('Saved camera');
  await studio.getByRole('button',{name:'Capture POV PNG'}).click();
  await expect(studio.getByRole('status',{name:'POV capture status'})).toContainText('PNG ready',{timeout:90000});
  const png=await download(studio.getByRole('link',{name:'Download POV media'}));
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const pngMetadata=JSON.parse((await download(studio.getByRole('link',{name:'Download POV evidence'}))).toString());
  assert.equal(pngMetadata.sourceClassification,'synthetic_scene_render');
  assert.equal(pngMetadata.mediaType,'image/png');
  assert.equal(pngMetadata.frames.length,1);
  assert.match(pngMetadata.sceneSha256,/^[a-f0-9]{64}$/);
  assert.equal(pngMetadata.preset.binding.kind,'worldPose');
  assert.equal(pngMetadata.assets.length,1);
  assert.match(pngMetadata.mediaSha256,/^[a-f0-9]{64}$/);
  const originalCamera=pngMetadata.frames[0].position.map(value=>value.toFixed(3)).join(',');
  const povCanvas=page.locator('.oi-pov-viewport canvas');
  await povCanvas.evaluate(element=>element.focus());
  await page.keyboard.down('w'); await page.waitForTimeout(300); await page.keyboard.up('w');
  await expect.poll(()=>povCanvas.getAttribute('data-camera-position')).not.toBe(originalCamera);
  await studio.getByRole('button',{name:'Use saved POV in viewer'}).click();
  await expect.poll(()=>povCanvas.getAttribute('data-camera-position')).toBe(originalCamera);

  await studio.getByLabel('POV export format').selectOption('static-gif');
  await studio.getByRole('button',{name:'Render POV GIF'}).click();
  await expect(studio.getByRole('status',{name:'POV capture status'})).toContainText('GIF ready',{timeout:90000});
  const gif=await download(studio.getByRole('link',{name:'Download POV media'}));
  assert.equal(gif.subarray(0,6).toString(),'GIF89a');
  const gifMetadata=JSON.parse((await download(studio.getByRole('link',{name:'Download POV evidence'}))).toString());
  assert.equal(gifMetadata.pov.sourceClassification,'synthetic_scene_render');
  assert.equal(gifMetadata.pov.frames.length,20);
  assert.equal(gifMetadata.pov.sceneSha256,pngMetadata.sceneSha256);
  assert.match(gifMetadata.pov.mediaSha256,/^[a-f0-9]{64}$/);

  // Bind a second camera to a real selected scene instance; no invented hardware frames.
  await page.locator('.asset').first().click();
  await studio.getByLabel('POV camera name').fill('Mounted fixture');
  await studio.getByRole('button',{name:'Save selected instance camera'}).click();
  await studio.getByLabel('POV export format').selectOption('png');
  await studio.getByRole('button',{name:'Capture POV PNG'}).click();
  await expect(studio.getByRole('status',{name:'POV capture status'})).toContainText('PNG ready',{timeout:90000});
  const attached=JSON.parse((await download(studio.getByRole('link',{name:'Download POV evidence'}))).toString());
  assert.equal(attached.preset.binding.kind,'attachedPose');
  assert.equal(attached.frames[0].parentInstanceId,attached.assets[0].instanceId);
  assert.deepEqual(errors,[]);
  console.log('PASS POV screenshot, fixed GIF, source metadata, and selected-instance attachment; no page errors.');
}finally{await browser.close();}
