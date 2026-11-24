"""Physics must be solved by MuJoCo, with tested coordinate and contact semantics."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from native_physics import PhysicsReplay
from native_render import build_scene, render_gif

FIXTURE = Path(__file__).resolve().parents[2] / 'benchmarks/native-render/physics'


def replay() -> PhysicsReplay:
    """Create a fresh deterministic MJCF simulation and its OI visuals."""
    scene = build_scene(json.loads((FIXTURE / 'scene.oi.json').read_text()), include_hidden=True)
    return PhysicsReplay(FIXTURE / 'model.xml', FIXTURE / 'bindings.json', scene)


def test_gravity_contact_and_joint() -> None:
    """Verify free fall, floor support and an actual articulated pendulum state."""
    run = replay()
    frames = run.sample([0, .2, 1, 2])
    # Visual origin is the bottom of the block (center minus 0.4 m).
    assert frames[0][0][1, 3] == pytest.approx(1.6)
    assert frames[1][0][1, 3] == pytest.approx(1.6 - .5*9.81*.2**2, abs=.003)
    assert abs(frames[-1][0][1, 3]) < .005
    assert run.report['contact_counts'][-1] > 0
    assert abs(run.data.qpos[-1] - .65) > .1
    # MuJoCo's vertical axis becomes OI Y, with a right-handed rotation.
    assert frames[0][0][0, 3] == pytest.approx(-1)
    np.testing.assert_allclose(frames[0][0][:3, :3], np.eye(3), atol=1e-8)
    run.apply(frames[-1])
    np.testing.assert_allclose(run.bindings[0][0].world.matrix, frames[-1][0], atol=1e-8)


def test_physics_independent_of_output_sampling() -> None:
    """Adding render samples must not change the same final fixed-step state."""
    a, b = replay(), replay()
    a.sample([0, 1])
    b.sample([i/20 for i in range(21)])
    np.testing.assert_allclose(a.data.qpos, b.data.qpos, atol=1e-10)
    np.testing.assert_allclose(a.data.qvel, b.data.qvel, atol=1e-10)


def test_no_overlapping_presentation_floor() -> None:
    """A populated scene must not receive a coplanar synthetic floor."""
    doc = json.loads((FIXTURE / 'scene.oi.json').read_text())
    scene = build_scene(doc)
    assert not any(obj.name == 'presentation-floor' for obj in scene.children)
    doc['instances'] = []
    scene = build_scene(doc)
    assert any(obj.name == 'presentation-floor' for obj in scene.children)


def test_unknown_body_rejected(tmp_path: Path) -> None:
    """Never silently leave a requested simulated visual unbound."""
    config = json.loads((FIXTURE / 'bindings.json').read_text())
    config['bindings'][0]['body'] = 'missing'
    path = tmp_path / 'bindings.json'
    path.write_text(json.dumps(config))
    scene = build_scene(json.loads((FIXTURE / 'scene.oi.json').read_text()))
    with pytest.raises(ValueError, match='Unknown MuJoCo body'):
        PhysicsReplay(FIXTURE / 'model.xml', path, scene)


def test_physics_gif_records_simulation(tmp_path: Path) -> None:
    """Exercise end-to-end MuJoCo poses, native frames and GIF provenance."""
    from PIL import Image
    doc = json.loads((FIXTURE / 'scene.oi.json').read_text())
    report = render_gif(doc, tmp_path / 'physics.gif', width=320, height=240, duration=1,
                        fps=10, motion='physics', physics_model=FIXTURE / 'model.xml',
                        physics_bindings=FIXTURE / 'bindings.json')
    assert report['physics']['engine'] == 'mujoco'
    assert not report['animation_sampled']
    assert report['palette'] == 'shared-256-color'
    assert max(report['physics']['contact_counts']) > 0
    with Image.open(tmp_path / 'physics.gif') as gif:
        first = np.array(gif.convert('RGB'))
        gif.seek(gif.n_frames-1)
        assert np.count_nonzero(first != np.array(gif.convert('RGB'))) > 100
