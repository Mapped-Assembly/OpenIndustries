/** Disposable headless rendering process. The service alone publishes successful jobs. */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { hash, LIMITS, type RenderInput } from './contract.ts';

const directory=process.argv[2],web=resolve(process.argv[3]);
let browser:Browser|undefined,stopping=false;
const server=createServer((req,res)=>{
  let path:string;try{path=resolve(web,'.'+decodeURIComponent((req.url??'/').split('?')[0]));}catch{res.writeHead(400);res.end();return;}
  const file=path===web?join(web,'index.html'):path;
  if(!file.startsWith(web+sep)){res.writeHead(404);res.end();return;}
  try{const body=readFileSync(file);res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream'});res.end(body);}catch{res.writeHead(404);res.end();}
});
async function stop():Promise<void> {if(stopping)return;stopping=true;await browser?.close().catch(()=>{});server.close();process.exit(0);}
process.once('SIGTERM',()=>void stop());process.once('disconnect',()=>void stop());
try {
  const input:RenderInput=JSON.parse(readFileSync(join(directory,'input.json'),'utf8'));
  await new Promise<void>((done,fail)=>server.once('error',fail).listen(0,'127.0.0.1',done));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true,timeout:30_000,chromiumSandbox:process.env.OI_RENDER_NO_SANDBOX!=='1',
    ...(process.env.OI_RENDER_CHROMIUM?{executablePath:process.env.OI_RENDER_CHROMIUM}:{}),
    args:['--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',...(process.env.OI_RENDER_NO_SANDBOX==='1'?['--no-sandbox']:[])]});
  const context=await browser.newContext({viewport:{width:input.options.size,height:input.options.size},serviceWorkers:'block'});
  // The render page has no user HTML, scripts, network URLs, sessions or workbench controls.
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();
  await page.exposeFunction('renderProgress',(progress:number)=>{if(Number.isFinite(progress)&&progress>=0&&progress<=1)process.send?.({type:'progress',progress});});
  await page.goto(origin,{waitUntil:'load',timeout:15_000});
  await page.waitForFunction(()=>typeof window.renderScene==='function',{},{timeout:15_000});
  const result=await page.evaluate(async({scene,options})=>window.renderScene(scene,options),input);
  const bytes=Buffer.from(result.base64,'base64');
  if(bytes.length>LIMITS.outputBytes||bytes.subarray(0,6).toString()!=='GIF89a')throw Error('Invalid or oversized GIF output.');
  writeFileSync(join(directory,'result.gif'),bytes,{mode:0o600,flush:true});
  const metadata={schema_version:1,job_id:input.request_id,scene_sha256:input.scene_sha256,source:input.source,
    options:input.options,renderer:'oi-gif-v1',renderer_build_sha256:hash(readFileSync(join(web,'index.html'))),chromium_version:browser.version(),rendered_at:new Date().toISOString(),media:{mime_type:'image/gif',bytes:statSync(join(directory,'result.gif')).size,sha256:hash(bytes)},review:result.metadata};
  writeFileSync(join(directory,'metadata.json'),JSON.stringify(metadata),{mode:0o600,flush:true});
  await browser.close();browser=undefined;server.close();
  process.send?.({type:'complete'});process.disconnect?.();
}catch(error){process.send?.({type:'failure',message:(error instanceof Error?error.message:'Renderer failed').slice(0,300)});await browser?.close().catch(()=>{});server.close();process.exitCode=1;process.disconnect?.();}
