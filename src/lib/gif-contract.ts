import * as THREE from 'three';

export type FloorRegion = { x: number; z: number; width: number; depth: number };
export type GifCamera = { azimuthDegrees: number; elevationDegrees: number; distanceScale: number; fovDegrees: number };
export const defaultGifCamera: GifCamera = { azimuthDegrees:45, elevationDegrees:35.272421, distanceScale:1.15, fovDegrees:40 };
export type GifOptions = {
  scope: 'room' | 'section' | 'asset'; assetIndex: number; region: FloorRegion;
  motion: 'turntable' | 'sample' | 'animation'; size: number; duration: number; fps: number;
  rangeStart?: number; rangeEnd?: number; snapshotTime?: number | null;
  camera?: GifCamera; allowEmptyRoom?: boolean;
};

export function regionBounds(region: FloorRegion, room: number[]) {
  const { x,z,width,depth }=region;
  if (![x,z,width,depth].every(Number.isFinite)||width<=0||depth<=0) throw new Error('Section dimensions must be positive, with finite center coordinates.');
  if (Math.abs(x)+width/2>room[0]/2+1e-8||Math.abs(z)+depth/2>room[1]/2+1e-8) throw new Error('The floor section must fit inside the room. Coordinates are measured from the room center.');
  return new THREE.Box3(new THREE.Vector3(x-width/2,-.04,z-depth/2),new THREE.Vector3(x+width/2,room[2],z+depth/2));
}
