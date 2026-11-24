"""Verify geometry projection against MuJoCo's authoritative world transforms."""
from __future__ import annotations

import mujoco
import numpy as np

from native_mujoco_scene import geometry, project_model
from native_physics import Y_FROM_Z


def test_compiled_geom_transforms_and_filters() -> None:
    """Box, curved primitives and recentered meshes retain compiled world coordinates."""
    model = mujoco.MjModel.from_xml_string('''<mujoco>
      <asset><mesh name="tetra" vertex="0 0 0 1 0 0 0 1 0 0 0 1" face="0 2 1 0 1 3 0 3 2 1 2 3"/></asset>
      <worldbody><body name="body" pos="1 2 3" euler="10 20 30">
        <geom name="box" type="box" size=".1 .2 .3" pos=".2 0 .1" euler="30 15 20"/>
        <geom name="sphere" type="sphere" size=".1"/>
        <geom name="cylinder" type="cylinder" size=".1 .2"/>
        <geom name="capsule" type="capsule" size=".1 .2"/>
        <geom name="mesh" type="mesh" mesh="tetra" pos=".1 .3 .2"/>
        <geom name="collision" type="box" size=".1 .1 .1" group="3"/>
        <geom name="exclude" type="box" size=".1 .1 .1"/>
      </body></worldbody></mujoco>''')
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    doc, bindings = project_model(model, {'exclude'}, [1, 1, 1])
    assert len(bindings) == 5
    assert {a['id'] for a in doc['bundledAssets']} == {'box', 'sphere', 'cylinder', 'capsule', 'mesh'}
    for asset, binding in zip(doc['bundledAssets'], bindings, strict=True):
        index = model.geom(asset['id']).id
        original, indices = geometry(model, index)
        if asset['id'] == 'cylinder':
            np.testing.assert_allclose(np.ptp(original, axis=0), [.2, .2, .4], atol=1e-6)
        if asset['id'] == 'capsule':
            np.testing.assert_allclose(np.ptp(original, axis=0), [.2, .2, .6], atol=1e-6)
        visual = np.array(asset['parts'][0]['vertices']).reshape(-1, 3)
        body = binding['body']
        world = np.eye(4)
        world[:3, :3] = data.xmat[body].reshape(3, 3)
        world[:3, 3] = data.xpos[body]
        projected = Y_FROM_Z @ world @ binding['bodyFromVisual']
        output = visual @ projected[:3, :3].T + projected[:3, 3]
        expected = (original @ data.geom_xmat[index].reshape(3, 3).T + data.geom_xpos[index]) @ Y_FROM_Z[:3, :3].T
        np.testing.assert_allclose(output, expected, atol=1e-6)
        assert indices.min() >= 0 and indices.max() < len(original)
