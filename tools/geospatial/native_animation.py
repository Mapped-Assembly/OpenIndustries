"""Validated sampling of OI instance and part tracks for native rendering."""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pygfx as gfx
import pylinalg as la

from export_scene import finite, vector


def validate_animation(document: dict[str, Any], scene: gfx.Scene) -> list[dict[str, Any]]:
    """Validate timeline targets and keys before rendering any animation frames."""
    animation = document.get('animation', {})
    if not isinstance(animation, dict):
        raise ValueError('Animation must be an object')
    duration = finite(animation.get('duration'), 'animation.duration')
    if not 0.5 <= duration <= 120 or not isinstance(animation.get('loop'), bool):
        raise ValueError('Invalid animation duration or loop flag')
    tracks = animation.get('tracks')
    if not isinstance(tracks, list) or len(tracks) > 1000:
        raise ValueError('Animation tracks must be an array of at most 1000 tracks')
    groups = {obj.name: obj for obj in scene.children if isinstance(obj, gfx.Group)}
    seen: set[tuple[str, str | None]] = set()
    count = 0
    result = []
    for track in tracks:
        if not isinstance(track, dict):
            raise ValueError('Animation track must be an object')
        instance, part = track.get('instanceId'), track.get('partId')
        if not isinstance(instance, str) or (part is not None and not isinstance(part, str)):
            raise ValueError('Animation target identifiers must be strings')
        target = (instance, part)
        if instance not in groups or target in seen:
            raise ValueError('Duplicate or missing animation target')
        if part is not None and part not in {obj.name for obj in groups[instance].children}:
            raise ValueError('Missing animation part target')
        seen.add(target)
        keys = track.get('keys')
        if not isinstance(keys, list) or not keys:
            raise ValueError('Animation tracks need keys')
        times: set[float] = set()
        for key in keys:
            if not isinstance(key, dict):
                raise ValueError('Animation key must be an object')
            count += 1
            time = finite(key.get('time'), 'key.time')
            if count > 10000 or not 0 <= time <= duration or time in times:
                raise ValueError('Invalid or duplicate key time, or too many keys')
            times.add(time)
            vector(key.get('position'), 'key.position')
            vector(key.get('rotation'), 'key.rotation')
            if 'visible' in key and (part is not None or not isinstance(key['visible'], bool)):
                raise ValueError('Visibility keys must be booleans on instance tracks')
        result.append({**track, 'keys': sorted(keys, key=lambda key: key['time'])})
    return result


def quaternion(rotation: list[float]) -> np.ndarray:
    """Convert Three.js intrinsic XYZ degrees to an xyzw unit quaternion."""
    x, y, z = np.radians(rotation) / 2
    c1, c2, c3 = np.cos([x, y, z])
    s1, s2, s3 = np.sin([x, y, z])
    return np.array([s1*c2*c3+c1*s2*s3, c1*s2*c3-s1*c2*s3,
                     c1*c2*s3+s1*s2*c3, c1*c2*c3-s1*s2*s3])


def sample_matrix(keys: list[dict[str, Any]], time: float) -> np.ndarray:
    """Clamp poses at endpoints; linearly interpolate position and slerp rotation."""
    a = b = keys[0]
    if time >= keys[-1]['time']:
        a = b = keys[-1]
    elif time > keys[0]['time']:
        right = next(i for i, key in enumerate(keys) if key['time'] > time)
        a, b = keys[right-1:right+1]
    t = 0 if a is b else (time-a['time']) / (b['time']-a['time'])
    qa, qb = quaternion(a['rotation']), quaternion(b['rotation'])
    dot = float(np.dot(qa, qb))
    if dot < 0:
        qb, dot = -qb, -dot
    if dot > 0.9995:
        q = qa + t * (qb-qa)
        q /= np.linalg.norm(q)
    else:
        angle = math.acos(np.clip(dot, -1, 1))
        q = (math.sin((1-t)*angle)*qa + math.sin(t*angle)*qb) / math.sin(angle)
    matrix = la.mat_from_quat(q)
    matrix[:3, 3] = (1-t)*np.array(a['position']) + t*np.array(b['position'])
    return matrix


def apply_animation(scene: gfx.Scene, tracks: list[dict[str, Any]], time: float,
                    base_visibility: dict[str, bool]) -> None:
    """Apply instance poses and part poses around each part's local bounds center."""
    groups = {obj.name: obj for obj in scene.children if isinstance(obj, gfx.Group)}
    for track in tracks:
        group = groups[track['instanceId']]
        matrix = sample_matrix(track['keys'], time)
        if track.get('partId') is not None:
            mesh = next(obj for obj in group.children if obj.name == track['partId'])
            vertices = mesh.geometry.positions.data
            pivot = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
            matrix[:3, 3] += pivot - matrix[:3, :3] @ pivot
            mesh.local.matrix = matrix
        else:
            group.local.matrix = matrix
            visible = base_visibility[group.name]
            for key in track['keys']:
                if key['time'] <= time and 'visible' in key:
                    visible = key['visible']
            group.visible = visible
