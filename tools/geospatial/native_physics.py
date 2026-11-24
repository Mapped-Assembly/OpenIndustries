"""MuJoCo is the authority for physics; bind its body poses to OI visuals."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pygfx as gfx

# Same right-handed Z-up -> Y-up conversion as OI's embodied scene adapter.
Y_FROM_Z = np.array([[1., 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]])


class PhysicsReplay:
    """Step an explicit MJCF model and capture immutable visual pose samples."""

    def __init__(self, model_path: Path, bindings_path: Path, scene: gfx.Scene) -> None:
        """Load a model, exact visual bindings and optional constant actuator controls."""
        try:
            import mujoco
        except ImportError as error:
            raise ValueError("Install physics support with pip install -e '.[native-render,physics]'") from error
        self.scene = scene  # Pygfx parent references are weak; retain the scene.
        self.mj = mujoco
        self.model = mujoco.MjModel.from_xml_path(str(model_path.resolve()))
        self.data = mujoco.MjData(self.model)
        self.config = json.loads(bindings_path.read_text())
        if self.config.get('version') != 1 or self.config.get('modelUpAxis') != 'Z':
            raise ValueError('Physics bindings require version 1 and modelUpAxis Z')
        if not 0.0001 <= self.model.opt.timestep <= 0.02:
            raise ValueError('MuJoCo timestep must be between 0.0001 and 0.02 seconds')
        if self.config.get('keyframe') is not None:
            key = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_KEY, self.config['keyframe'])
            if key < 0:
                raise ValueError('Unknown MuJoCo keyframe')
            mujoco.mj_resetDataKeyframe(self.model, self.data, key)
        self.data.time = 0.0
        for name, value in self.config.get('controls', {}).items():
            actuator = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
            if actuator < 0 or isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value):
                raise ValueError('Invalid actuator control')
            if self.model.actuator_ctrllimited[actuator] and not self.model.actuator_ctrlrange[actuator, 0] <= value <= self.model.actuator_ctrlrange[actuator, 1]:
                raise ValueError('Actuator control exceeds its declared range')
            self.data.ctrl[actuator] = value
        groups = {obj.name: obj for obj in scene.children if isinstance(obj, gfx.Group)}
        self.bindings: list[tuple[gfx.WorldObject, int, np.ndarray]] = []
        seen: set[tuple[str, str | None]] = set()
        entries = self.config.get('bindings')
        if not isinstance(entries, list) or not entries:
            raise ValueError('At least one explicit body-to-visual binding is required')
        # Parent instance transforms must be applied before child part transforms.
        for entry in sorted(entries, key=lambda item: item.get('partId') is not None):
            target = (entry['instanceId'], entry.get('partId'))
            if target in seen or target[0] not in groups:
                raise ValueError('Duplicate or missing physics visual target')
            seen.add(target)
            group = groups[target[0]]
            obj = group if target[1] is None else next((obj for obj in group.children if obj.name == target[1]), None)
            if obj is None:
                raise ValueError('Missing physics part target')
            body = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, entry['body'])
            if body < 0:
                raise ValueError('Unknown MuJoCo body')
            offset = np.asarray(entry['bodyFromVisual'], dtype=float)
            if offset.shape != (4, 4) or not np.isfinite(offset).all() or not np.allclose(offset[3], [0, 0, 0, 1]):
                raise ValueError('bodyFromVisual must be a finite affine 4x4 matrix')
            if not np.allclose(offset[:3, :3].T @ offset[:3, :3], np.eye(3), atol=1e-6) or not np.isclose(np.linalg.det(offset[:3, :3]), 1):
                raise ValueError('bodyFromVisual must be a rigid transform without scale/reflection')
            self.bindings.append((obj, body, offset))
        self.report: dict[str, Any] = {
            'engine': 'mujoco', 'version': mujoco.__version__, 'timestep': float(self.model.opt.timestep),
            'model_sha256': hashlib.sha256(model_path.read_bytes()).hexdigest(),
            'bindings_sha256': hashlib.sha256(bindings_path.read_bytes()).hexdigest(),
            'bound_visuals': len(self.bindings), 'controls': self.config.get('controls', {}),
            'model_up_axis': 'Z', 'visual_up_axis': 'Y',
            'limitations': 'Explicit MJCF dynamics only; unbound OI visuals have no inferred collision or mass. Model hash covers the root XML, not external includes/assets.'}

    def sample(self, times: list[float]) -> list[list[np.ndarray]]:
        """Integrate fixed physics steps, independently of render fps, and retain poses."""
        if not times or not np.isfinite(times).all() or min(times) < 0 or times != sorted(times) or max(times) > 120:
            raise ValueError('Physics sample times must be ordered within 0..120 seconds')
        frames: list[list[np.ndarray]] = []
        actual_times, contact_counts = [], []
        for time in times:
            while self.data.time + 1e-10 < time:
                self.mj.mj_step(self.model, self.data)
                if any(w.number for w in self.data.warning):
                    raise ValueError('MuJoCo reported a simulation warning; refusing invalid physics output')
            self.mj.mj_forward(self.model, self.data)
            if not np.isfinite(self.data.qpos).all() or not np.isfinite(self.data.qvel).all():
                raise ValueError('Nonfinite MuJoCo state')
            matrices = []
            for _, body, offset in self.bindings:
                transform = np.eye(4)
                transform[:3, :3] = self.data.xmat[body].reshape(3, 3)
                transform[:3, 3] = self.data.xpos[body]
                matrices.append(Y_FROM_Z @ transform @ offset)
            frames.append(matrices)
            actual_times.append(float(self.data.time))
            contact_counts.append(int(self.data.ncon))
        self.report.update(sample_times=actual_times, contact_counts=contact_counts,
                           final_qpos=self.data.qpos.tolist(), final_qvel=self.data.qvel.tolist())
        return frames

    def apply(self, matrices: list[np.ndarray]) -> None:
        """Apply authoritative world poses, converting to each visual's parent frame."""
        for (obj, _, _), matrix in zip(self.bindings, matrices, strict=True):
            obj.local.matrix = np.linalg.inv(obj.parent.world.matrix) @ matrix
