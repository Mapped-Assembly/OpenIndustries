"""Record independently assessed physics trajectories and replay them for native rendering."""
from __future__ import annotations

from bisect import bisect_left
from typing import Any, Protocol

import mujoco as mj
import numpy as np
import pygfx as gfx

from native_physics import Y_FROM_Z


class Controller(Protocol):
    """Minimal simulation/controller interface shared by baseline and configured executors."""
    m: mj.MjModel
    d: mj.MjData
    phase: str
    running: bool
    error: str | None
    events: list[dict[str, Any]]

    def command(self, command: str) -> None:
        """Start or pause the task."""
        ...

    def tick(self) -> None:
        """Advance one feedback/physics step."""
        ...


def record_trial(cell: Controller, task: dict[str, Any]) -> tuple[list[float], list[np.ndarray], dict[str, Any]]:
    """Measure contacts, lift and placement directly from mjData, not controller claims."""
    success, budget = task['success'], task['record']
    object_geom = cell.m.geom(success['geom']).id
    pads = [cell.m.geom(name).id for name in success['fingerGeoms']]
    support = cell.m.geom(success['supportGeom']).id
    dof = cell.m.joint(success['freeJoint']).dofadr[0]
    qadr = [cell.m.joint(name).qposadr[0] for name in task['robot']['armJoints'] + [task['robot']['gripperJoint']]]
    times, states, trajectory = [], [], []
    highest, bilateral = -float('inf'), False
    cell.command('start')
    for step in range(budget['maxSteps']):
        cell.tick()
        mj.mj_forward(cell.m, cell.d)
        position = cell.d.body(success['body']).xpos.copy()
        highest = max(highest, float(position[success['heightAxis']]))
        pairs = [{contact.geom1, contact.geom2} for contact in cell.d.contact]
        bilateral |= all({object_geom, pad} in pairs for pad in pads)
        if step % budget['sampleEverySteps'] == 0 or not cell.running:
            matrices = np.repeat(np.eye(4)[None], cell.m.nbody, axis=0)
            matrices[:, :3, :3] = cell.d.xmat.reshape(-1, 3, 3)
            matrices[:, :3, 3] = cell.d.xpos
            times.append(float(cell.d.time)); states.append(matrices)
            trajectory.append({'time': float(cell.d.time), 'object_position': position.tolist(),
                               'joints': cell.d.qpos[qadr].tolist(), 'phase': cell.phase})
        if not cell.running:
            break
    placed = bool({object_geom, support} in pairs and
                  np.all(np.abs(position[success['axes']]-success['center']) < success['tolerance']) and
                  np.linalg.norm(cell.d.qvel[dof:dof+6]) < success['maxSpeed'])
    warnings = int(sum(w.number for w in cell.d.warning))
    result = {'engine': 'mujoco', 'version': mj.__version__,
              'success': bool(cell.phase == 'complete' and placed and bilateral and highest > success['minLiftHeight'] and not warnings and cell.m.neq == 0),
              'duration_seconds': float(cell.d.time), 'timestep': float(cell.m.opt.timestep),
              'bilateral_contact_observed': bool(bilateral), 'maximum_object_height_m': highest,
              'placement_verified': placed, 'final_object_position_m': position.tolist(),
              'final_object_speed': float(np.linalg.norm(cell.d.qvel[dof:dof+6])),
              'equality_constraints': int(cell.m.neq), 'warnings': warnings, 'error': cell.error,
              'phase': cell.phase, 'events': cell.events, 'trajectory': trajectory}
    return times, states, result


class RecordedReplay:
    """Replay measured physics body transforms without creating motion or attachments."""

    def __init__(self, scene: gfx.Scene, bindings: list[dict[str, Any]], times: list[float],
                 states: list[np.ndarray], report: dict[str, Any]) -> None:
        """Resolve compiled visual instances against their recorded parent bodies."""
        self.scene, self.times, self.states, self.report = scene, times, states, report
        groups = {obj.name: obj for obj in scene.children if isinstance(obj, gfx.Group)}
        self.bindings = [(groups[b['instanceId']], b['body'], b['bodyFromVisual']) for b in bindings]

    def sample(self, times: list[float]) -> list[list[np.ndarray]]:
        """Select the first recorded sample at or after each requested render time."""
        frames, actual = [], []
        for time in times:
            if time < 0 or time > self.times[-1]:
                raise ValueError('Requested time exceeds the recorded trajectory')
            index = min(bisect_left(self.times, time), len(self.times)-1)
            frames.append([Y_FROM_Z @ self.states[index][body] @ offset for _, body, offset in self.bindings])
            actual.append(self.times[index])
        self.report['render_sample_times'] = actual
        return frames

    def apply(self, matrices: list[np.ndarray]) -> None:
        """Apply one authoritative world-pose sample to visual groups."""
        for (obj, _, _), matrix in zip(self.bindings, matrices, strict=True):
            obj.local.matrix = matrix
