"""Browser-independent fixed-step host for native/WASM JSON controllers."""
from __future__ import annotations

import argparse
from collections import deque
from functools import wraps
import threading
import hashlib
import json
import math
from pathlib import Path
import platform
try:
    import resource
except ImportError:  # Windows: timing still works, RSS is explicitly unavailable.
    resource = None
import time
from typing import Any, Callable

import mujoco as mj
import numpy as np

from json_workcell import JsonCell, compile_workcell, keys, load, positive
from wasm_policy import NativePolicy, WasmPolicy


class JointCell:
    """Reusable joint-position sequence capability for doors, gates and mechanisms."""

    def __init__(self, folder: Path) -> None:
        """Resolve bounded actuator/joint bindings and JSON phase completion predicates."""
        self.m = compile_workcell(folder/'workcell.json', folder/'robot-adapter.json')
        self.d = mj.MjData(self.m)
        self.task = load(folder/'task.json', 'oi.joint-task')
        keys(self.task, {'schema', 'version', 'bindings', 'phases', 'maxJointStep', 'timeout', 'tolerance', 'maxSpeed'})
        for key in ('maxJointStep', 'timeout', 'tolerance', 'maxSpeed'):
            positive(self.task[key], key)
        self.actuators, self.qadr, self.vadr = [], [], []
        for binding in self.task['bindings']:
            keys(binding, {'joint', 'actuator'})
            joint, act = self.m.joint(binding['joint']).id, self.m.actuator(binding['actuator']).id
            if self.m.jnt_type[joint] not in (int(mj.mjtJoint.mjJNT_HINGE), int(mj.mjtJoint.mjJNT_SLIDE)) or self.m.actuator_trnid[act, 0] != joint:
                raise ValueError('Expected scalar joint with matching actuator')
            self.actuators.append(act); self.qadr.append(self.m.jnt_qposadr[joint]); self.vadr.append(self.m.jnt_dofadr[joint])
        if not self.actuators or len(set(self.actuators)) != len(self.actuators):
            raise ValueError('Bindings must be nonempty and unique')
        ids = set()
        if not self.task['phases']:
            raise ValueError('Joint task requires phases')
        for phase in self.task['phases']:
            keys(phase, {'id', 'targets', 'minSeconds'})
            if not isinstance(phase['id'], str) or phase['id'] in ids or phase['id'] in ('ready', 'complete', 'fault'):
                raise ValueError('Invalid phase ID')
            ids.add(phase['id']); positive(phase['minSeconds'], 'minSeconds', True)
            if phase['minSeconds'] >= self.task['timeout'] or len(phase['targets']) != len(self.actuators):
                raise ValueError('Invalid joint phase')
            for act, value in zip(self.actuators, phase['targets']):
                if type(value) not in (int, float) or not np.isfinite(value) or not self.m.actuator_ctrllimited[act] or not self.m.actuator_ctrlrange[act, 0] <= value <= self.m.actuator_ctrlrange[act, 1]:
                    raise ValueError('Joint target outside actuator limits')
        self.phase, self.running, self.error = 'ready', False, None
        self.phase_index, self.phase_time = -1, 0.
        self.events: list[dict[str, Any]] = []
        self.overrides: dict[int, float] = {}
        self.control_due = True
        self.policy: NativePolicy = NativePolicy()
        mj.mj_forward(self.m, self.d)

    def enter(self, index: int) -> None:
        """Enter a configured phase without resetting the physical state."""
        self.phase_index, self.phase_time = index, self.d.time
        self.phase = 'complete' if index == len(self.task['phases']) else self.task['phases'][index]['id']
        if self.phase == 'complete':
            self.running = False
        self.events.append({'phase': self.phase, 'time': float(self.d.time)})

    def command(self, command: str) -> None:
        """Start/resume or pause this capability."""
        if command == 'pause':
            self.running = False
        elif command == 'start':
            if self.phase == 'ready':
                self.enter(0)
            self.running = self.phase not in ('complete', 'fault')
        else:
            raise ValueError('Unsupported cell command')

    def tick(self) -> None:
        """Drive configured joint targets and assess measured position and velocity."""
        if not self.running:
            return
        try:
            phase = self.task['phases'][self.phase_index]
            if self.control_due:
                self.d.ctrl[self.actuators] = self.policy.slew_many(self.d.ctrl[self.actuators].tolist(), phase['targets'], self.task['maxJointStep'])
            for act, value in self.overrides.items():
                self.d.ctrl[act] = value
            limited = self.m.actuator_ctrllimited.astype(bool)
            if not np.isfinite(self.d.ctrl).all() or np.any(self.d.ctrl[limited] < self.m.actuator_ctrlrange[limited, 0]) or np.any(self.d.ctrl[limited] > self.m.actuator_ctrlrange[limited, 1]):
                raise RuntimeError("Controller command exceeds actuator limits")
            mj.mj_step(self.m, self.d)
            if not np.isfinite(self.d.qpos).all() or any(w.number for w in self.d.warning):
                raise RuntimeError('MuJoCo instability')
            reached = bool(np.max(np.abs(self.d.qpos[self.qadr]-phase['targets'])) < self.task['tolerance'] and np.max(np.abs(self.d.qvel[self.vadr])) < self.task['maxSpeed'])
            decision = self.policy.transition(self.d.time-self.phase_time, phase['minSeconds'], self.task['timeout'], 0., True, reached, True)
            if decision < 0:
                raise RuntimeError('Joint phase timeout or predicate failure')
            if decision == 1:
                self.enter(self.phase_index+1)
        except Exception as error:
            self.error, self.phase, self.running = str(error), 'fault', False


def make_cell(folder: Path) -> JsonCell | JointCell:
    """Dispatch an explicit supported capability schema; never infer a skill from names."""
    schema = json.loads((folder/'task.json').read_text()).get('schema')
    if schema == 'oi.pick-place-task':
        return JsonCell(folder/'workcell.json', folder/'robot-adapter.json', folder/'task.json')
    if schema == 'oi.joint-task':
        return JointCell(folder)
    raise ValueError(f'Unsupported task capability: {schema}')


class Assessment:
    """Independent physical evidence collector; guest transition codes are not proof."""

    def __init__(self, cell: Any) -> None:
        """Initialize observed-contact, lift and phase-reach histories."""
        self.cell = cell
        self.bilateral = False
        self.highest = -float('inf')
        self.reached: set[int] = set()

    def sample(self) -> None:
        """Read authoritative MuJoCo data after a physics tick."""
        c = self.cell
        if isinstance(c, JsonCell):
            s = c.task['success']; geom = c.m.geom(s['geom']).id
            pairs = [{x.geom1, x.geom2} for x in c.d.contact]
            self.bilateral |= all({geom, c.m.geom(name).id} in pairs for name in s['fingerGeoms'])
            self.highest = max(self.highest, float(c.d.body(s['body']).xpos[s['heightAxis']]))
        else:
            for index, phase in enumerate(c.task['phases']):
                if np.max(np.abs(c.d.qpos[c.qadr]-phase['targets'])) < c.task['tolerance'] and np.max(np.abs(c.d.qvel[c.vadr])) < c.task['maxSpeed']:
                    self.reached.add(index)

    def report(self) -> dict[str, Any]:
        """Verify settled physical outcomes independently of the execution backend."""
        c = self.cell
        warnings = int(sum(w.number for w in c.d.warning))
        if isinstance(c, JsonCell):
            s = c.task['success']; geom = c.m.geom(s['geom']).id
            pairs = [{x.geom1, x.geom2} for x in c.d.contact]
            pos = c.d.body(s['body']).xpos.copy()
            dof = c.m.joint(s['freeJoint']).dofadr[0]
            released = not any({geom, c.m.geom(name).id} in pairs for name in s['fingerGeoms'])
            placed = bool({geom, c.m.geom(s['supportGeom']).id} in pairs and
                          np.all(np.abs(pos[s['axes']]-s['center']) < s['tolerance']) and
                          np.linalg.norm(c.d.qvel[dof:dof+6]) < s['maxSpeed'])
            evidence = {'bilateral_contact': bool(self.bilateral), 'maximum_height': self.highest if np.isfinite(self.highest) else None,
                        'placement_verified': placed, 'no_finger_contact': released, 'object_position': pos.tolist()}
            passed = placed and self.bilateral and self.highest > s['minLiftHeight']
        else:
            target = c.task['phases'][-1]['targets']
            passed = len(self.reached) == len(c.task['phases']) and np.max(np.abs(c.d.qpos[c.qadr]-target)) < c.task['tolerance'] and np.max(np.abs(c.d.qvel[c.vadr])) < c.task['maxSpeed']
            evidence = {'phases_physically_reached': sorted(self.reached), 'joint_positions': c.d.qpos[c.qadr].tolist()}
        return {'success': bool(passed and c.phase == 'complete' and not warnings and c.m.neq == 0),
                'warnings': warnings, 'equality_constraints': c.m.neq, **evidence}


def distribution(values: list[float] | deque[float]) -> dict[str, float]:
    """Summarize bounded timing samples in milliseconds."""
    return dict(zip(('p50_ms', 'p95_ms', 'p99_ms'), map(float, np.percentile(values, [50, 95, 99])*1000))) if values else {}


def synchronized(method: Callable[..., Any]) -> Callable[..., Any]:
    """Serialize public host operations against the physics owner thread."""
    @wraps(method)
    def locked(self: Any, *args: Any, **kwargs: Any) -> Any:
        """Hold the session lock for one atomic host operation."""
        with self.lock:
            return method(self, *args, **kwargs)
    return locked


class LiveRuntime:
    """Single-owner host with fixed physics ticks and bounded wall-clock catch-up."""

    def __init__(self, folder: Path, backend: str = 'wasm', control_every: int = 1,
                 max_catchup: int = 8, policy_factory: Callable[[], NativePolicy] | None = None) -> None:
        """Load a scenario, compile its policy and initialize host lifecycle state."""
        if backend not in ('wasm', 'native') or type(control_every) is not int or control_every < 1 or type(max_catchup) is not int or max_catchup < 1:
            raise ValueError('Invalid backend or scheduling configuration')
        self.lock = threading.RLock()
        self.worker_stop = threading.Event()
        self.worker: threading.Thread | None = None
        self.folder, self.backend = folder.resolve(), backend
        self.control_every, self.max_catchup = control_every, max_catchup
        self.factory = policy_factory or (WasmPolicy if backend == 'wasm' else NativePolicy)
        self.cell: Any = None
        self.policy: Any = None
        self.state = 'ready'
        self.load_seconds = 0.
        self.reset()

    @synchronized
    def reset(self) -> None:
        """Rebuild a fresh world and guest, clear commands and restore initial state."""
        if self.state == 'disposed':
            raise RuntimeError('Runtime disposed')
        start = time.perf_counter()
        replacement_cell = make_cell(self.folder)
        replacement_policy = self.factory()
        if self.policy is not None:
            self.policy.close()
        self.cell = replacement_cell
        self.policy = replacement_policy
        self.cell.policy = self.policy
        self.assessment = Assessment(self.cell)
        self.state, self.error, self.steps = 'ready', None, 0
        self.pending: deque[tuple[float, int, float | None]] = deque()
        self.tick_times: deque[float] = deque(maxlen=100000)
        self.control_times: deque[float] = deque(maxlen=100000)
        self.latencies: deque[float] = deque(maxlen=100000)
        self.frames: deque[float] = deque(maxlen=100000)
        self.trajectory: list[dict[str, Any]] = []
        self.missed_deadlines, self.overloads, self.discarded_wall_seconds = 0, 0, 0.
        self.next_tick: float | None = None
        self.load_seconds = time.perf_counter()-start

    @synchronized
    def start(self) -> None:
        """Start/resume execution; terminal sessions require an explicit reset."""
        if self.state not in ('ready', 'paused'):
            raise ValueError(f'Cannot start from {self.state}')
        try:
            self.cell.command('start')
            self.state = 'running'
            self.next_tick = None
        except Exception as error:
            self.fault(str(error))

    @synchronized
    def pause(self) -> None:
        """Freeze physics and discard wall-clock debt accumulated before resuming."""
        if self.state != 'running':
            raise ValueError('Pause requires running state')
        self.cell.command('pause'); self.state = 'paused'; self.next_tick = None

    @synchronized
    def stop(self) -> None:
        """Stop this execution without pretending it completed successfully."""
        if self.state == 'disposed':
            raise ValueError('Runtime disposed')
        self.cell.running = False; self.state = 'stopped'; self.pending.clear(); self.next_tick = None

    def dispose(self) -> None:
        """Release guest and world resources; this session cannot restart."""
        self.stop_worker()
        if self.state != 'disposed':
            self.stop(); self.policy.close(); self.cell = None; self.assessment = None; self.policy = None; self.state = 'disposed'

    def start_worker(self) -> None:
        """Own the paced physics clock independently of rendering or state polling."""
        if self.worker is not None and self.worker.is_alive():
            return
        self.worker_stop.clear()
        def run() -> None:
            """Advance bounded due ticks until the host explicitly disposes the worker."""
            while not self.worker_stop.is_set():
                try:
                    self.pump()
                except Exception as error:
                    self.fault(str(error))
                self.worker_stop.wait(.0002)
        self.worker = threading.Thread(target=run, name='oi-physics', daemon=True)
        self.worker.start()

    def stop_worker(self) -> None:
        """Join the physics owner before disposing guest/model resources."""
        self.worker_stop.set()
        if self.worker is not None:
            self.worker.join(timeout=5)
            if self.worker.is_alive():
                raise RuntimeError('Physics worker did not stop')
            self.worker = None

    @synchronized
    def fault(self, message: str) -> None:
        """Expose execution failures and halt physics advancement."""
        self.error = message; self.state = 'fault'; self.cell.running = False

    @synchronized
    def actuator(self, name: str, value: float | None) -> None:
        """Queue a persistent actuator override (None releases it) for the next tick."""
        if self.state not in ('ready', 'paused', 'running'):
            raise ValueError('Cannot command terminal runtime')
        act = mj.mj_name2id(self.cell.m, mj.mjtObj.mjOBJ_ACTUATOR, name)
        if act < 0:
            raise ValueError('Unknown actuator')
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or not self.cell.m.actuator_ctrllimited[act] or not self.cell.m.actuator_ctrlrange[act, 0] <= value <= self.cell.m.actuator_ctrlrange[act, 1]):
            raise ValueError('Actuator command outside finite declared limits')
        if len(self.pending) >= 1024:
            raise ValueError('Command queue full')
        self.pending.append((time.perf_counter(), act, value))

    @synchronized
    def step(self) -> None:
        """Advance exactly one configured physics step, retaining pause afterward."""
        if self.state not in ('ready', 'paused'):
            raise ValueError('Single-step requires ready or paused state')
        self.start(); self.tick()
        if self.state == 'running':
            self.pause()

    @synchronized
    def tick(self) -> None:
        """Apply commands FIFO at a tick boundary, then control, physics and assessment."""
        if self.state != 'running':
            return
        begin = time.perf_counter()
        applied = []
        while self.pending:
            stamp, act, value = self.pending.popleft(); applied.append(stamp)
            if value is None:
                self.cell.overrides.pop(act, None)
            else:
                self.cell.overrides[act] = value
        self.cell.control_due = self.steps % self.control_every == 0
        before_time = self.cell.d.time
        self.cell.tick()
        elapsed = time.perf_counter()-begin
        self.tick_times.append(elapsed)
        if self.cell.control_due:
            self.control_times.append(elapsed)
        if elapsed > self.cell.m.opt.timestep:
            self.missed_deadlines += 1
        self.steps += int(self.cell.d.time > before_time)
        # Keep predicates in the existing controller on their original sampling path;
        # refresh kinematics for public observations only after its transition logic.
        mj.mj_forward(self.cell.m, self.cell.d)
        self.assessment.sample()
        if self.steps % 10 == 0 or not self.cell.running:
            if len(self.trajectory) < 100000:
                self.trajectory.append({'time': float(self.cell.d.time), 'phase': self.cell.phase,
                                        'qpos': self.cell.d.qpos.tolist()})
        self.latencies.extend(time.perf_counter()-stamp for stamp in applied)
        if self.cell.phase == 'fault':
            self.fault(self.cell.error or 'Controller fault')
        elif not self.cell.running:
            self.state = 'completed'

    @synchronized
    def pump(self, now: float | None = None) -> int:
        """Run bounded due ticks; report discarded wall debt without altering timestep."""
        if self.state != 'running':
            return 0
        now = time.perf_counter() if now is None else now
        dt = float(self.cell.m.opt.timestep)
        if self.next_tick is None:
            self.next_tick = now+dt
        due = max(0, int((now-self.next_tick)/dt)+1) if now >= self.next_tick else 0
        count = min(due, self.max_catchup)
        if due > self.max_catchup:
            self.overloads += 1
            self.discarded_wall_seconds += (due-count)*dt
            self.next_tick += (due-count)*dt
        executed = 0
        for _ in range(count):
            if self.state != 'running':
                break
            self.tick(); self.next_tick += dt; executed += 1
        return executed

    @synchronized
    def snapshot(self) -> dict[str, Any]:
        """Return copied JSON-compatible observations; reads never advance simulation."""
        if self.cell is None:
            return {'state': self.state}
        c = self.cell
        return {'state': self.state, 'phase': c.phase, 'error': self.error or c.error,
                'time': float(c.d.time), 'steps': self.steps, 'qpos': c.d.qpos.tolist(), 'qvel': c.d.qvel.tolist(),
                'actuators': {mj.mj_id2name(c.m, mj.mjtObj.mjOBJ_ACTUATOR, i) or str(i): float(c.d.ctrl[i]) for i in range(c.m.nu)},
                'bodies': {mj.mj_id2name(c.m, mj.mjtObj.mjOBJ_BODY, i) or str(i): {'position': c.d.xpos[i].tolist(), 'quaternion_wxyz': c.d.xquat[i].tolist()} for i in range(c.m.nbody)},
                'contacts': [[int(x.geom1), int(x.geom2)] for x in c.d.contact],
                'overloads': self.overloads, 'discarded_wall_seconds': self.discarded_wall_seconds}

    @synchronized
    def report(self, wall: float, cpu: float) -> dict[str, Any]:
        """Report physical results, timing distributions, provenance and resource use."""
        from importlib.metadata import version
        c = self.cell
        return {'backend': self.backend, 'native_components': ['MuJoCo', 'IK', 'host', 'renderer'],
                'wasm_components': ['actuator slew', 'phase transition decisions'] if self.backend == 'wasm' else [],
                'state': self.snapshot(), 'assessment': self.assessment.report(),
                'implementation_sha256': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ('live_runtime.py', 'wasm_policy.py', 'json_workcell.py', 'live_viewer.py')},
                'configuration_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(self.folder.glob('*.json'))},
                'versions': {x: version(x) for x in ('mujoco', 'wasmtime', 'pygfx', 'wgpu')},
                'platform': platform.platform(), 'python': platform.python_version(),
                'cpu': next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), platform.processor()) if Path('/proc/cpuinfo').exists() else platform.processor(),
                'startup_seconds': self.load_seconds, 'wall_seconds': wall, 'cpu_seconds': cpu,
                'cpu_percent_one_core': 100*cpu/wall if wall else 0,
                'peak_process_rss_kib': (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 if platform.system() == 'Darwin' else 1)) if resource else None,
                'simulation_wall_ratio': float(c.d.time)/wall if wall else 0,
                'physics_dt': float(c.m.opt.timestep), 'control_every': self.control_every,
                'tick_latency': distribution(self.tick_times),
                'control_tick_including_physics_latency': distribution(self.control_times),
                'command_to_observation_latency': distribution(self.latencies),
                'missed_compute_deadlines': self.missed_deadlines,
                'rendered_fps': (len(self.frames)-1)/(self.frames[-1]-self.frames[0]) if len(self.frames)>1 else 0,
                'frames': len(self.frames), 'events': c.events, 'trajectory': self.trajectory}


def main() -> int:
    """Run a JSON scenario interactively, headlessly, or with offscreen live rendering."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('--backend', choices=['wasm', 'native'], default='wasm')
    parser.add_argument('--view', choices=['headless', 'window', 'offscreen'], default='headless')
    parser.add_argument('--fast', action='store_true', help='Unpaced headless throughput measurement')
    parser.add_argument('--control-every', type=int, default=1)
    parser.add_argument('--fps', type=float, default=30)
    parser.add_argument('--max-wall', type=float, default=120)
    parser.add_argument('--report', type=Path, default=Path('live-report.json'))
    parser.add_argument('--probe-commands', action='store_true', help='Measure harmless override-release commands at 10 Hz')
    parser.add_argument('--gif', type=Path, help='Record frames captured during the live render loop')
    args = parser.parse_args()
    if args.gif and args.view != 'offscreen':
        parser.error('--gif requires --view offscreen')
    if args.fast and args.view != 'headless' or not math.isfinite(args.fps) or not 1 <= args.fps <= 120 or not math.isfinite(args.max_wall) or args.max_wall <= 0:
        parser.error('Invalid pacing, FPS or duration')
    runtime = LiveRuntime(args.config, args.backend, args.control_every)
    renderer = None
    render_start = time.perf_counter()
    if args.view != 'headless':
        from live_viewer import LiveViewer
        renderer = LiveViewer(runtime, args.view, args.fps, args.gif)
        renderer.draw()
        renderer.startup_seconds = time.perf_counter()-render_start
        runtime.frames.clear()  # Exclude first-frame shader compilation from steady-state FPS.
    begin, cpu = time.perf_counter(), time.process_time()
    runtime.start()
    if not args.fast:
        runtime.start_worker()
    try:
        if args.view == 'window':
            renderer.run(args.max_wall)
        else:
            next_frame = begin
            next_probe = begin
            while runtime.state == 'running' and time.perf_counter()-begin < args.max_wall:
                if args.fast:
                    runtime.tick()
                now = time.perf_counter()
                if args.probe_commands and now >= next_probe and runtime.state == 'running':
                    runtime.actuator(mj.mj_id2name(runtime.cell.m, mj.mjtObj.mjOBJ_ACTUATOR, 0), None)
                    next_probe = now+.1
                if renderer is not None and now >= next_frame:
                    renderer.draw(); next_frame += (max(1, int((now-next_frame)*args.fps)+1))/args.fps
                if not args.fast:
                    time.sleep(.0005)
        runtime.stop_worker()
        if runtime.state == 'running':
            runtime.fault('Wall-time execution budget exceeded')
        report = runtime.report(time.perf_counter()-begin, time.process_time()-cpu)
        report['view'] = args.view; report['paced'] = not args.fast
        if renderer:
            import wgpu
            report['graphics_adapter'] = dict(wgpu.get_default_device().adapter.info)
        if renderer:
            report['renderer_startup_seconds'] = renderer.startup_seconds
            renderer.finish()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps({k: report[k] for k in ('backend', 'assessment', 'simulation_wall_ratio', 'rendered_fps', 'missed_compute_deadlines')}, indent=2))
        return 0 if report['assessment']['success'] else 1
    finally:
        if renderer:
            renderer.close()
        runtime.dispose()


if __name__ == '__main__':
    raise SystemExit(main())
