"""Contract and native pixel tests for the optional renderer."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from native_render import build_scene, render_scene


def fixture() -> dict[str, Any]:
    """Load the existing portable equipment fixture, without synthesizing meshes."""
    return json.loads((Path(__file__).parent / "fixtures/open-equipment.oi.json").read_text())


def test_mesh_transform_visibility_and_color() -> None:
    """Preserve normalized vertices and Three.js XYZ degree transforms."""
    doc = fixture()
    first = doc['instances'][0]
    first.update(position=[2, 3, 4], rotation=[90, 0, 0], visible=True)
    for other in doc['instances'][1:]:
        other['visible'] = False
    scene = build_scene(doc, base_layout=True)
    groups = [obj for obj in scene.children if obj.name == first['id']]
    assert len(groups) == 1
    group = groups[0]
    np.testing.assert_allclose(group.local.matrix @ [0, 1, 0, 1], [2, 3, 5, 1], atol=1e-6)
    asset = next(a for a in doc['bundledAssets'] if a['id'] == first['assetId'])
    np.testing.assert_allclose(group.children[0].geometry.positions.data,
                               np.array(asset['parts'][0]['vertices']).reshape(-1, 3))
    np.testing.assert_allclose(group.children[0].material.color.to_physical()[:3],
                               asset['parts'][0].get('color', [.7, .8, .75]), atol=1e-5)
    assert not any(obj.name == i['id'] for i in doc['instances'][1:] for obj in scene.children)


def test_missing_geometry_and_revision_rejected() -> None:
    """Missing/replaced asset bundles must never become plausible placeholders."""
    doc = fixture()
    doc['bundledAssets'] = []
    with pytest.raises(ValueError, match='Missing exact geometry'):
        build_scene(doc, base_layout=True)
    doc = fixture()
    doc['bundledAssets'][0]['source']['digest'] = 'wrong-revision'
    with pytest.raises(ValueError, match='Source revision mismatch'):
        build_scene(doc, base_layout=True)


def test_animation_requires_explicit_base_layout() -> None:
    """Do not silently present a base layout as an evaluated animation frame."""
    doc = fixture()
    doc['animation']['tracks'] = [{'instanceId': doc['instances'][0]['id']}]
    with pytest.raises(ValueError, match='Animation is not supported'):
        build_scene(doc)
    build_scene(doc, base_layout=True)


def test_invalid_indices_rejected() -> None:
    """Invalid topology fails before GPU resource creation."""
    doc = fixture()
    doc['bundledAssets'][0]['parts'][0]['indices'][0] = -1
    with pytest.raises(ValueError, match='Invalid triangle indices'):
        build_scene(doc, base_layout=True)


def test_native_pixels_respond_to_geometry() -> None:
    """Exercise actual native rendering and detect blank or ignored-geometry output."""
    doc = fixture()
    image = render_scene(doc, width=320, height=240, base_layout=True)
    assert image.shape == (240, 320, 4)
    assert image.dtype == np.uint8
    assert np.unique(image[:, :, :3].reshape(-1, 3), axis=0).shape[0] > 30
    hidden = copy.deepcopy(doc)
    for instance in hidden['instances']:
        instance['visible'] = False
    other = render_scene(hidden, width=320, height=240, base_layout=True)
    assert np.count_nonzero(np.any(image != other, axis=2)) > 100


def test_empty_room_render() -> None:
    """Render an empty 10 by 10 room envelope using declared dimensions."""
    doc = {'format': 'astra.scene', 'version': 1, 'units': 'm', 'upAxis': 'Y',
           'room': [10, 10, 3], 'instances': [], 'assets': [],
           'animation': {'duration': 3, 'loop': True, 'tracks': []}}
    image = render_scene(doc, width=320, height=240)
    assert image.shape == (240, 320, 4)
    doc['room'][0] = -10
    with pytest.raises(ValueError, match='Room dimensions'):
        build_scene(doc)
