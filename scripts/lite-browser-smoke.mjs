import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

/**
 * Synthetic 60-asset/79-instance stress regression for #97.
 * This deliberately does NOT claim to be the user's original CAD kitchen.
 * All comparisons use one scene, viewport and browser instance.
 */
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const fixture=readFileSync('benchmarks/kitchen-lite/79-instance-synthetic.oi.json');
async function download(link) {
  const event=page.waitForEvent('download');await link.click();
  const result=await event;const stream=await result.createReadStream();
  const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  return Buffer.concat(chunks);
}
/** Read GPU resource and CPU-side render counts directly from the active WebGL viewer. */
async function metrics() {
  return page.locator('.viewport canvas').evaluate(element=>({
    profile:element.dataset.renderProfile,
    frames:Number(element.dataset.renderFrames??0),
    drawCalls:Number(element.dataset.drawCalls??0),
    gpuGeometryCount:Number(element.dataset.gpuGeometryCount??0),
    cpuFrameMs:Number(element.dataset.lastCpuFrameMs??0),
    maxCpuFrameMs:Number(element.dataset.maxCpuFrameMs??0),
    instances:Number(element.dataset.sceneInstances??0),
    width:element.clientWidth,height:element.clientHeight,
  }));
}
try{
  await mkdir('test-results',{recursive:true});
  const open=performance.now();
  await page.goto('http://127.0.0.1:8787');
  await page.locator('.viewport canvas').waitFor();
  await expect(page.getByRole('button',{name:'+ Import project',exact:true})).toBeEnabled({timeout:25000});
  await page.getByLabel('Import OI project file').setInputFiles({
    name:'kitchen-lite.oi.json',mimeType:'application/json',buffer:fixture,
  });
  await expect(page.locator('.asset')).toHaveCount(79,{timeout:30000});
  const canvas=page.locator('.viewport canvas');
  await expect.poll(()=>canvas.getAttribute('data-render-profile')).toBe('lite');
  await expect.poll(()=>canvas.getAttribute('data-scene-instances')).toBe('79');
  await expect.poll(()=>canvas.getAttribute('data-gpu-geometry-count')).toBe('60');
  await expect(page.getByLabel('3D render profile')).toHaveValue('lite');
  await page.evaluate(()=>document.querySelector('.viewport canvas').dataset.identityProbe='same-canvas');
  await page.screenshot({path:'test-results/lite-kitchen-initial.png'});
  // Warm the first profile: the orbit damping loop should eventually become idle.
  await page.waitForTimeout(800);
  const liteStart=await metrics();
  await page.waitForTimeout(550);
  const liteEnd=await metrics();
  assert.ok(liteEnd.frames-liteStart.frames<=3,
    `Lite must idle in static scenes (observed ${liteEnd.frames-liteStart.frames} new frames)`);

  await page.getByRole('button',{name:'Capture Lite PNG'}).click();
  await expect(page.getByRole('link',{name:'Download Lite PNG'})).toBeVisible({timeout:20000});
  const png=await download(page.getByRole('link',{name:'Download Lite PNG'}));
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(png.length>3000,'the captured scene must not be a trivial empty PNG');
  const meta=JSON.parse((await download(page.getByRole('link',{name:'Download Lite metadata'}))).toString('utf8'));
  assert.equal(meta.instances.length,79);
  assert.equal(new Set(meta.instances.map(x=>x.assetId)).size,60);
  assert.equal(meta.sourceClassification,'synthetic_scene_render');
  assert.equal(meta.renderProfile,'lite');
  assert.equal(meta.width,480);
  assert.match(meta.sceneSha256,/^[a-f0-9]{64}$/);
  assert.match(meta.mediaSha256,/^[a-f0-9]{64}$/);
  assert.ok(meta.performance.drawCalls>0,'draw calls must be measured');
  assert.ok(meta.performance.gpuGeometries>0,'WebGL must upload visible geometries');

  await page.getByLabel('3D render profile').selectOption('detailed');
  await expect.poll(()=>canvas.getAttribute('data-render-profile')).toBe('detailed');
  await expect(canvas).toHaveAttribute('data-identity-probe','same-canvas');
  await expect.poll(()=>canvas.getAttribute('data-gpu-geometry-count')).toBe('60');
  await page.waitForTimeout(500);
  const detailedStart=await metrics();
  await page.waitForTimeout(500);
  const detailedEnd=await metrics();
  assert.ok(detailedEnd.frames-detailedStart.frames>3,
    'Detailed mode preserves the existing live rendering loop');
  await page.screenshot({path:'test-results/lite-kitchen-detailed.png'});
  await page.getByLabel('3D render profile').selectOption('lite');
  await expect.poll(()=>canvas.getAttribute('data-render-profile')).toBe('lite');
  await expect(canvas).toHaveAttribute('data-identity-probe','same-canvas');
  assert.equal(detailedEnd.drawCalls,liteEnd.drawCalls,
    'Lite and Detailed must account for the same visible geometry and occlusion from the same camera');

  // After measuring the identical scene/camera, edit precisely one instance.
  const selection=page.locator('.asset').first();
  await selection.click();
  await expect(page.getByLabel('Prep table 1 X position')).toBeVisible();
  await page.getByLabel('Prep table 1 X position').fill('-6.900');
  await expect.poll(()=>canvas.getAttribute('data-scene-instances')).toBe('79');
  await expect(canvas).toHaveAttribute('data-identity-probe','same-canvas');

  // Check original instance and asset identities after a single instance edit.
  const serialized=JSON.parse((await download(page.getByRole('button',{name:'Export OI project'}))).toString('utf8'));
  const original=JSON.parse(fixture.toString('utf8'));
  assert.equal(serialized.instances.length,79);
  assert.equal(new Set(serialized.instances.map(x=>x.assetId)).size,60);
  const changed=serialized.instances.filter((inst,i)=>JSON.stringify(inst.position)!==JSON.stringify(original.instances[i].position));
  assert.equal(changed.length,1,'only the selected asset instance must move');
  assert.equal(changed[0].id,original.instances[0].id);
  assert.deepEqual(serialized.instances.map(x=>x.id),original.instances.map(x=>x.id));
  assert.deepEqual(serialized.instances.map(x=>x.assetId),original.instances.map(x=>x.assetId));
  const result={
    fixture:'synthetic_60_assets_79_instances_not_original_kitchen',
    elapsedToSceneReadyMs:performance.now()-open,
    liteStaticFramesOver550ms:liteEnd.frames-liteStart.frames,
    detailedFramesOver500ms:detailedEnd.frames-detailedStart.frames,
    sameCameraLite:liteEnd,sameCameraDetailed:detailedEnd,
    screenshot:{bytes:png.length,sha256:meta.mediaSha256,cpuRasterAndReadMs:meta.performance.cpuRasterAndReadMs},
    browser:await browser.version(),
  };
  await writeFile('test-results/lite-kitchen-metrics.json',JSON.stringify(result,null,2));
  assert.deepEqual(errors,[]);
  console.log('PASS Lite KITCHEN-LITE-79: 60 asset resources, 79 independent placements, static idle, stable canvas, 480px PNG/evidence, editing, reversible quality, no page errors.');
  console.log(JSON.stringify(result));
}finally{await browser.close();}
