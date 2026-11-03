import * as THREE from 'three';
import type { Asset, Part } from './scene';
import type { RenderProfile } from './render-profile';
import type { EvaluatedPose } from './workspace';

/** The same geometry, materials and instance placement feed the viewport and GIFs. */
export function createWorld(assets: Asset[], room: number[], selected = -1, selectedPart = -1, poses?: EvaluatedPose[], profile: RenderProfile = 'detailed') {
  // Geometry identity is based on exact source-verified bytes, not just a matching
  // display name, part ID or untrusted asset fingerprint.
  const reusable = new Map<string, {part: Part; geometry: THREE.BufferGeometry}[]>();
  const geometryFor = (asset: Asset, part: Part): THREE.BufferGeometry => {
    const key = `${asset.id}:${asset.source.digest}:${part.id}`;
    const existing = reusable.get(key) ?? [];
    for (const candidate of existing) {
      const a = candidate.part;
      if (a.vertices.length === part.vertices.length && a.indices.length === part.indices.length
          && a.vertices.every((value,i) => value === part.vertices[i])
          && a.indices.every((value,i) => value === part.indices[i])) return candidate.geometry;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.vertices, 3));
    geometry.setIndex(part.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    existing.push({part,geometry});
    reusable.set(key,existing);
    return geometry;
  };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#192322');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x63736b, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(4, 8, 5); scene.add(light);
  const environment = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(room[0], .025, room[1]), new THREE.MeshStandardMaterial({ color: '#34433c', roughness: .95 }));
  floor.position.y = -.018; environment.add(floor);
  if (!assets.some(asset => asset.source.kind === 'generated')) environment.add(new THREE.GridHelper(Math.max(room[0], room[1]), Math.max(2, Math.round(Math.max(room[0], room[1]) * 2)), 0x82917b, 0x46594d));
  const box = new THREE.BoxGeometry(room[0], room[2], room[1]);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x7e9784, transparent: true, opacity: .35 }));
  box.dispose(); edges.position.y = room[2] / 2; environment.add(edges);
  scene.add(environment);
  const groups = assets.map((asset, index) => {
    const group = new THREE.Group();
    asset.parts.forEach(part => {
      const geometry = geometryFor(asset, part);
      const color = part.color ? new THREE.Color(...part.color) : index === selected && assets[index].parts.indexOf(part) === selectedPart ? '#e8ffb5' : index === selected ? '#c8ef82' : '#b9c9c5';
      const material = profile === 'lite'
        ? new THREE.MeshLambertMaterial({color})
        : new THREE.MeshStandardMaterial({color,metalness:.2,roughness:.55});
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.pivot = geometry.boundingBox!.getCenter(new THREE.Vector3()); mesh.userData.partId = part.id;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    });
    scene.add(group);
    return group;
  });
  if (poses) applyWorldPoses(groups, poses);
  return {
    scene, groups, environment,
    /** Switch shader quality without replacing any geometry or object identity. */
    setProfile: (next: RenderProfile) => setWorldRenderProfile(groups,next),
    /** Source-level accounting; object count is never reduced for Lite. */
    resourceStats: () => ({
      instances:groups.length,
      meshes:groups.reduce((sum,group)=>sum+group.children.length,0),
      geometries:new Set(groups.flatMap(group=>group.children.map(mesh=>(mesh as THREE.Mesh).geometry))).size,
      materials:new Set(groups.flatMap(group=>group.children.map(mesh=>(mesh as THREE.Mesh).material))).size,
    }),
    dispose: () => disposeScene(scene),
  };
}

export function applyWorldPoses(groups: THREE.Group[], poses: EvaluatedPose[]) {
  groups.forEach((group, index) => {
    const pose = poses[index]; if (!pose) return;
    group.position.fromArray(pose.position); group.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as [number,number,number]); group.visible = pose.visible;
    group.children.forEach(object => {
      const mesh = object as THREE.Mesh;
      const part = pose.parts[mesh.userData.partId];
      mesh.matrix.identity();
      if (part) {
        const pivot = mesh.userData.pivot as THREE.Vector3;
        mesh.matrix.makeTranslation(pivot.x + part.position[0], pivot.y + part.position[1], pivot.z + part.position[2]);
        mesh.matrix.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...part.rotation.map(THREE.MathUtils.degToRad) as [number,number,number])));
        mesh.matrix.multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      }
      mesh.matrixWorldNeedsUpdate = true;
    });
    group.updateMatrixWorld(true);
  });
}

/** Shader profile changes are view-only; mesh IDs, picking and transforms stay stable. */
export function setWorldRenderProfile(groups: THREE.Group[], profile: RenderProfile): void {
  for (const group of groups) for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    const old = mesh.material as THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;
    if (!old || (profile === 'lite' ? old instanceof THREE.MeshLambertMaterial && !(old instanceof THREE.MeshStandardMaterial) : old instanceof THREE.MeshStandardMaterial)) continue;
    const color = old.color.clone(), emissive = old.emissive.clone();
    mesh.material = profile === 'lite'
      ? new THREE.MeshLambertMaterial({color,emissive,side:old.side,transparent:old.transparent,opacity:old.opacity})
      : new THREE.MeshStandardMaterial({color,emissive,metalness:.2,roughness:.55,side:old.side,transparent:old.transparent,opacity:old.opacity});
    old.dispose();
  }
}

/** Dispose exact GPU resources once even when multiple instances share geometry. */
export function disposeScene(scene: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]) materials.add(material);
  });
  for(const geometry of geometries)geometry.dispose();
  for(const material of materials)material.dispose();
}
