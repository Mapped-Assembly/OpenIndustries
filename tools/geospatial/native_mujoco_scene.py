"""Project compiled MuJoCo visual geometry into portable OI mesh assets."""
from __future__ import annotations

import hashlib
from typing import Any

import mujoco
import numpy as np
import pygfx as gfx

from native_physics import Y_FROM_Z


def geometry(model: mujoco.MjModel, index: int) -> tuple[np.ndarray, np.ndarray]:
    """Return a geom's compiled local vertices and triangle indices in Z-up axes."""
    kind, size = int(model.geom_type[index]), model.geom_size[index]
    if kind == mujoco.mjtGeom.mjGEOM_MESH:
        mesh = model.geom_dataid[index]
        va, fa = model.mesh_vertadr[mesh], model.mesh_faceadr[mesh]
        return model.mesh_vert[va:va+model.mesh_vertnum[mesh]].copy(), model.mesh_face[fa:fa+model.mesh_facenum[mesh]].copy()
    if kind in (mujoco.mjtGeom.mjGEOM_BOX, mujoco.mjtGeom.mjGEOM_PLANE):
        shape = gfx.box_geometry(*(2 * np.maximum(size, .001)))
    elif kind == mujoco.mjtGeom.mjGEOM_SPHERE:
        shape = gfx.sphere_geometry(radius=float(size[0]), width_segments=24, height_segments=12)
    elif kind in (mujoco.mjtGeom.mjGEOM_CYLINDER, mujoco.mjtGeom.mjGEOM_CAPSULE):
        shape = gfx.cylinder_geometry(radius_bottom=float(size[0]), radius_top=float(size[0]), height=float(2*size[1]), radial_segments=24)
        vertices = shape.positions.data.copy()
        indices = shape.indices.data.copy().reshape(-1, 3)
        if kind == mujoco.mjtGeom.mjGEOM_CAPSULE:
            for z in (-size[1], size[1]):
                sphere = gfx.sphere_geometry(radius=float(size[0]), width_segments=24, height_segments=12)
                faces = sphere.indices.data.reshape(-1, 3) + len(vertices)
                vertices = np.vstack([vertices, sphere.positions.data + [0, 0, z]])
                indices = np.vstack([indices, faces])
        return vertices, indices
    else:
        raise ValueError(f'Unsupported MuJoCo visual geom type: {kind}')
    return shape.positions.data.copy(), shape.indices.data.copy().reshape(-1, 3)


def project_model(model: mujoco.MjModel, excluded: set[str], room: list[float]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Preserve compiled mesh transforms; exclude collision-only group 3 geometry."""
    assets, instances, bindings = [], [], []
    for index in range(model.ngeom):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, index) or f'geom-{index}'
        if model.geom_group[index] == 3 or name in excluded:
            continue
        vertices, indices = geometry(model, index)
        vertices = vertices @ Y_FROM_Z[:3, :3].T
        rotation = np.empty(9)
        mujoco.mju_quat2Mat(rotation, model.geom_quat[index])
        local = np.eye(4)
        local[:3, :3] = rotation.reshape(3, 3)
        local[:3, 3] = model.geom_pos[index]
        offset = local @ Y_FROM_Z.T
        material = model.geom_matid[index]
        rgb = (model.mat_rgba[material] if material >= 0 else model.geom_rgba[index])[:3]
        # MuJoCo display colors are sRGB; OI portable part colors are linear.
        color = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
        part = {'id': name, 'name': name, 'vertices': vertices.reshape(-1).tolist(),
                'indices': indices.reshape(-1).tolist(), 'color': color.tolist(),
                'metadata': {'source': 'compiled MuJoCo visual geom'}}
        source = {'kind': 'generated', 'generator': 'oi-fixture', 'filename': name,
                  'digest': hashlib.sha256(vertices.tobytes() + indices.tobytes()).hexdigest()}
        asset = {'id': name, 'name': name, 'schemaVersion': 1, 'units': 'm', 'upAxis': 'Y',
                 'originOffset': [0, 0, 0], 'dimensions': np.ptp(vertices, axis=0).tolist(),
                 'parts': [part], 'source': source, 'warnings': [],
                 'hierarchy': {'id': name, 'name': name, 'partIds': [name], 'children': []}}
        assets.append(asset)
        instances.append({'id': name, 'assetId': name, 'name': name, 'visible': True,
                          'position': [0, 0, 0], 'rotation': [0, 0, 0]})
        body = int(model.geom_bodyid[index])
        bindings.append({'instanceId': name, 'body': body, 'bodyFromVisual': offset})
    doc = {'format': 'astra.scene', 'version': 1, 'units': 'm', 'upAxis': 'Y', 'room': room,
           'assets': [{k: a[k] for k in ('id', 'name', 'source', 'dimensions')} for a in assets],
           'bundledAssets': assets, 'instances': instances,
           'animation': {'duration': 12, 'loop': False, 'tracks': []}}
    return doc, bindings
