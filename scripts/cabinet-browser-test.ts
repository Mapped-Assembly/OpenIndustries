/** Exercise both actual cabinet fixtures, preflight, controller motion and read-only replay. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { runWorkspace, type RunSnapshot } from '../src/lib/embodied-scene';

const source=process.env.SO101_SOURCE_ROOT;
if(!source)throw Error('Set SO101_SOURCE_ROOT to the pinned upstream checkout.');
const evidence='deliverables/cabinet';mkdirSync(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.ASTRA_CHROME_PATH?{executablePath:process.env.ASTRA_CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const reports:unknown[]=[];
try {
  for(const fixture of ['joint','packaged']) {
    const directory=mkdtempSync(join(tmpdir(),'oi-cabinet-'));
    const child=spawn(process.env.PYTHON??'python3',['scripts/embodied_runtime.py','--source',resolve(source),'--state-dir',directory,'--port','0','--cabinet-fixture',fixture],{stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v);
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    try {
      for(let i=0;i<200&&!output.includes('Embodied workbench:');i++) {
        if(child.exitCode!==null)throw Error(errors);
        await new Promise(done=>setTimeout(done,100));
      }
      const origin=/http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];if(!origin)throw Error('Startup timeout '+errors);
      assert.equal((await fetch(origin+'/api/embodied/trace')).status,401);
      const page=await context.newPage(),pageErrors:string[]=[];
      page.on('pageerror',e=>pageErrors.push(e.message));
      const posts:string[]=[];page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
      await page.goto(origin+'/?run=so101');
      await expect(page.getByRole('button',{name:'Enter Run mode'})).toBeEnabled({timeout:20000});
      const first:RunSnapshot=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
      assert.equal(first.cabinet?.inventory.length,fixture==='joint'?3:17);
      const panel=fixture==='joint'?'base_panel':'bottom_panel';
      await page.getByLabel('Selected object').selectOption(panel);
      await page.getByRole('button',{name:'Check lift requirements'}).click();
      await expect(page.getByTestId('preflight')).toContainText('UNKNOWN_LOAD_LIMIT');
      await expect(page.getByTestId('preflight')).toContainText('UNSUPPORTED_CAPABILITY');
      await page.getByRole('button',{name:'Enter Run mode'}).click();
      if(fixture==='packaged') {
        await page.getByLabel('Task',{exact:true}).fill('approach selected');
        await page.getByRole('button',{name:'Send',exact:true}).click();
        await expect(page.getByRole('status')).toContainText('needs_review');
        await expect(page.getByLabel('Conversation')).toContainText('PACKAGE_ACCESS_BLOCKED');
        await page.getByLabel('Selected object').selectOption('box_lid');
      }
      await page.getByLabel('Task',{exact:true}).fill('approach selected');
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await expect(page.getByRole('status')).toContainText('running',{timeout:10000});
      await expect(page.getByRole('status')).toContainText('completed',{timeout:15000});
      const live:RunSnapshot=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
      assert.deepEqual(live.objects,first.objects);
      await page.reload();
      await expect(page.getByRole('status')).toContainText('completed');
      await page.getByRole('button',{name:'Inspect recorded states'}).click();
      await expect(page.getByRole('status')).toHaveText('REPLAY · read only');
      const beforeReplay=posts.length;
      await expect(page.getByTestId('state-id')).toHaveText(`${first.run_id}:0`);
      await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
      await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeDisabled();
      const trace=await page.evaluate(async()=> (await fetch('/api/embodied/trace')).json());
      assert(trace.complete);assert(trace.states.length>5);
      await page.getByLabel('Recorded state',{exact:true}).fill(String(trace.states.length-1));
      await expect(page.getByTestId('state-id')).toHaveText(live.dataset_state!.state_id);
      await page.screenshot({path:`${evidence}/${fixture}-closed.png`,fullPage:true});
      await page.getByLabel('Reveal contents (view only)').check();
      await page.screenshot({path:`${evidence}/${fixture}.png`,fullPage:true});
      assert.equal(posts.length,beforeReplay,'replay or presentation dispatched a command');
      const replayed={...trace.states.at(-1),cabinet:trace.fixture};
      assert.deepEqual(runWorkspace(live,{}),runWorkspace(replayed,{}));
      // Verify actual vertex-world transforms for rotated components, not only JSON equality.
      const basis=new Matrix4().set(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1);
      const workspace=runWorkspace(live,{});
      for(const object of live.objects) {
        const item=workspace.items.find(i=>i.id===object.id)!;
        const bounds=new Box3();const transform=new Matrix4().compose(new Vector3(...item.position),new Quaternion().setFromEuler(new Euler(...item.rotation.map(v=>v*Math.PI/180) as [number,number,number])),new Vector3(1,1,1));
        for(const part of item.asset.parts)for(let i=0;i<part.vertices.length;i+=3)bounds.expandByPoint(new Vector3(...part.vertices.slice(i,i+3) as [number,number,number]).applyMatrix4(transform));
        assert(bounds.getCenter(new Vector3()).distanceTo(new Vector3(...object.position_m).applyMatrix4(basis))<1e-6,object.id+' world centre');
      }
      const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export trace',exact:true}).click();
      const file=await download;await file.saveAs(`${evidence}/${fixture}-trace.json`);
      assert.equal(JSON.parse(readFileSync(`${evidence}/${fixture}-trace.json`,'utf8')).final_state_id,live.dataset_state!.state_id);
      assert.deepEqual(pageErrors,[]);
      reports.push({fixture,run_id:live.run_id,state_count:trace.states.length,inventory_count:trace.fixture.inventory.length,final_state_id:trace.final_state_id,preflight_blocked:true,approach_completed:true,replay_dispatches:0,physical_validation:false,assembly_status:'not_executed'});
    } finally {
      await context.close();
      if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}
      rmSync(directory,{recursive:true,force:true});
    }
  }
  writeFileSync(`${evidence}/browser-checks.json`,JSON.stringify(reports,null,2));
  console.log('PASS both cabinet fixtures: inventory, blocked lifts/access, real approach, reload, state/actuator replay, transformed geometry and trace download');
} finally {await browser.close();}
