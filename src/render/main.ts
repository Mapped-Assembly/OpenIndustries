/** Private headless entry point: renders data with the same evaluator and GIF code as the UI. */
import { renderGif, type GifOptions } from '../lib/gif';
import { hydrateManifest, readManifest } from '../lib/workspace';

declare global {
  interface Window {
    renderScene:(scene:unknown,options:GifOptions)=>Promise<{base64:string;metadata:unknown}>;
    renderProgress:(progress:number)=>Promise<void>;
  }
}
window.renderScene=async(scene,options)=>{
  const workspace=hydrateManifest(readManifest(scene),[]);
  const result=await renderGif(workspace.items.map(i=>i.asset),workspace.room,options,new AbortController().signal,
    value=>{void window.renderProgress(value);},workspace);
  const bytes=new Uint8Array(await result.blob.arrayBuffer());
  let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return {base64:btoa(binary),metadata:result.metadata};
};
