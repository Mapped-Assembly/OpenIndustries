"""Build explicit visual boxes matching the separately authored MJCF test model."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path


def main() -> None:
    """Write portable OI geometry and body bindings for a drop/pendulum example."""
    root = Path(__file__).resolve().parents[3]
    template = json.loads((root / 'tools/geospatial/fixtures/open-equipment.oi.json').read_text())['bundledAssets'][0]
    assets = []
    for name, dims, color in [('ground', [8, .1, 6], [.25, .3, .35]),
                              ('block', [1, .8, .6], [.8, .3, .08]),
                              ('pendulum', [.2, 1.6, .2], [.1, .5, .8])]:
        asset = copy.deepcopy(template)
        part = asset['parts'][0]
        vertices = part['vertices']
        part['vertices'] = [v * (dims[0]/2 if i % 3 == 0 else dims[1] if i % 3 == 1 else dims[2]) for i, v in enumerate(vertices)]
        part.update(id=name, name=name, color=color)
        asset.update(id=name, name=name, dimensions=dims,
                     hierarchy={'id': name, 'name': name, 'partIds': [name], 'children': []})
        asset['source'] = {'kind': 'generated', 'generator': 'oi-fixture', 'filename': 'physics/build_fixture.py',
                           'digest': hashlib.sha256(json.dumps(part).encode()).hexdigest()}
        assets.append(asset)
    doc = {'format': 'astra.scene', 'version': 1, 'units': 'm', 'upAxis': 'Y', 'room': [8, 6, 4],
           'assets': [{k: a[k] for k in ['id', 'name', 'source', 'dimensions']} for a in assets],
           'bundledAssets': assets, 'instances': [
               {'id': a['id'], 'name': a['name'], 'assetId': a['id'], 'visible': True,
                'position': pos, 'rotation': [0, 0, 0]} for a, pos in zip(assets, [[0, -.1, 0], [-1, 1.6, 0], [1.5, .9, 0]])],
           'animation': {'duration': 4, 'loop': False, 'tracks': []}}
    bindings = {'version': 1, 'modelUpAxis': 'Z', 'keyframe': 'release', 'bindings': [
        {'instanceId': 'block', 'body': 'falling-block',
         'bodyFromVisual': [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, -.4], [0, 0, 0, 1]]},
        {'instanceId': 'pendulum', 'body': 'pendulum',
         'bodyFromVisual': [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, -1.6], [0, 0, 0, 1]]}]}
    for filename, value in [('scene.oi.json', doc), ('bindings.json', bindings)]:
        Path(__file__).with_name(filename).write_text(json.dumps(value, indent=2) + '\n')


if __name__ == '__main__':
    main()
