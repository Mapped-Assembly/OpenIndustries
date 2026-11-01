"""Cabinet fixture validation, fail-closed preflight and complete state projections."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from scipy.spatial.transform import Rotation

from .model import RobotModel

Json = dict[str, Any]
SUPPORTED = ('inspect', 'approach', 'home')
MANIPULATION = ('grasp', 'lift', 'pick', 'place', 'open', 'remove', 'align', 'fasten')


def digest(value: Any) -> str:
    """Hash canonical finite JSON for immutable fixture and geometry identities."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def vector(value: Any, length: int) -> bool:
    """Reject boolean, nonfinite and dimensionally invalid numeric vectors."""
    return isinstance(value, list) and len(value) == length and all(type(v) in (int, float) and np.isfinite(v) for v in value)


def nonnegative(value: Any) -> bool:
    """Accept finite nonnegative numerical model parameters, excluding booleans."""
    return type(value) in (int, float) and bool(np.isfinite(value)) and value >= 0


def load_fixture(path: Path, model: RobotModel) -> Json:
    """Validate the versioned fixture before a station or command is created."""
    fixture: Json = json.loads(path.read_text())
    if fixture.get('schema_version') != 1 or fixture.get('frame') != 'base_link' or fixture.get('units') != {'length':'m','angle':'rad','mass':'kg'} or fixture.get('up_axis') != 'Z' or fixture.get('quaternion_order') != 'xyzw' or fixture.get('handedness') != 'right':
        raise ValueError('INCOMPATIBLE_FRAME_OR_UNITS')
    if fixture.get('model_sha256') != model.sha or fixture.get('machine_id') != model.contract['robot_id'] or fixture.get('controller_id') != 'so101-kinematic-v1':
        raise ValueError('CABINET_MACHINE_PIN_MISMATCH')
    objects = fixture['objects']
    ids = [obj['id'] for obj in objects]
    if not objects or len(ids) != len(set(ids)):
        raise ValueError('INVALID_COMPONENT_IDS')
    for obj in objects:
        if not vector(obj['size_m'], 3) or min(obj['size_m']) <= 0 or not vector(obj['position_m'], 3) or not vector(obj['orientation_xyzw'], 4) or abs(np.linalg.norm(obj['orientation_xyzw'])-1) > 1e-6:
            raise ValueError('INVALID_COMPONENT_GEOMETRY')
        if obj['geometry'] != {'primitive':'box','size_m':obj['size_m']} or digest(obj['geometry']) != obj['geometry_sha256']:
            raise ValueError('GEOMETRY_PIN_MISMATCH')
    if set(fixture['inventory']) != {obj['id'] for obj in objects if obj['kind'] in ('panel','screw')}:
        raise ValueError('INVALID_INVENTORY')
    if not set(fixture['approach_targets']).issubset(ids):
        raise ValueError('INVALID_TARGET_REFERENCE')
    screws = {obj['id']:obj for obj in objects if obj['kind']=='screw'}
    seen: set[str] = set()
    for joint in fixture['connections']:
        if not set(joint['component_ids']).issubset(ids) or not set(joint['screw_ids']).issubset(screws):
            raise ValueError('INVALID_CONNECTION_REFERENCE')
        for feature in joint['features']:
            screw = screws[feature['screw_id']]['fastener']
            if feature['screw_id'] in seen or screw['joint_id'] != joint['id'] or screw['hole_id'] != feature['hole_id']:
                raise ValueError('INVALID_FASTENER_MAPPING')
            seen.add(feature['screw_id'])
    if seen != set(screws):
        raise ValueError('UNMAPPED_FASTENER')
    fixture['sha256'] = digest(fixture)
    return fixture


def preflight(fixture: Json, objects: list[Json], operation: Json, model: RobotModel, q: list[float]) -> Json:
    """Report all known blockers without executing, inferring mass or changing poses."""
    if not isinstance(operation, dict) or set(operation) != {'verb','component_ids','frame','units'} or not isinstance(operation['verb'],str) or not isinstance(operation['component_ids'], list) or not all(isinstance(i,str) for i in operation['component_ids']):
        raise ValueError('INVALID_PREFLIGHT')
    reasons: list[str] = []
    verb = operation['verb']
    if verb not in SUPPORTED:
        reasons.append('UNSUPPORTED_CAPABILITY')
    if operation['frame'] != fixture['frame'] or operation['units'] != fixture['units']:
        reasons.append('INCOMPATIBLE_FRAME_OR_UNITS')
    catalog = {obj['id']:obj for obj in objects}
    selected = [catalog[i] for i in operation['component_ids'] if i in catalog]
    if (verb != 'home' and not selected) or any(i not in catalog or not catalog[i]['present'] for i in operation['component_ids']):
        reasons.append('MISSING_COMPONENT')
    if verb in ('approach', 'inspect') and len(operation['component_ids']) != 1:
        reasons.append('ONE_TARGET_REQUIRED')
    if verb not in ('inspect','home') and any(not obj['accessible'] for obj in selected):
        reasons.append('PACKAGE_ACCESS_BLOCKED')
    if verb in MANIPULATION:
        limits = fixture['limits']
        masses = [obj['mass_kg'] for obj in selected]
        if any(not nonnegative(v) for v in [*masses, *limits.values()]) or any(not vector(obj['center_of_mass_m'],3) for obj in selected):
            reasons.append('UNKNOWN_LOAD_LIMIT')
        else:
            mass = sum(masses) + limits['tool_mass_kg']
            if mass > limits['payload_kg']:
                reasons.append('PAYLOAD_EXCEEDED')
            # Tool COM/grasp strength are intentionally unresolved in this fixture.
            reasons.append('LOAD_AND_GRASP_MODEL_UNVALIDATED')
        if verb == 'fasten' and fixture['tools']['screwdriver']['adapter'] is None:
            reasons.append('TOOL_NOT_BOUND')
    if verb == 'approach' and selected and not reasons:
        try:
            model.approach(q, selected[0]['position_m'])
        except ValueError as error:
            reasons.append(str(error))
    return {'status':'blocked' if reasons else 'ready', 'operation':deepcopy(operation),
            'reasons':reasons, 'command_dispatched':False, 'physical_feasibility':'unknown',
            'scope':'position-only approach/inspection; no contact or full-link collision validation'}


def check_tcp_path(objects: list[Json], model: RobotModel, start: list[float], goal: list[float]) -> None:
    """Check sampled TCP points against oriented envelopes; do not certify arm clearance."""
    obstacles = [(np.array(obj['position_m']), Rotation.from_quat(obj['orientation_xyzw']).as_matrix(), np.array(obj['size_m'])/2)
                 for obj in objects if obj['present']]
    for fraction in np.linspace(0, 1, 64):
        point = model.tcp(np.array(start)+fraction*(np.array(goal)-np.array(start)))
        if point[2] < .035:
            raise ValueError('BLOCKED_TCP_TABLE')
        if any(np.all(np.abs(rotation.T@(point-centre)) <= extent+.005) for centre,rotation,extent in obstacles):
            raise ValueError('BLOCKED_TCP_ENVELOPE')


def dataset_state(state: Json, fixture: Json, model: RobotModel) -> Json:
    """Project complete SI state including every modeled SO-101 actuator, with null telemetry."""
    task = state['task']
    frames = model.frames(state['q'])
    tcp = model.contract['tcp']
    actuators = []
    for index, name in enumerate(model.names):
        actuators.append({'id':name+'_servo', 'joint_id':name, 'coordinate':'revolute', 'unit':'rad',
                          'mapping':{'basis':'simulated_joint_coordinate','ratio':1,'physical_calibration':None},
                          'position':state['q'][index], 'command_target':task['goal_q'][index] if task and task.get('goal_q') else None,
                          'lower':float(model.lower[index]), 'upper':float(model.upper[index]),
                          'measured_position':None,'velocity':None,'effort':None,'current':None,'temperature':None,'fault':None})
    if fixture.get('fastening'):
        from .joint import assembly_status
        spec = fixture['fastening']
        actuators.append({'id':'screwdriver_spindle','joint_id':None,'coordinate':'continuous','unit':'rad',
            'mapping':{'basis':'simulated unwrapped spindle angle','pitch_m_per_revolution':spec['pitch_m'],'physical_calibration':None},
            'position':state['spindle_angle_rad'], 'command_target':spec['required_depth_m']/spec['pitch_m']*2*np.pi if task and task.get('capability') else None,
            'measured_position':None,'velocity':None,'effort':None,'current':None,'temperature':None,'fault':None})
    return {'state_id':f"{state['run_id']}:{state['revision']}", 'revision':state['revision'],
            'at_ms':state['at_ms'], 'time_basis':'recorded wall clock; controller advances bounded simulation dt',
            'run_id':state['run_id'], 'scene_revision':state['scene_revision'], 'domain':'sim',
            'evidence_kind':'simplified_simulated_fastening' if fixture.get('fastening') else 'simulated_kinematics_with_authored_stationary_components',
            'frame':fixture['frame'], 'units':fixture['units'], 'quaternion_order':'xyzw',
            'phase':task['stage'] if task else 'idle', 'operation_id':task.get('trace_operation_id') if task and task.get('operations') else task['id'] if task else None,
            'command_id':task.get('trace_command_id') if task and task.get('operations') else task['command_id'] if task and task.get('goal_q') else None,
            'A':{'id':fixture['agent_id'],'machine_id':fixture['machine_id']},
            'S':{'components':deepcopy(state['objects']), 'inventory':deepcopy(fixture['inventory']),
                 'connections':deepcopy(state.get('connections',fixture['connections'])), 'package':deepcopy(fixture['package'])},
            'M':{'id':fixture['machine_id'],'controller_id':fixture['controller_id'], 'model_sha256':model.sha,
                 'base_matrix_m':np.eye(4).tolist(), 'link_matrices_m':{name:m.tolist() for name,m in frames.items()},
                 'tcp_matrix_m':(frames[tcp['parent_link']]@np.array(tcp['matrix_m'])).tolist(),
                 'tools':deepcopy(fixture['tools']), 'tool_poses':[deepcopy(o) for o in state['objects'] if o['kind']=='tool'], 'actuators':actuators},
            'observation_ids':[obs['id'] for obs in state['observations'] if task and obs['task_id']==task['id']],
            'checks':deepcopy(task.get('result')) if task else None, 'assembly_status':assembly_status(state) if fixture.get('fastening') else 'not_executed', 'feasibility':'unknown'}
