import { useEffect, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyWorldPoses, createWorld } from '../lib/world';
import { evaluateWorkspace, type Workspace } from '../lib/workspace';
import { regionBounds, type FloorRegion } from '../lib/gif';
import { updateCameraDepth, updatePovCameraDepth } from '../lib/camera-depth';
import './workspace-viewer.css';
import {
  choosePovSpawn, clampPovPosition, lookPov, stepPov,
  type CameraSession, type Point3, type PovAction, type PovPose,
} from '../lib/pov-camera';

type Props = {
  workspace: Workspace; selected: number; selectedPart: number; time: number | null; focus: number;
  overview?: { position: [number, number, number]; target: [number, number, number] }; focusSelection?: boolean;
  region: FloorRegion | null; onSelect: (instance: number, part: number) => void;
  mode?: 'orbit' | 'pov'; cameraSession?: RefObject<CameraSession>; sessionKey?: string;
};

const keyAction: Record<string, PovAction> = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'backward', ArrowDown: 'backward',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
};

/** Interactive view over one evaluated scene; POV never changes workspace contents. */
export function WorkspaceViewer(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const localCameraSession = useRef<CameraSession>({});
  const held = useRef<Set<PovAction>>(new Set());
  const resetPov = useRef<() => void>(() => {});
  const [notice, setNotice] = useState('');
  const latest = useRef(props); latest.current = props;
  const key = props.workspace.items.map(item => `${item.id}:${item.asset.id}:${item.cloudVersionId ?? 'local'}:${item.missing}`).join('|');
  const roomKey = props.workspace.room.join(',');

  useEffect(() => {
    const el = host.current!;
    const p = latest.current;
    const cameraMemory = p.cameraSession ?? localCameraSession;
    const world = createWorld(p.workspace.items.map(item => item.asset), p.workspace.room);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    const camera = new THREE.PerspectiveCamera(45, 1, .01, 100);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    const remembered = cameraMemory.current.orbit;
    if (remembered) {
      camera.position.fromArray(remembered.position);
      controls.target.fromArray(remembered.target);
      controls.update();
    }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const clock = new THREE.Clock();
    let down: [number, number] = [0, 0];
    let touchLook: { id: number; x: number; y: number } | null = null;
    let currentMode: 'orbit' | 'pov' = 'orbit';
    let povPose: PovPose | null = null;
    let lastFocus = remembered ? `${p.selected}:${p.selectedPart}:${p.focus}` : '';
    let lastRegion = '';
    let outline: THREE.Box3Helper | null = null;

    /** Save orbit without changing the authored workspace or its history. */
    const rememberOrbit = (): void => {
      cameraMemory.current.orbit = {
        position: camera.position.toArray() as Point3,
        target: controls.target.toArray() as Point3,
      };
    };

    /** Use represented object bounds only for an advisory initial spawn check. */
    const spawn = (): PovPose => {
      const room = latest.current.workspace.room;
      const obstacles = world.groups
        .filter(group => group.visible)
        .map(group => new THREE.Box3().setFromObject(group))
        .filter(box => !box.isEmpty());
      const result = choosePovSpawn(room, point => {
        const body = new THREE.Box3(
          new THREE.Vector3(point[0] - .18, Math.max(.03, point[1] - 1.5), point[2] - .18),
          new THREE.Vector3(point[0] + .18, Math.min(room[2] - .02, point[1] + .1), point[2] + .18),
        );
        return obstacles.some(obstacle => obstacle.intersectsBox(body));
      });
      setNotice(result.verified ? '' : 'No clear starting point found in the available geometry. POV may intersect equipment.');
      return result.pose;
    };

    /** Enter or leave POV while retaining the same renderer, geometry and selection. */
    const switchMode = (next: 'orbit' | 'pov'): void => {
      if (next === currentMode) return;
      held.current.clear();
      if (next === 'pov') {
        rememberOrbit();
        controls.enabled = false;
        povPose = cameraMemory.current.pov
          ? { ...cameraMemory.current.pov, position: clampPovPosition(cameraMemory.current.pov.position, latest.current.workspace.room) }
          : spawn();
        cameraMemory.current.pov = povPose;
        canvas.setAttribute('aria-label', 'POV scene canvas. Click to look, WASD to move, Escape to release mouse.');
      } else {
        if (povPose) cameraMemory.current.pov = povPose;
        povPose = null;
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        const orbit = cameraMemory.current.orbit;
        if (orbit) {
          camera.position.fromArray(orbit.position);
          controls.target.fromArray(orbit.target);
        }
        controls.enabled = true;
        controls.update();
        setNotice('');
        canvas.setAttribute('aria-label', 'Interactive 3D room');
      }
      currentMode = next;
    };

    resetPov.current = () => {
      if (currentMode !== 'pov') return;
      povPose = spawn();
      cameraMemory.current.pov = povPose;
      held.current.clear();
    };

    const selectFromPointer = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const locked = document.pointerLockElement === canvas && currentMode === 'pov';
      pointer.set(locked ? 0 : (event.clientX - rect.left) / rect.width * 2 - 1,
        locked ? 0 : -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(world.groups.filter(group => group.visible).flatMap(group => group.children))[0];
      if (hit?.object.parent) {
        const parent = hit.object.parent as THREE.Group;
        latest.current.onSelect(world.groups.indexOf(parent), parent.children.indexOf(hit.object));
      }
    };

    const onDown = (event: PointerEvent): void => {
      down = [event.clientX, event.clientY];
      canvas.focus();
      if (currentMode === 'pov' && event.pointerType === 'touch') {
        touchLook = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      }
    };
    const onMove = (event: PointerEvent): void => {
      if (currentMode !== 'pov' || !povPose) return;
      if (document.pointerLockElement === canvas && event.pointerType === 'mouse') {
        povPose = lookPov(povPose, event.movementX, event.movementY);
      } else if (touchLook?.id === event.pointerId) {
        povPose = lookPov(povPose, event.clientX - touchLook.x, event.clientY - touchLook.y);
        touchLook.x = event.clientX;
        touchLook.y = event.clientY;
      }
    };
    const finishTouch = (event: PointerEvent): void => {
      if (touchLook?.id !== event.pointerId) return;
      touchLook = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onUp = (event: PointerEvent): void => {
      finishTouch(event);
      if (event.button !== 0 || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
      if (currentMode === 'pov' && event.pointerType === 'mouse' && document.pointerLockElement !== canvas) {
        try {
          void canvas.requestPointerLock().catch(() => setNotice('Pointer lock unavailable. You can use touch look controls.'));
        } catch {
          setNotice('Pointer lock unavailable. You can use touch look controls.');
        }
        return;
      }
      selectFromPointer(event);
    };
    const onCancel = (event: PointerEvent): void => finishTouch(event);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (currentMode !== 'pov' || document.activeElement !== canvas || event.altKey || event.ctrlKey || event.metaKey) return;
      const action = keyAction[event.code];
      if (action) {
        held.current.add(action);
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      const action = keyAction[event.code];
      if (action) held.current.delete(action);
    };
    const stopMovement = (): void => { held.current.clear(); touchLook = null; };
    const onVisibility = (): void => { if (document.hidden) stopMovement(); };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('blur', stopMovement);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopMovement);
    document.addEventListener('visibilitychange', onVisibility);

    const resize = (): void => {
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    renderer.setAnimationLoop(() => {
      const { workspace, selected, selectedPart, time, focus, region, mode } = latest.current;
      applyWorldPoses(world.groups, evaluateWorkspace(workspace.items, workspace.animation, time));
      world.groups.forEach((group, i) => group.children.forEach((object, j) => {
        ((object as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.setHex(
          i === selected ? (j === selectedPart ? 0x516525 : 0x203012) : 0,
        );
      }));
      const focusKey = `${selected}:${selectedPart}:${focus}`;
      if (focusKey !== lastFocus) {
        lastFocus = focusKey;
        if (currentMode === 'orbit') {
          const group = world.groups[selected];
          if (group && latest.current.focusSelection !== false) {
            const box = new THREE.Box3().setFromObject(selectedPart >= 0 ? group.children[selectedPart] ?? group : group);
            const center = box.getCenter(new THREE.Vector3());
            const size = Math.max(box.getSize(new THREE.Vector3()).length(), .01);
            controls.target.copy(center);
            camera.position.copy(center).add(new THREE.Vector3(size * 1.3, size * .9, size * 1.3));
          } else if (latest.current.overview) {
            controls.target.set(...latest.current.overview.target);
            camera.position.set(...latest.current.overview.position);
          } else {
            controls.target.set(0, 0, 0);
            const generatedArchitecture = workspace.items.some(item => item.asset.source.kind === 'generated');
            camera.position.set(
              workspace.room[0] * (generatedArchitecture ? .35 : .9),
              Math.max(...workspace.room) * (generatedArchitecture ? 1.35 : .75),
              workspace.room[1] * (generatedArchitecture ? .35 : .9),
            );
          }
        }
      }
      switchMode(mode ?? 'orbit');
      const regionKey = JSON.stringify(region);
      if (regionKey !== lastRegion) {
        lastRegion = regionKey;
        if (outline) {
          world.scene.remove(outline);
          outline.geometry.dispose();
          (outline.material as THREE.Material).dispose();
          outline = null;
        }
        if (region) try {
          outline = new THREE.Box3Helper(regionBounds(region, workspace.room), 0xc8ef82);
          world.scene.add(outline);
        } catch { /* Invalid region is explained in the export panel. */ }
      }
      const delta = clock.getDelta();
      if (currentMode === 'pov' && povPose) {
        povPose = stepPov(povPose, held.current, delta, workspace.room);
        cameraMemory.current.pov = povPose;
        camera.position.fromArray(povPose.position);
        camera.rotation.order = 'YXZ';
        camera.rotation.set(povPose.pitch, povPose.yaw, 0);
        updatePovCameraDepth(camera, workspace.room);
      } else {
        controls.update();
        updateCameraDepth(camera, world.scene, controls.target);
        rememberOrbit();
      }
      canvas.dataset.cameraMode = currentMode;
      canvas.dataset.cameraPosition = camera.position.toArray().map(value => value.toFixed(3)).join(',');
      renderer.render(world.scene, camera);
    });
    return () => {
      if (currentMode === 'pov' && povPose) cameraMemory.current.pov = povPose;
      else rememberOrbit();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      stopMovement();
      resetPov.current = () => {};
      observer.disconnect();
      renderer.setAnimationLoop(null);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('blur', stopMovement);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopMovement);
      document.removeEventListener('visibilitychange', onVisibility);
      controls.dispose();
      world.dispose();
      renderer.dispose();
      el.removeChild(canvas);
    };
  }, [key, roomKey, props.sessionKey]);

  /** Activate a touch movement action for as long as the pointer is held. */
  const touchButton = (action: PovAction, label: string, symbol: string) =>
    <button type="button" aria-label={label} title={label} onPointerDown={event => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      held.current.add(action);
    }} onPointerUp={() => held.current.delete(action)}
      onPointerCancel={() => held.current.delete(action)}
      onLostPointerCapture={() => held.current.delete(action)}>{symbol}</button>;

  return <div className={`viewport${props.mode === 'pov' ? ' oi-pov-viewport' : ''}`}
    ref={host} aria-label={props.mode === 'pov' ? 'First-person view of the room' : 'Interactive 3D room'}>
    {props.mode === 'pov' && <>
      <div className="oi-pov-reticle" aria-hidden="true">+</div>
      <div className="oi-pov-info" role="status">
        <b>POV · visual navigation only</b>
        {notice && <span>{notice}</span>}
        <button type="button" onClick={() => resetPov.current()}>Reset POV</button>
      </div>
      <div className="oi-pov-touch" aria-label="POV touch navigation">
        {touchButton('turnLeft', 'Look left', '↶')}
        {touchButton('left', 'Move left', '←')}
        {touchButton('forward', 'Move forward', '↑')}
        {touchButton('backward', 'Move backward', '↓')}
        {touchButton('right', 'Move right', '→')}
        {touchButton('turnRight', 'Look right', '↷')}
      </div>
    </>}
  </div>;
}
