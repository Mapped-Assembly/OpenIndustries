"""Derive three supported, manually staged joint fixtures from the pinned #73 coupon."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np
from scipy.spatial.transform import Rotation

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services/embodied'))
from oi_embodied.cabinet import digest
from oi_embodied.model import RobotModel


def build() -> dict[str, dict[str, Any]]:
    """Keep the arm base fixed; vary the joint's reachable target, never route coordinates."""
    original = json.loads((ROOT/'benchmarks/cabinet/joint.json').read_text())
    model = RobotModel(ROOT/'benchmarks/embodied')
    fixtures = {}
    for label, point in [('a',[.30,0,.18]), ('b',[.32,0,.20]), ('c',[.34,0,.22])]:
        fixture = deepcopy(original)
        fixture['id'] = f'cabinet-fastening-{label}-v1'
        fixture['name'] = f'Supported joint {label.upper()} / simulated SO-101 spindle'
        fixture['parent_fixture_sha256'] = digest(original)
        offset = np.array(point)-np.array(original['connections'][0]['features'][0]['position_m'])
        for pose in fixture['target_assembly'].values():
            pose['position_m'] = (np.array(pose['position_m'])+offset).tolist()
        fixture['connections'][0]['features'][0]['position_m'] = point
        fixture['connections'][0]['state'] = 'unconnected'
        fixture['limits'] = {'payload_kg':.15,'tool_mass_kg':.035,'wrist_moment_Nm':.15,'grip_force_N':8.}
        fixture['tools']['gripper']['mounted'] = False
        fixture['tools']['screwdriver'] = {
            'mounted':True, 'adapter':'sim-spindle-at-so101-tcp-v1',
            'mount_frame':'pinned_tcp', 'tip_matrix':np.eye(4).tolist(),
            'axis_local':[0,0,1], 'body_length_m':.09,
            'spindle_actuator':'screwdriver_spindle', 'mass_kg':.035,
            'center_of_mass_local_m':[0,0,-.045], 'mass_source':'declared simulation parameter',
            'physical_adapter':None, 'physical_calibration':None,
        }
        # Deliberately shared initial arm pose: all three tasks must resolve new targets.
        # Pin the authored initial configuration; do not rerun numerical IK while
        # generating fixtures (optimizer rounding may vary across platforms).
        start = [0.000009859905, -1.134549589017, 0.726049491599,
                 0.408509338592, -0.001551591544, 0.0]
        fixture['initial_q_rad'] = start
        for obj in fixture['objects']:
            if obj['kind']=='panel':
                obj.update(deepcopy(fixture['target_assembly'][obj['id']]))
                obj['support_id'] = 'holding_fixture'
                obj['mass_kg'] = .025
                obj['center_of_mass_m'] = [0,0,0]
                obj['manufacturing'].update({'material':'PLA (simulation assumption)', 'shell_thickness_m':.0012,
                    'infill_fraction':.2, 'print_profile':'declared coupon, not fabrication validated',
                    'mass_kg':.025, 'center_of_mass_m':[0,0,0], 'mass_source':'declared simulation parameter'})
            elif obj['id']=='screw_1':
                obj['position_m'] = (np.array(point)-[.01,0,0]).tolist()
                obj['orientation_xyzw'] = Rotation.from_euler('y',np.pi/2).as_quat().tolist()
                obj['fastener'].update({'head_type':'modeled Phillips', 'pitch_m':.0005})
            elif obj['id']=='holding_fixture':
                height = point[2]-.003
                obj['position_m'] = [point[0]+.046,0,height/2]
                obj['size_m'] = [.08,.08,height]
                obj['geometry']['size_m'] = obj['size_m']
                obj['geometry_sha256'] = digest(obj['geometry'])
                obj['clamped_component_ids'] = ['base_panel','upright_panel']
                obj['clamps_engaged'] = True
                obj['support_model'] = 'ideal rigid corner clamps; strength not physically validated'
                obj['load_capacity_kg'] = .2
            elif obj['id']=='screwdriver':
                pose = model.tool_matrix(start)
                obj['position_m'] = np.round(pose[:3,3]-.045*pose[:3,2],12).tolist()
                obj['orientation_xyzw'] = np.round(Rotation.from_matrix(pose[:3,:3]).as_quat(),12).tolist()
                obj['attached_to'] = 'pinned_tcp'
        fixture['fastening'] = {
            'capability':'supported-joint-v1', 'controller_id':'so101-kinematic-v1',
            'joint_id':'corner','screw_id':'screw_1','hole_id':'corner_hole',
            'panel_ids':['base_panel','upright_panel'],'support_id':'holding_fixture','tool_id':'screwdriver',
            'frame':'base_link','length_unit':'m','angle_unit':'rad',
            'required_depth_m':.006,'pitch_m':.0005,'insertion_rate_m_s':.0015,
            'position_tolerance_m':.00075,'angle_tolerance_rad':.015,'depth_tolerance_m':.00005,
            'active_deadline_s':45., 'recovery_attempts':0,
            'provenance':'declared simplified simulation; no thread contact, torque or physical evidence',
            'manual_setup':['Raise and clamp both panels in the ideal corner fixture at target poses.',
                            'Preposition screw_1 in corner_hole at zero insertion.',
                            'Replace jaws with the simulated TCP spindle adapter; initialize the declared arm pose.'],
            'cancellation':'Stop controller immediately; preserve depth, spindle and poses; re-observe before resume.',
        }
        fixture['approach_targets'] = []
        fixture['limitations'] = ['Ideal rigid clamps and declared simulation loads, not measured hardware ratings.',
            'Panels are manually staged; no grasp, pick/place, feeding or automatic tool change.',
            'Tool-envelope and TCP path checks only; full-link collision and contact physics unvalidated.',
            'Simplified pitch/depth model; torque and thread-contact telemetry are unavailable.']
        fixture['adaptation'] = 'Derived #73 coupon raised into a declared clamped pedestal, with explicit simulated spindle adapter. Arm base unchanged.'
        fixtures[f'fastening-{label}'] = fixture
    return fixtures


def main() -> None:
    """Write deterministic versioned fixture inputs beside their parent coupon."""
    for name, fixture in build().items():
        (ROOT/'benchmarks/cabinet'/f'{name}.json').write_text(json.dumps(fixture,indent=2)+'\n')


if __name__ == '__main__':
    main()
