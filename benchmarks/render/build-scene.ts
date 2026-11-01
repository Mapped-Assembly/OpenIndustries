/** Reproducible 8×6×3 m asymmetric room with generated floor, walls, entrance and window. */
import { BoxGeometry } from 'three';
import { finalizeAsset, type Part, type Vec3 } from '../../src/lib/scene.ts';
import { makeManifest, type SceneManifest } from '../../src/lib/workspace.ts';
export function oneRoom():SceneManifest {
  function box(id:string,size:Vec3,position:Vec3,color:Vec3):Part {
    const geometry=new BoxGeometry(...size);geometry.translate(...position);
    const part:Part={id,name:id,vertices:Array.from(geometry.attributes.position.array),indices:Array.from(geometry.index!.array),color,metadata:{representation:'generated room geometry'}};
    geometry.dispose();return part;
  }
  const parts=[box('floor',[8,.05,6],[0,0,0],[.4,.5,.45]),box('back-wall',[8,3,.1],[0,1.5,-3],[.72,.7,.6]),
    box('left-wall',[.1,3,6],[-4,1.5,0],[.5,.65,.7]),box('entrance-left',[1.5,3,.1],[-3.25,1.5,3],[.75,.55,.4]),
    box('entrance-right',[4.5,3,.1],[1.75,1.5,3],[.75,.55,.4]),box('entrance-top',[2,.7,.1],[-1.5,2.65,3],[.75,.55,.4]),
    box('window-bottom',[.1,.8,6],[4,.4,0],[.6,.7,.75]),box('window-top',[.1,.6,6],[4,2.7,0],[.6,.7,.75]),
    box('window-left',[.1,1.6,1.5],[4,1.6,-2.25],[.6,.7,.75]),box('window-right',[.1,1.6,1.5],[4,1.6,2.25],[.6,.7,.75])];
  const asset=finalizeAsset({id:'room-geometry',name:'Room with entrance and window',parts,hierarchy:{id:'room',name:'Room',partIds:parts.map(p=>p.id),children:[]},source:{kind:'generated',generator:'oi-fixture',filename:'backend-one-room',digest:'backend-one-room-v1'},warnings:[]});
  return makeManifest({room:[8,6,3],items:[{id:'room-instance',name:asset.name,asset,position:asset.originOffset,rotation:[0,0,0],visible:true}],animation:{duration:3,loop:true,tracks:[]}},true);
}
