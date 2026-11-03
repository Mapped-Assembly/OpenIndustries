import { useEffect, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyWorldPoses, createWorld } from '../lib/world';
import { evaluateWorkspace, type Workspace } from '../lib/workspace';
import { regionBounds, type FloorRegion } from '../lib/gif';
import { updateCameraDepth, updatePovCameraDepth } from '../lib/camera-depth';
import { resolvePovCameraFrame, type PovCameraPreset } from '../lib/pov-capture';
import { pixelRatioForProfile, type RenderProfile } from '../lib/render-profile';
import { captureLiteSnapshot, type LiteSnapshotResult } from '../lib/lite-snapshot';
import './workspace-viewer.css';
import {
  choosePovSpawn, clampPovPosition, lookPov, stepPov,
  type CameraSession, type Point3, type PovAction, type PovPose,
} from '../lib/pov-camera';

type Props = {
  workspace: Workspace; selected: number; selectedPart: number; time: number | null; focus: number;
  overview?: { position: [number, number, number]; target: [number, number, number] }; focusSelection?: boolean;
  region: FloorRegion | null; onSelect: (instance: number, part: number) => void;
  mode?: 'orbit' | 'pov' | 'mounted'; mountedCamera?: PovCameraPreset | null; rigStale?: boolean;
  cameraSession?: RefObject<CameraSession>; sessionKey?: string;
  profile?: RenderProfile; sceneKey?: string; sceneRevision?: number | null;
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
  const [snapshot, setSnapshot] = useState<LiteSnapshotResult | null>(null);
  const [snapshotError, setSnapshotError] = useState('');
  const [snapshotUrls, setSnapshotUrls] = useState<{image:string;metadata:string}|null>(null);
  const snapshotRequest = useRef<() => void>(() => {});
  const requestRender = useRef<() => void>(() => {});
  useEffect(() => {
    if (!snapshot) {setSnapshotUrls(null);return;}
    const image=URL.createObjectURL(snapshot.blob);
    const metadata=URL.createObjectURL(new Blob([JSON.stringify(snapshot.metadata,null,2)],{type:'application/json'}));
    setSnapshotUrls({image,metadata});
    return () => {URL.revokeObjectURL(image);URL.revokeObjectURL(metadata);};
  },[snapshot]);
  const latest = useRef(props); latest.current = props;
  const key = props.workspace.items.map(item => `${item.id}:${item.asset.id}:${item.asset.source.digest}:${item.cloudVersionId ?? 'local'}:${item.missing}:${item.asset.parts.length}`).join('|');
  const roomKey = props.workspace.room.join(',');

  useEffect(() => {
    const el = host.current!;
    const p = latest.current;
    const cameraMemory = p.cameraSession ?? localCameraSession;
    let activeProfile: RenderProfile = p.profile ?? 'detailed';
    const world = createWorld(p.workspace.items.map(item => item.asset), p.workspace.room,-1,-1,undefined,activeProfile);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(pixelRatioForProfile(activeProfile,devicePixelRatio));
    renderer.shadowMap.enabled=false;
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
    let currentMode: 'orbit' | 'pov' | 'mounted' = 'orbit';
    let povPose: PovPose | null = null;
    let lastFocus = remembered ? `${p.selected}:${p.selectedPart}:${p.focus}` : '';
    let lastRegion = '';
    let outline: THREE.Box3Helper | null = null;
    let scheduled=0;
    let requestDraw: () => void = () => {};
    const wake=():void=>requestDraw();
    controls.addEventListener('change',wake);
    canvas.addEventListener('wheel',wake,{passive:true});

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
    const switchMode = (next: 'orbit' | 'pov' | 'mounted'): void => {
      if (next === currentMode) return;
      held.current.clear();
      if (next === 'pov') {
        if (currentMode === 'orbit') rememberOrbit();
        controls.enabled = false;
        povPose = cameraMemory.current.pov
          ? { ...cameraMemory.current.pov, position: clampPovPosition(cameraMemory.current.pov.position, latest.current.workspace.room) }
          : spawn();
        cameraMemory.current.pov = povPose;
        canvas.setAttribute('aria-label', 'POV scene canvas. Click to look, WASD to move, Escape to release mouse.');
      } else if (next === 'mounted') {
        if (currentMode === 'orbit') rememberOrbit();
        if (povPose) cameraMemory.current.pov = povPose;
        povPose = null;
        held.current.clear();
        touchLook = null;
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        controls.enabled = false;
        canvas.setAttribute('aria-label','Mounted camera viewport. Select a declared instance and frame in camera controls.');
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
      requestDraw();
      if (currentMode === 'pov' && event.pointerType === 'touch') {
        touchLook = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      }
    };
    const onMove = (event: PointerEvent): void => {
      if (currentMode !== 'pov' || !povPose) return;
      requestDraw();
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
        requestDraw();
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      const action = keyAction[event.code];
      if (action) held.current.delete(action);
    };
    const stopMovement = (): void => { held.current.clear(); touchLook = null; };
    const onVisibility = (): void => { if (document.hidden) stopMovement(); else requestDraw(); };
    const onPointerLockChange = (): void => {
      if (document.pointerLockElement !== canvas) held.current.clear();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('blur', stopMovement);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopMovement);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    const resize = (): void => {
      requestDraw();
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    let frames=0,maximumFrameMs=0;
    const drawFrame = (): void => {
      const started=performance.now();
      const { workspace, selected, selectedPart, time, focus, region, mode, mountedCamera, rigStale } = latest.current;
      const nextProfile=latest.current.profile??'detailed';
      if(nextProfile!==activeProfile){
        activeProfile=nextProfile;
        world.setProfile(activeProfile);
        renderer.setPixelRatio(pixelRatioForProfile(activeProfile,devicePixelRatio));
        resize();
      }
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
      const requested = cameraMemory.current.requestedPov;
      if (currentMode === 'pov' && requested) {
        povPose = { ...requested.pose, position: clampPovPosition(requested.pose.position, workspace.room) };
        cameraMemory.current.pov = povPose;
        delete cameraMemory.current.requestedPov;
      }
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
      const delta = Math.min(clock.getDelta(),.05);
      let cameraAvailable = true;
      if (currentMode !== 'mounted' && camera.fov !== 45) {
        camera.fov = 45;
        camera.updateProjectionMatrix();
      }
      if (currentMode === 'mounted') {
        // Never interpret stale data or a missing parent as a successfully attached view.
        if (!mountedCamera) {
          cameraAvailable = false;
          setNotice(previous => previous === 'Choose a camera parent in Mounted POV controls.' ? previous : 'Choose a camera parent in Mounted POV controls.');
        } else if (rigStale) {
          cameraAvailable = false;
          setNotice(previous => previous === 'Camera source is stale or disconnected; view is held.' ? previous : 'Camera source is stale or disconnected; view is held.');
        } else {
          try {
            const frame = resolvePovCameraFrame(mountedCamera, workspace, world.groups, time ?? 0);
            camera.position.fromArray(frame.position);
            camera.quaternion.fromArray(frame.quaternion);
            if (camera.fov !== mountedCamera.fovDegrees || camera.near !== mountedCamera.clip.nearMeters || camera.far !== mountedCamera.clip.farMeters) {
              camera.fov = mountedCamera.fovDegrees;
              camera.near = mountedCamera.clip.nearMeters;
              camera.far = mountedCamera.clip.farMeters;
              camera.updateProjectionMatrix();
            }
            setNotice(previous => previous === '' ? previous : '');
          } catch (error) {
            cameraAvailable = false;
            const message = error instanceof Error ? error.message : 'Camera mount is unavailable.';
            setNotice(previous => previous === message ? previous : message);
          }
        }
      } else if (currentMode === 'pov' && povPose) {
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
      canvas.dataset.renderProfile=activeProfile;
      canvas.dataset.renderFrames=String(frames+1);
      canvas.dataset.sceneInstances=String(workspace.items.length);
      canvas.dataset.gpuGeometryCount=String(world.resourceStats().geometries);
      canvas.dataset.cameraMode = currentMode;
      canvas.dataset.cameraStatus = cameraAvailable ? 'bound' : 'unbound';
      canvas.dataset.cameraPosition = camera.position.toArray().map(value => value.toFixed(3)).join(',');
      if (cameraAvailable) renderer.render(world.scene, camera);
      else renderer.clear();
      frames++;
      const elapsed=performance.now()-started;
      maximumFrameMs=Math.max(maximumFrameMs,elapsed);
      canvas.dataset.lastCpuFrameMs=elapsed.toFixed(3);
      canvas.dataset.maxCpuFrameMs=maximumFrameMs.toFixed(3);
      canvas.dataset.drawCalls=String(renderer.info.render.calls);
      // Detailed retains the established animated loop; Lite only schedules
      // another frame for active input or OrbitControls' ongoing damping.
      if (activeProfile==='detailed' || held.current.size>0) requestDraw();
    };
    requestDraw=():void=>{
      if(scheduled || document.hidden || !el.isConnected) return;
      scheduled=requestAnimationFrame(()=>{scheduled=0;drawFrame();});
    };
    requestRender.current=requestDraw;
    snapshotRequest.current=()=>{
      if(activeProfile!=='lite'){
        setSnapshotError('Choose 3D Lite before exporting a Lite snapshot.');
        return;
      }
      if(canvas.dataset.cameraStatus!=='bound'){
        setSnapshotError('Camera is unbound: choose a valid viewpoint before capture.');
        return;
      }
      void captureLiteSnapshot(renderer,world.scene,camera,latest.current.workspace,{
        size:480,time:latest.current.time,sceneKey:latest.current.sceneKey,
        sceneRevision:latest.current.sceneRevision,profile:activeProfile,
      }).then(result=>{setSnapshot(result);setSnapshotError('');requestDraw();})
        .catch(error=>setSnapshotError(error instanceof Error?error.message:'Lite capture failed.'));
    };
    requestDraw();
    return () => {
      if (currentMode === 'pov' && povPose) cameraMemory.current.pov = povPose;
      else rememberOrbit();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      stopMovement();
      resetPov.current = () => {};
      observer.disconnect();
      cancelAnimationFrame(scheduled);
      requestRender.current=()=>{};
      snapshotRequest.current=()=>{};
      controls.removeEventListener('change',wake);
      canvas.removeEventListener('wheel',wake);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('blur', stopMovement);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopMovement);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      controls.dispose();
      world.dispose();
      renderer.dispose();
      el.removeChild(canvas);
    };
  }, [key, roomKey, props.sessionKey]);
  // Renderer and world stay mounted across profile, pose, view and selection edits.
  useEffect(()=>requestRender.current(),[
    props.workspace,props.selected,props.selectedPart,props.time,props.focus,props.region,
    props.mode,props.mountedCamera,props.rigStale,props.profile,
  ]);

  /** Activate a touch movement action for as long as the pointer is held. */
  const touchButton = (action: PovAction, label: string, symbol: string) =>
    <button type="button" aria-label={label} title={label} onPointerDown={event => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      held.current.add(action);
      requestRender.current();
    }} onPointerUp={() => held.current.delete(action)}
      onPointerCancel={() => held.current.delete(action)}
      onLostPointerCapture={() => held.current.delete(action)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); held.current.add(action); requestRender.current(); } }}
      onKeyUp={() => held.current.delete(action)}
      onBlur={() => held.current.delete(action)}>{symbol}</button>;

  return <div className={`viewport${props.mode === 'pov' ? ' oi-pov-viewport' : ''}${props.mode === 'mounted' ? ' oi-mounted-viewport' : ''}`}
    ref={host} aria-label={props.mode === 'pov' ? 'First-person view of the room' : 'Interactive 3D room'}>
    {props.profile === 'lite' && <div className="oi-lite-snapshot" aria-label="Lite snapshot tools">
      <button type="button" aria-label="Capture Lite PNG" onClick={()=>snapshotRequest.current()}>Capture Lite PNG</button>
      {snapshotUrls && snapshot && <>
        <a href={snapshotUrls.image} download={snapshot.filename}>Download Lite PNG</a>
        <a href={snapshotUrls.metadata} download={snapshot.filename.replace(/\.png$/,'.json')}>Download Lite metadata</a>
      </>}
      {snapshotError && <span role="alert">{snapshotError}</span>}
    </div>}
    {props.mode === 'mounted' && <div className="oi-mounted-indicator" role="status">
      <strong>SIMULATED CAMERA · LIVE MOUNTED POV</strong>
      {notice && <span>{notice}</span>}
      <small>Camera from evaluated scene poses; not real sensor video or validated perception.</small>
    </div>}
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
