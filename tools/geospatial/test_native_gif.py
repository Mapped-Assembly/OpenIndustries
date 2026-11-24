"""Numerical timeline and decoded GIF tests for native OI export."""
from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from export_scene import pose_matrix
from native_animation import apply_animation, quaternion, sample_matrix, validate_animation
from native_render import build_scene, render_gif
from test_native_render import fixture
import pylinalg as la


def test_xyz_quaternion_matches_oi() -> None:
    """Check mixed-axis quaternion conventions against the existing OI transform."""
    for angles in ([30, 60, -45], [90, 0, 90], [0, 350, 0]):
        np.testing.assert_allclose(la.mat_from_quat(quaternion(angles)), pose_matrix([0, 0, 0], angles), atol=1e-7)


def test_shortest_arc_and_clamped_pose() -> None:
    """350 to 10 degrees must cross zero, not swing backwards through 180."""
    keys = [{'time': 0, 'position': [0, 0, 0], 'rotation': [0, 350, 0]},
            {'time': 2, 'position': [2, 0, 0], 'rotation': [0, 10, 0]}]
    expected = np.eye(4)
    expected[0, 3] = 1
    np.testing.assert_allclose(sample_matrix(keys, 1), expected, atol=1e-7)
    np.testing.assert_allclose(sample_matrix(keys, -1), pose_matrix(keys[0]['position'], keys[0]['rotation']), atol=1e-7)


def test_part_pivot_and_held_visibility() -> None:
    """Part rotations preserve the mesh center; visibility is held from base/keys."""
    doc = fixture()
    inst = doc['instances'][0]
    inst['visible'] = False
    part = doc['bundledAssets'][0]['parts'][0]['id']
    keys = [{'time': 0, 'position': [0, 0, 0], 'rotation': [0, 0, 0]},
            {'time': 1, 'position': [1, 0, 0], 'rotation': [0, 90, 0], 'visible': True}]
    part_keys = copy.deepcopy(keys)
    part_keys[-1].pop('visible')
    doc['animation']['tracks'] = [{'instanceId': inst['id'], 'keys': keys},
                                  {'instanceId': inst['id'], 'partId': part, 'keys': part_keys}]
    scene = build_scene(doc, base_layout=True, include_hidden=True)
    tracks = validate_animation(doc, scene)
    visible = {i['id']: i['visible'] for i in doc['instances']}
    group = next(obj for obj in scene.children if obj.name == inst['id'])
    apply_animation(scene, tracks, .5, visible)
    assert not group.visible
    apply_animation(scene, tracks, 1, visible)
    assert group.visible
    mesh = next(obj for obj in group.children if obj.name == part)
    vertices = mesh.geometry.positions.data
    pivot = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
    np.testing.assert_allclose(mesh.local.matrix @ [*pivot, 1], [*(pivot + [1, 0, 0]), 1], atol=1e-7)


def test_turntable_gif_timing_and_pixels(tmp_path: Path) -> None:
    """Decode native GIF output and verify changing frames, timing, size and loop."""
    path = tmp_path / 'turntable.gif'
    report = render_gif(fixture(), path, width=320, height=240, duration=1, fps=15, base_layout=True)
    with Image.open(path) as gif:
        assert gif.size == (320, 240)
        assert gif.n_frames == 15
        assert gif.info['loop'] == 0
        frames, delays = [], []
        for index in range(gif.n_frames):
            gif.seek(index)
            frames.append(np.array(gif.convert('RGB')))
            delays.append(gif.info['duration'])
    assert sum(delays) == report['duration_ms'] == 1000
    assert set(delays) == {60, 70}
    assert np.count_nonzero(frames[0] != frames[7]) > 100


def test_authored_gif_and_no_loop(tmp_path: Path) -> None:
    """Render translation/rotation from real scene geometry with a fixed camera."""
    doc = fixture()
    inst = doc['instances'][0]
    doc['animation']['tracks'] = [{'instanceId': inst['id'], 'keys': [
        {'time': 0, 'position': [-2, 0, 0], 'rotation': [0, 0, 0]},
        {'time': 1, 'position': [2, 0, 0], 'rotation': [0, 90, 0]}]}]
    path = tmp_path / 'animation.gif'
    report = render_gif(doc, path, width=320, height=240, duration=1, fps=10, motion='animation', loop=False)
    with Image.open(path) as gif:
        assert 'loop' not in gif.info
        first = np.array(gif.convert('RGB'))
        gif.seek(gif.n_frames-1)
        assert np.count_nonzero(first != np.array(gif.convert('RGB'))) > 100
    assert report['animation_sampled']
    with pytest.raises(ValueError, match='range'):
        render_gif(doc, path, motion='animation', start=120, duration=1)
    with pytest.raises(ValueError, match='32 million'):
        render_gif(doc, path, width=1024, height=1024, duration=4)
    doc['animation']['tracks'][0]['instanceId'] = 'missing'
    with pytest.raises(ValueError, match='target'):
        render_gif(doc, path, motion='animation', duration=1)
