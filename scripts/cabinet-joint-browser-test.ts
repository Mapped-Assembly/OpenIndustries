/** Prove joint motion, Stop/resume and read-only trace replay through the actual OI UI. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { runWorkspace, type RunSnapshot } from '../src/lib/embodied-scene';

const source=process.env.SO101_SOURCE_ROOT;
if(!source)throw Error('Set SO101_SOURCE_ROOT to the pinned upstream checkout.');
const evidence='deliverables/cabinet-joint';mkdirSync(evidence,{recursive:true});
const browser=await chromium.launch({timeout:30000,headless:true,...(process.env.ASTRA_CHROME_PATH?{executablePath:process.env.ASTRA_CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const directory=mkdtempSync(join(tmpdir(),'oi-joint-browser-'));
const child=spawn(process.env.PYTHON??'python3',['scripts/embodied_runtime.py','--source',resolve(source),'--state-dir',directory,'--port','0','--cabinet-fixture','fastening-a'],{stdio:['ignore','pipe','pipe']});
let output='',errors='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v);
try {
  for(let i=0;i<200&&!output.includes('Embodied workbench:');i++) {
    if(child.exitCode!==null)throw Error(errors);
    await new Promise(done=>setTimeout(done,100));
  }
  const origin=/http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];if(!origin)throw Error('Startup timeout '+errors);
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));
  let posts=0;page.on('request',r=>{if(r.method()==='POST')posts++;});
  await page.goto(origin+'/?run=so101');
  await expect(page.getByRole('button',{name:'Enter Run mode'})).toBeEnabled({timeout:20000});
  const initial:RunSnapshot=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
  await page.getByRole('button',{name:'Enter Run mode'}).click();
  await page.getByLabel('Task',{exact:true}).fill('assemble corner');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(async()=>page.evaluate(async()=>{
    const s=await (await fetch('/api/embodied/run')).json();return s.objects.find((o:{id:string})=>o.id==='screw_1').fastener.insertion_m;
  }),{timeout:20000}).toBeGreaterThan(.001);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('paused');
  const paused=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
  assert(paused.spindle_angle_rad>0&&paused.spindle_angle_rad<24*Math.PI);
  await expect(page.getByTestId('assembly-status')).toHaveText('partial');
  await page.screenshot({path:`${evidence}/partial.png`,fullPage:true});
  await page.reload();
  await expect(page.getByRole('status')).toContainText('paused');
  const reloaded=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
  assert.equal(reloaded.spindle_angle_rad,paused.spindle_angle_rad);
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('completed',{timeout:20000});
  await expect(page.getByTestId('assembly-status')).toHaveText('succeeded_simulated_joint');
  const done=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
  assert.equal(done.task.result.status,'succeeded');
  assert(Object.values(done.task.result.checks).every((c:any)=>c.status==='pass'));
  assert.equal(done.task.result.physical_validated,false);
  assert.equal(done.spindle_angle_rad,24*Math.PI);
  assert.notDeepEqual(runWorkspace(initial,{}),runWorkspace(done,{}),'viewer must reflect authoritative movement');
  await page.screenshot({path:`${evidence}/complete.png`,fullPage:true});
  await page.getByRole('button',{name:'Inspect recorded states'}).click();
  await expect(page.getByRole('status')).toHaveText('REPLAY · read only');
  const before=posts;
  const trace=await page.evaluate(async()=> (await fetch('/api/embodied/trace')).json());
  await page.getByLabel('Recorded state',{exact:true}).fill(String(trace.states.length-1));
  await expect(page.getByTestId('state-id')).toHaveText(done.dataset_state.state_id);
  assert.deepEqual(runWorkspace(done,{}),runWorkspace({...trace.states.at(-1),cabinet:trace.fixture},{}));
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeDisabled();
  assert.equal(posts,before);
  writeFileSync(`${evidence}/browser-trace.json`,JSON.stringify(trace));
  writeFileSync(`${evidence}/browser-checks.json`,JSON.stringify({run_id:done.run_id,initial_state_id:trace.initial_state_id,final_state_id:trace.final_state_id,
    complete:trace.complete,assembly_status:trace.assembly_status,checks:done.task.result.checks,stop_resume:true,reload_retained_partial:true,replay_dispatches:0,physical_validation:false},null,2));
  assert.deepEqual(pageErrors,[]);
  console.log('PASS OI chat → controller → joint → independent checks; partial Stop/reload/resume and read-only replay');
} finally {
  await browser.close();
  if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}
  rmSync(directory,{recursive:true,force:true});
}
