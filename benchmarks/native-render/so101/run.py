"""Run and verify SO-101 contact pick-and-place, then render its MuJoCo trajectory."""
from __future__ import annotations

import argparse
from bisect import bisect_left
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

import mujoco
import numpy as np
import pygfx as gfx

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tools/geospatial'))
from native_mujoco_scene import project_model
from native_physics import Y_FROM_Z
from native_render import render_gif
from controller import Cell
from fetch_assets import main as fetch_assets


class RecordedReplay:
    """Display recorded physics world poses, without recomputing or inventing motion."""

    def __init__(self, scene: gfx.Scene, bindings: list[dict[str, Any]], times: list[float],
                 states: list[np.ndarray], report: dict[str, Any]) -> None:
        """Bind each compiled visual geom to its recorded parent body pose."""
        self.scene, self.times, self.states, self.report = scene, times, states, report
        groups = {obj.name: obj for obj in scene.children if isinstance(obj, gfx.Group)}
        self.bindings = [(groups[b['instanceId']], b['body'], b['bodyFromVisual']) for b in bindings]

    def sample(self, times: list[float]) -> list[list[np.ndarray]]:
        """Select the first recorded physics sample at/after each GIF timestamp."""
        frames, actual = [], []
        for time in times:
            if time < 0 or time > self.times[-1]:
                raise ValueError('Requested render time exceeds recorded physics')
            index = min(bisect_left(self.times, time), len(self.times)-1)
            frames.append([Y_FROM_Z @ self.states[index][body] @ offset for _, body, offset in self.bindings])
            actual.append(self.times[index])
        self.report['render_sample_times'] = actual
        return frames

    def apply(self, matrices: list[np.ndarray]) -> None:
        """Update visual groups from the recorded physics frame."""
        for (obj, _, _), matrix in zip(self.bindings, matrices, strict=True):
            obj.local.matrix = matrix


def record(cell: Cell) -> tuple[list[float], list[np.ndarray], dict[str, Any]]:
    """Drive actuator controls and validate physical task outcome before rendering."""
    if cell.m.neq:
        raise ValueError('No attachment/weld constraints are permitted in this proof')
    times, states, trajectory = [], [], []
    max_height = 0.
    bilateral = False
    cell.command('start')
    for step in range(30000):
        cell.tick()
        mujoco.mj_forward(cell.m, cell.d)
        position = cell.d.body('can0').xpos.copy()
        max_height = max(max_height, float(position[2]))
        bilateral |= cell.contact(0, 'fixed-pad') and cell.contact(0, 'moving-pad')
        if step % 10 == 0 or not cell.running:
            matrices = np.repeat(np.eye(4)[None], cell.m.nbody, axis=0)
            matrices[:, :3, :3] = cell.d.xmat.reshape(-1, 3, 3)
            matrices[:, :3, 3] = cell.d.xpos
            times.append(float(cell.d.time))
            states.append(matrices)
            trajectory.append({'time': float(cell.d.time), 'can_position': position.tolist(),
                               'joints': cell.d.qpos[:6].tolist(), 'phase': cell.phase})
        if not cell.running:
            break
    success = cell.phase == 'complete' and cell.placed(0) and bilateral and max_height > .065
    report = {'engine': 'mujoco', 'version': mujoco.__version__, 'success': success,
              'controller': 'scripted feedback state machine with Jacobian IK and position actuators',
              'duration_seconds': float(cell.d.time), 'timestep': float(cell.m.opt.timestep),
              'bilateral_contact_observed': bool(bilateral), 'maximum_can_height_m': max_height,
              'placement_verified': bool(cell.placed(0)), 'final_can_position_m': position.tolist(),
              'equality_constraints': int(cell.m.neq), 'warnings': int(sum(w.number for w in cell.d.warning)),
              'error': cell.error, 'events': cell.events, 'trajectory': trajectory,
              'limitations': 'Simulation assumptions: authored finger-pad collision proxies, friction and actuator tuning; not calibrated hardware validation.'}
    if not success:
        raise RuntimeError(json.dumps(report, default=str))
    return times, states, report


def negative_check() -> dict[str, Any]:
    """Disabling finger contacts must prevent task success instead of faking attachment."""
    cell = Cell()
    for name in ('fixed-pad', 'moving-pad'):
        index = cell.m.geom(name).id
        cell.m.geom_contype[index] = cell.m.geom_conaffinity[index] = 0
    cell.command('start')
    for _ in range(10000):
        cell.tick()
        if not cell.running:
            break
    if cell.phase != 'fault' or not cell.error or 'Grasp failed' not in cell.error or cell.index:
        raise AssertionError('Disabled fingers did not produce the expected grasp failure')
    return {'passed': True, 'phase': cell.phase, 'error': cell.error, 'sim_time': float(cell.d.time)}


def main() -> None:
    """Verify real contact manipulation and export a browser-free native GIF."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('pick-and-place.gif'))
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    fetch_assets()
    cell = Cell()
    times, states, report = record(cell)
    report['disabled_finger_test'] = negative_check()
    report['controller_sha256'] = hashlib.sha256(Path(__file__).with_name('controller.py').read_bytes()).hexdigest()
    report['source_lock_sha256'] = hashlib.sha256(Path(__file__).with_name('source-lock.json').read_bytes()).hexdigest()
    if not args.verify_only:
        # Presentation-only exclusions; physics still includes the floor and table legs.
        excluded = {'floor', 'camera-post', 'camera-arm', 'inspection-camera', 'camera-lens'} | {cell.m.geom(i).name for i in range(cell.m.ngeom) if cell.m.geom(i).name.startswith('leg')}
        doc, bindings = project_model(cell.m, excluded, [1, 1, 1])
        def factory(scene: gfx.Scene) -> RecordedReplay:
            """Connect the verified trajectory to the native rendering pipeline."""
            return RecordedReplay(scene, bindings, times, states, report)
        encoded = render_gif(doc, args.output, width=560, height=400, duration=times[-1], fps=15,
                             motion='physics', physics_factory=factory, room_guides=False,
                             azimuth=135, elevation=30, loop=True,
                             frame_instances={b['instanceId'] for b in bindings if b['body'] != 0})
        report['gif'] = {k: v for k, v in encoded.items() if k != 'physics'}
        report['gif_sha256'] = hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix('.render.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('success', 'duration_seconds', 'bilateral_contact_observed',
                     'maximum_can_height_m', 'placement_verified', 'final_can_position_m', 'disabled_finger_test')}, indent=2))


if __name__ == '__main__':
    main()
