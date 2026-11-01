/** Render the reproducible one-room scene using an already running service through MCP's client. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { oneRoom } from '../benchmarks/render/build-scene.ts';
import { callRenderTool } from '../server/mcp-render.mjs';

const root=resolve('.'),directory=join(root,'.astra');mkdirSync(directory,{recursive:true});
writeFileSync(join(directory,'backend-render-room.scene.json'),JSON.stringify(oneRoom(),null,2));
const job=await callRenderTool(root,'astra.render_submit',{request_id:randomUUID(),scene_path:'.astra/backend-render-room.scene.json'});
console.log(JSON.stringify({submitted:job.id,status:job.status}));
const deadline=Date.now()+150_000;
while(Date.now()<deadline){
  const status=await callRenderTool(root,'astra.render_status',{job_id:job.id});
  if(status.status==='completed'){
    console.log(JSON.stringify(await callRenderTool(root,'astra.render_download',{job_id:job.id}),null,2));process.exit(0);
  }
  if(!['queued','running'].includes(status.status))throw Error(JSON.stringify(status.error));
  await new Promise(done=>setTimeout(done,250));
}
throw Error('Client polling timed out; inspect the same job ID. The independent service owns its lifecycle.');
