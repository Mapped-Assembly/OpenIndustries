"""Reproduce versioned OI cabinet envelopes from the pinned synthetic design."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
from typing import Any
from scipy.spatial.transform import Rotation

ROOT = Path(__file__).resolve().parent
Json = dict[str, Any]


def digest(value: Any) -> str:
    """Hash canonical JSON independently of file whitespace."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def component(identifier: str, kind: str, size: list[float], position: list[float], color: list[float]) -> Json:
    """Describe a centre-origin box envelope, not manufactured CAD or contact geometry."""
    geometry = {'primitive': 'box', 'size_m': size}
    return {'id': identifier, 'name': identifier.replace('_', ' '), 'kind': kind,
            'geometry': geometry, 'geometry_sha256': digest(geometry), 'size_m': size,
            'position_m': position, 'orientation_xyzw': [0, 0, 0, 1], 'color': color,
            'present': True, 'attached_to': None, 'supported': True,
            'accessible': True, 'collision_geometry': 'oriented_box_envelope',
            'material_class': 'unspecified', 'mass_kg': None, 'center_of_mass_m': None}


def build() -> dict[str, Json]:
    """Generate the preserved packaged fixture and an explicitly resized joint coupon."""
    source = ROOT / 'source'
    lock = json.loads((source / 'source-lock.json').read_text())
    for name, expected in lock['files'].items():
        if hashlib.sha256((source / name).read_bytes()).hexdigest() != expected:
            raise ValueError('SOURCE_PIN_MISMATCH')
    geometry = json.loads((source / 'geometry.json').read_text())
    initial = json.loads((source / 'initial-state.json').read_text())
    objects = []
    for name, spec in geometry['objects'].items():
        pose = initial['objects'][name]
        color = [int(spec['color'][i:i + 2], 16) / 255 for i in (1, 3, 5)]
        obj = component(name, spec['kind'], spec['size_m'], [pose['position_m'][0], pose['position_m'][1] - .27, pose['position_m'][2]], color)
        obj.update({'orientation_xyzw': pose['orientation_xyzw'], 'container_id': 'box',
                    'accessible': name == 'paper_seal', 'manufacturing': spec.get('manufacturing'),
                    'material_class': '3d_printed_polymer_unspecified' if spec['kind'] == 'panel' else 'paperboard',
                    'grasp_feature': {'offset_m': spec.get('grasp_offset_m'), 'boss_size_m': spec.get('grasp_boss_size_m'), 'strength_validated': False}})
        objects.append(obj)
    for name, spec in geometry['screws'].items():
        pose = initial['screws'][name]
        offset = Rotation.from_quat(pose['orientation_xyzw']).apply([0,0,-.01])
        centre = [pose['position_m'][i] + float(offset[i]) - (.27 if i == 1 else 0) for i in range(3)]
        obj = component(name, 'screw', [.006, .006, .02], centre, [.65, .68, .72])
        obj.update({'orientation_xyzw': pose['orientation_xyzw'], 'container_id': 'screw_carrier', 'accessible': False,
                    'material_class': 'metal', 'fastener': {'nominal': 'M3', 'length_m': .02, 'joint_id': spec['joint'],
                    'hole_id': name + '_hole', 'installed': False, 'insertion_m': 0., 'head_type': None}})
        objects.append(obj)
    w, d, h = geometry['box']['inner_dimensions_m']; wall = geometry['box']['wall_m']; z = .01
    for name, size, pos in [
        ('box_bottom', [w + 2*wall, d + 2*wall, wall], [.24, 0, z-wall/2]),
        ('box_left', [wall, d + 2*wall, h], [.24-w/2-wall/2, 0, z+h/2]),
        ('box_right', [wall, d + 2*wall, h], [.24+w/2+wall/2, 0, z+h/2]),
        ('box_front', [w, wall, h], [.24, -d/2-wall/2, z+h/2]),
        ('box_back', [w, wall, h], [.24, d/2+wall/2, z+h/2]),
        ('box_lid', [w + 2*wall, d + 2*wall, wall], [.24, 0, z+h+wall/2])]:
        obj = component(name, 'packaging', size, pos, [.63, .43, .25])
        obj['material_class'] = 'corrugated_cardboard'; objects.append(obj)
    # Tools/supports are visible planned equipment, not registered actuated mechanisms.
    objects.append(component('holding_fixture', 'fixture', [.12, .08, .012], [-.19, -.15, .006], [.3, .4, .45]))
    objects.append(component('screwdriver', 'tool', [.025, .025, .09], [-.19, .12, .045], [.3, .3, .35]))
    target = {name: {'position_m': [spec['target_position_m'][0]-.76, spec['target_position_m'][1]-.57, spec['target_position_m'][2]],
                     'orientation_xyzw': spec['target_orientation_xyzw']}
              for name, spec in geometry['objects'].items() if spec['kind'] == 'panel'}
    joints = []
    pairs = {'left_bottom': ['left_panel', 'bottom_panel'], 'right_bottom': ['right_panel', 'bottom_panel'],
             'top_left': ['top_panel', 'left_panel'], 'top_right': ['top_panel', 'right_panel'],
             'back_bottom': ['back_panel', 'bottom_panel'], 'back_left': ['back_panel', 'left_panel'],
             'back_right': ['back_panel', 'right_panel'], 'back_top': ['back_panel', 'top_panel']}
    for name, panels in pairs.items():
        screws = [key for key, item in geometry['screws'].items() if item['joint'] == name]
        features = [{'hole_id': key+'_hole', 'screw_id': key,
                     'position_m': [geometry['screws'][key]['target_head_m'][0]-.76, geometry['screws'][key]['target_head_m'][1]-.57, geometry['screws'][key]['target_head_m'][2]],
                     'outward_axis': geometry['screws'][key]['outward_axis']} for key in screws]
        joints.append({'id': name, 'component_ids': panels, 'screw_ids': screws, 'features': features, 'verified': False})
    common: Json = {'schema_version': 1, 'frame': 'base_link', 'units': {'length': 'm', 'angle': 'rad', 'mass': 'kg'},
                    'quaternion_order': 'xyzw', 'handedness': 'right', 'up_axis': 'Z',
                    'source_sha256': digest(lock), 'model_sha256': hashlib.sha256((ROOT.parent/'embodied/robot-contract.json').read_bytes()).hexdigest(),
                    'machine_id': 'so101-follower-new-calibration', 'agent_id': 'cabinet-agent',
                    'controller_id': 'so101-kinematic-v1', 'room_m': [1.2, 1.2, 1.0],
                    'limits': {'payload_kg': None, 'tool_mass_kg': None, 'wrist_moment_Nm': None, 'grip_force_N': None},
                    'tools': {'gripper': {'mounted': True, 'interface': 'pinned SO-101 jaws; gripper coordinate is radians, not aperture', 'calibration': None},
                              'screwdriver': {'mounted': False, 'adapter': None, 'spindle_actuator': None, 'mass_kg': None}},
                    'tolerances': {'position_m': .003, 'angle_rad': .035},
                    'limitations': ['Authored box envelopes; no printable mating holes or resolved thread geometry.',
                                    'Only inspect/approach/home are executable. No contact, unpacking or fastening.',
                                    'TCP envelope checks are not full robot collision checking.',
                                    'Unknown print/load/tool ratings block manipulation. Full-kit assembly reach is unverified.']}
    packaged = {**deepcopy(common), 'id': 'cabinet-packaged-v1', 'name': 'Packaged cabinet / source dimensions',
                'objects': objects, 'target_assembly': target, 'connections': joints,
                'package': {'id': 'box', 'closure': 'sealed', 'inner_dimensions_m': [w,d,h], 'wall_m': wall,
                            'access_order': ['paper_seal', 'box_lid', 'screw_carrier', 'bottom_panel', 'separator_1', 'left_panel',
                                             'separator_2', 'right_panel', 'separator_3', 'top_panel', 'separator_4', 'back_panel']},
                'adaptation': 'Preserved source dimensions. Package translated Y by -0.27 m; target assembly translated (-0.76,-0.57,0) m. Gantry replaced by existing SO-101 binding; assembly feasibility unknown.',
                'approach_targets': ['box_lid']}
    base = component('base_panel', 'panel', [.08,.05,.006], [.17,-.06,.009], [.27,.73,.75])
    upright = component('upright_panel', 'panel', [.06,.05,.006], [.18,.065,.009], [.9,.7,.36])
    for obj in (base, upright):
        obj['material_class'] = '3d_printed_polymer_unspecified'
        obj['manufacturing'] = deepcopy(geometry['objects']['bottom_panel']['manufacturing'])
        obj['grasp_feature'] = {'offset_m': [0,0,.005], 'boss_size_m': [.018,.012,.004], 'strength_validated': False}
    screw = component('screw_1', 'screw', [.006,.006,.02], [.26,.06,.01], [.65,.68,.72])
    screw['material_class'] = 'metal'
    screw['fastener'] = {'nominal':'M3','length_m':.02,'joint_id':'corner','hole_id':'corner_hole','installed':False,'insertion_m':0.,'head_type':None}
    joint = {**deepcopy(common), 'id':'cabinet-joint-v1', 'name':'Two-panel joint / SO-101 coupon',
             'objects':[base,upright,screw,component('holding_fixture','fixture',[.11,.08,.006],[.17,-.06,.003],[.3,.4,.45]),
                        component('screwdriver','tool',[.025,.025,.09],[-.15,-.15,.045],[.3,.3,.35])],
             'target_assembly':{'base_panel':{'position_m':[.17,-.06,.009],'orientation_xyzw':[0,0,0,1]},
                                'upright_panel':{'position_m':[.127,-.06,.042],'orientation_xyzw':[0,.7071067811865475,0,.7071067811865476]}},
             'connections':[{'id':'corner','component_ids':['base_panel','upright_panel'],'screw_ids':['screw_1'],
                             'features':[{'hole_id':'corner_hole','screw_id':'screw_1','position_m':[.124,-.06,.009],'outward_axis':[-1,0,0]}], 'verified':False}],
             'package':None, 'approach_targets':['base_panel','upright_panel','screw_1'],
             'adaptation':'Separate 80x50x6 mm base and 60x50x6 mm upright coupon. Not a resized full cabinet or a completed joint; screw/tool manually staged, support unvalidated.'}
    for fixture in (joint, packaged):
        fixture['inventory'] = [obj['id'] for obj in fixture['objects'] if obj['kind'] in ('panel','screw')]
    return {'joint':joint,'packaged':packaged}


if __name__ == '__main__':
    for name, fixture in build().items():
        (ROOT/(name+'.json')).write_text(json.dumps(fixture, indent=2, allow_nan=False)+'\n')
