"""Supported-joint controller operations and independent simulated-state evaluation.

This adapter has no worker, database or task authority. Runtime owns every accepted
operation and checkpoint. Tool motion is target-derived SO-101 IK; screw insertion
uses an explicitly declared pitch model, never a torque/contact measurement.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Literal, TypedDict
from uuid import UUID, uuid5

import numpy as np
from scipy.spatial.transform import Rotation

from .cabinet import nonnegative, vector
from .model import RobotModel

Json = dict[str, Any]
CAPABILITY = 'supported-joint-v1'


class JointParameters(TypedDict):
    """SI-valued parameters accepted by the registered joint controller."""

    depth_m: float
    position_tolerance_m: float
    axis_tolerance_rad: float


class JointOperation(TypedDict):
    """Durable operation identity, dependency and execution evidence contract."""

    id: str
    command_id: str
    verb: Literal['inspect', 'align', 'fasten', 'verify']
    capability: str
    controller_id: str
    machine_id: str
    tool_id: str
    component_ids: list[str]
    joint_id: str
    hole_id: str
    frame: str
    parameters: JointParameters
    depends_on: list[str]
    expected_scene_revision: int
    observed_revision: int
    active_deadline_s: float
    preconditions: list[str]
    expected_postconditions: list[str]
    cancellation: str
    status: str
    start_revision: int | None
    end_revision: int | None



def specification(fixture: Json) -> Json:
    """Resolve only the registered version of the simplified joint capability."""
    spec = fixture.get('fastening', {})
    if spec.get('capability') != CAPABILITY:
        raise ValueError('UNSUPPORTED_FASTENING_CAPABILITY')
    return spec


def validate_fixture(fixture: Json, model: RobotModel) -> None:
    """Reject malformed adapter contracts before they can initialize durable state."""
    spec = specification(fixture)
    if (spec.get('frame'),spec.get('length_unit'),spec.get('angle_unit')) != ('base_link','m','rad'):
        raise ValueError('INCOMPATIBLE_FASTENING_FRAME_OR_UNITS')
    for name in ('required_depth_m','pitch_m','insertion_rate_m_s','position_tolerance_m',
                 'angle_tolerance_rad','depth_tolerance_m','active_deadline_s'):
        if not nonnegative(spec.get(name)) or spec[name] == 0:
            raise ValueError('INVALID_FASTENING_PARAMETER: '+name)
    if spec['required_depth_m'] > .01 or spec['position_tolerance_m'] > .001 or spec['angle_tolerance_rad'] > .02 or spec['depth_tolerance_m'] > .0001 or spec['active_deadline_s'] > 60:
        raise ValueError('UNSUPPORTED_FASTENING_LIMIT')
    if spec.get('panel_ids') != ['base_panel','upright_panel'] or spec.get('joint_id') != 'corner' or spec.get('screw_id') != 'screw_1' or spec.get('hole_id') != 'corner_hole' or spec.get('support_id') != 'holding_fixture' or spec.get('tool_id') != 'screwdriver':
        raise ValueError('UNSUPPORTED_JOINT_BINDING')
    if spec.get('controller_id') != fixture['controller_id'] or spec.get('recovery_attempts') != 0:
        raise ValueError('UNSUPPORTED_CONTROLLER_CONTRACT')
    driver = fixture['tools']['screwdriver']
    if (driver.get('adapter') != 'sim-spindle-at-so101-tcp-v1' or driver.get('mounted') is not True or
        driver.get('tip_matrix') != np.eye(4).tolist() or driver.get('axis_local') != [0,0,1] or
        driver.get('spindle_actuator') != 'screwdriver_spindle' or driver.get('body_length_m') != .09):
        raise ValueError('TOOL_NOT_BOUND')
    q = fixture.get('initial_q_rad')
    if not vector(q,6) or np.any(np.array(q)<model.lower) or np.any(np.array(q)>model.upper):
        raise ValueError('INVALID_INITIAL_JOINTS')
    feature = fixture['connections'][0]['features'][0]
    if not vector(feature.get('position_m'),3) or not vector(feature.get('outward_axis'),3) or abs(np.linalg.norm(feature['outward_axis'])-1)>1e-6:
        raise ValueError('INVALID_MATING_FEATURE')


def target(fixture: Json) -> tuple[np.ndarray, np.ndarray]:
    """Resolve the screw-head contact point and inward axis from the pinned hole."""
    spec = specification(fixture)
    connection = next(c for c in fixture['connections'] if c['id']==spec['joint_id'])
    feature = next(f for f in connection['features'] if f['hole_id']==spec['hole_id'])
    axis = -np.array(feature['outward_axis'],dtype=float)
    return np.array(feature['position_m'])-.02*axis, axis


def check(status: bool | None, **evidence: Any) -> Json:
    """Preserve unknown required values instead of converting them into success."""
    return {'status':'unknown' if status is None else 'pass' if status else 'fail', **evidence}


def evaluate(state: Json, fixture: Json, model: RobotModel, *, final: bool = False, engaged: bool = False) -> Json:
    """Independently inspect state and pinned geometry; never consult narration or goals."""
    spec = specification(fixture)
    objects = {o['id']:o for o in state['objects']}
    required = [*spec['panel_ids'],spec['screw_id'],spec['support_id'],spec['tool_id']]
    checks = {'inventory':check(all(i in objects and objects[i].get('present') is True for i in required))}
    if checks['inventory']['status'] != 'pass':
        return {'status':'blocked', 'checks':checks, 'reasons':['MISSING_COMPONENT'], 'physical_validated':False}
    panels = [objects[i] for i in spec['panel_ids']]
    screw, support, tool = (objects[spec[k]] for k in ('screw_id','support_id','tool_id'))
    head, axis = target(fixture)
    fastener = screw.get('fastener',{})
    depth = fastener.get('insertion_m')
    angle = state.get('spindle_angle_rad')
    checks['screw_identity'] = check(fastener.get('nominal')=='M3' and fastener.get('joint_id')==spec['joint_id'] and
        fastener.get('hole_id')==spec['hole_id'] and fastener.get('pitch_m')==spec['pitch_m'] and fastener.get('length_m')==.02)
    for panel in panels:
        desired = fixture['target_assembly'][panel['id']]
        pos_error = float(np.linalg.norm(np.array(panel['position_m'])-desired['position_m']))
        angle_error = float((Rotation.from_quat(panel['orientation_xyzw']).inv()*Rotation.from_quat(desired['orientation_xyzw'])).magnitude())
        checks[panel['id']+'_pose'] = check(pos_error<=fixture['tolerances']['position_m'] and angle_error<=fixture['tolerances']['angle_rad'],
            position_error_m=pos_error, angle_error_rad=angle_error)
    initial_support = next(o for o in fixture['objects'] if o['id']==spec['support_id'])
    support_values = [support.get('clamps_engaged'),support.get('supported'),*[p.get('supported') for p in panels]]
    support_ok = (all(v is True for v in support_values) and all(p.get('support_id')==support['id'] for p in panels)
        and set(spec['panel_ids']).issubset(support.get('clamped_component_ids') or [])
        and np.linalg.norm(np.array(support['position_m'])-initial_support['position_m'])<.001
        and (Rotation.from_quat(support['orientation_xyzw']).inv()*Rotation.from_quat(initial_support['orientation_xyzw'])).magnitude()<.01)
    checks['required_support'] = check(None if any(v is None for v in support_values) else bool(support_ok))
    limits = fixture['limits']; driver = fixture['tools']['screwdriver']
    load_values = [support.get('load_capacity_kg'),driver.get('mass_kg'),*limits.values(),*[p.get('mass_kg') for p in panels]]
    load_known = all(nonnegative(v) for v in load_values)
    checks['declared_loads'] = check(None if not load_known else bool(
        sum(p['mass_kg'] for p in panels)<=support['load_capacity_kg'] and
        driver['mass_kg']<=limits['payload_kg'] and driver['mass_kg']*9.81*.045<=limits['wrist_moment_Nm']), provenance='simulation assumptions')
    checks['tool_binding'] = check(driver.get('mounted') is True and driver.get('adapter')=='sim-spindle-at-so101-tcp-v1' and tool.get('attached_to')=='pinned_tcp')
    checks['tool_access'] = check(all(objects[i].get('accessible') is True for i in required))
    coherent = nonnegative(depth) and nonnegative(angle)
    checks['insertion_state'] = check(None if depth is None or angle is None else bool(coherent and
        depth<=spec['required_depth_m']+spec['depth_tolerance_m'] and abs(angle*spec['pitch_m']/(2*np.pi)-depth)<1e-8))
    connection = next((c for c in state.get('connections',[]) if c['id']==spec['joint_id']),{})
    expected_connection = 'connected' if coherent and depth>=spec['required_depth_m'] else 'partial' if coherent and depth>0 else 'unconnected'
    checks['connection_progress'] = check(None if connection.get('state') is None or fastener.get('installed') is None else bool(
        coherent and connection.get('state')==expected_connection and fastener['installed']==(expected_connection=='connected')))
    if coherent:
        expected_centre = head+axis*(.01+depth)
        error = float(np.linalg.norm(np.array(screw['position_m'])-expected_centre))
        screw_axis = Rotation.from_quat(screw['orientation_xyzw']).as_matrix()[:,2]
        checks['screw_hole_pose'] = check(error<=spec['position_tolerance_m'] and np.arccos(np.clip(screw_axis@axis,-1,1))<=spec['angle_tolerance_rad'], position_error_m=error)
    else:
        checks['screw_hole_pose'] = check(None)
    tcp = model.tool_matrix(state['q'])
    tool_rotation = Rotation.from_quat(tool['orientation_xyzw']).as_matrix()
    checks['tool_pose_binding'] = check(bool(np.linalg.norm(np.array(tool['position_m'])-(tcp[:3,3]-.045*tcp[:3,2]))<1e-6 and
        np.linalg.norm(tool_rotation[:,2]-tcp[:3,2])<1e-6))
    if engaged or final:
        pos_error = float(np.linalg.norm(tcp[:3,3]-(head+axis*(depth if coherent else 0))))
        axis_error = float(np.arccos(np.clip(tcp[:3,2]@axis,-1,1)))
        checks['tool_alignment'] = check(pos_error<=spec['position_tolerance_m'] and axis_error<=spec['angle_tolerance_rad'], position_error_m=pos_error, axis_error_rad=axis_error)
    if final:
        checks['insertion_depth'] = check(None if not coherent else abs(depth-spec['required_depth_m'])<=spec['depth_tolerance_m'], actual_m=depth, required_m=spec['required_depth_m'])
        connection = next((c for c in state.get('connections',[]) if c['id']==spec['joint_id']),{})
        checks['connection'] = check(connection.get('state')=='connected' and fastener.get('installed') is True and
            connection.get('screw_ids')==[spec['screw_id']] and connection.get('component_ids')==spec['panel_ids'])
    reasons = [name.upper() for name,value in checks.items() if value['status']!='pass']
    return {'status':('succeeded' if final else 'ready') if not reasons else 'blocked', 'checks':checks,
            'reasons':reasons, 'state_revision':state['revision'], 'physical_validated':False, 'contact_validated':False,
            'model':'simplified supported fastening; no measured torque', 'torque_Nm':None}


def require_ready(result: Json) -> None:
    """Fail closed on failed or unknown required checks."""
    if result['reasons']:
        raise ValueError('; '.join(result['reasons']))


def tool_clearance(state: Json, model: RobotModel, q: list[float]) -> None:
    """Check sampled bit/body envelopes against panels and support, not full arm links."""
    pose = model.tool_matrix(q)
    for distance in np.linspace(0,.09,24):
        radius = .002 if distance<.012 else .018
        point = pose[:3,3]-distance*pose[:3,2]
        if point[2]-radius < .001:
            raise ValueError('BLOCKED_TOOL_TABLE')
        for obj in state['objects']:
            if obj['kind'] not in ('panel','fixture') or obj.get('present') is not True:
                continue
            local = Rotation.from_quat(obj['orientation_xyzw']).inv().apply(point-np.array(obj['position_m']))
            if np.all(np.abs(local) <= np.array(obj['size_m'])/2+radius):
                raise ValueError('BLOCKED_TOOL_ACCESS')


def path(state: Json, model: RobotModel, start: list[float], end: np.ndarray, axis: np.ndarray) -> list[list[float]]:
    """Solve a Cartesian target path and validate the actual interpolated joint samples."""
    origin = model.tcp(start); waypoints = [start]
    for fraction in np.linspace(0,1,17)[1:]:
        q = model.tool_pose(waypoints[-1],(origin+fraction*(end-origin)).tolist(),axis.tolist())
        for blend in np.linspace(0,1,5):
            tool_clearance(state,model,(np.array(waypoints[-1])+blend*(np.array(q)-waypoints[-1])).tolist())
        waypoints.append(q)
    return waypoints


def prepare(state: Json, fixture: Json, model: RobotModel, task: Json) -> Json:
    """Build bounded typed operations from targets after observing current partial state."""
    spec = specification(fixture)
    require_ready(evaluate(state,fixture,model))
    screw = next(o for o in state['objects'] if o['id']==spec['screw_id'])
    depth = screw['fastener']['insertion_m']
    head, axis = target(fixture)
    aligned = path(state,model,state['q'],head+axis*depth,axis)
    inserted = path(state,model,aligned[-1],head+axis*spec['required_depth_m'],axis)
    align_duration = max(2., max(float(np.max(np.abs(np.array(b)-a)))/.35 for a,b in zip(aligned,aligned[1:]))*(len(aligned)-1))
    insert_duration = max(.1,(spec['required_depth_m']-depth)/spec['insertion_rate_m_s'],
        max(float(np.max(np.abs(np.array(b)-a)))/.35 for a,b in zip(inserted,inserted[1:]))*(len(inserted)-1))
    if align_duration+insert_duration>spec['active_deadline_s']:
        raise ValueError('OPERATION_DEADLINE_EXCEEDED')
    operations: list[JointOperation] = []
    for verb in ('inspect','align','fasten','verify'):
        operation_id = str(uuid5(UUID(task['id']),CAPABILITY+':'+verb))
        operations.append({'id':operation_id, 'command_id':str(uuid5(UUID(operation_id),'controller')),
            'verb':verb, 'capability':CAPABILITY, 'controller_id':fixture['controller_id'], 'machine_id':fixture['machine_id'],
            'tool_id':spec['tool_id'],'component_ids':[*spec['panel_ids'],spec['screw_id']],
            'joint_id':spec['joint_id'],'hole_id':spec['hole_id'], 'frame':spec['frame'],
            'parameters':{'depth_m':spec['required_depth_m'],'position_tolerance_m':spec['position_tolerance_m'],
                          'axis_tolerance_rad':spec['angle_tolerance_rad']},
            'depends_on':[operations[-1]['id']] if operations else [],
            'expected_scene_revision':state['scene_revision'], 'observed_revision':state['revision'],
            'active_deadline_s':spec['active_deadline_s'],
            'preconditions':['correct screw/hole','panels aligned and clamped','known declared loads','mounted tool','reconciled insertion/spindle state'],
            'expected_postconditions':{'inspect':['all required checks pass'],'align':['TCP at screw head, axis aligned'],
                'fasten':['absolute depth reached; connection modeled connected'],'verify':['all independent final checks pass']}[verb],
            'cancellation':'retain partial state; reobserve and reconcile',
            'status':'pending','start_revision':None,'end_revision':None})
    return {'operations':operations,'paths':{'align':aligned,'fasten':inserted},
            'durations':{'align':align_duration,'fasten':insert_duration},'initial_depth_m':depth,
            'operation_index':0,'step_elapsed_s':0.,'active_elapsed_s':0.,'capability':CAPABILITY}


def update_tool(state: Json, fixture: Json, model: RobotModel) -> None:
    """Project mounted tool pose from arm state plus unwrapped spindle rotation."""
    spec = specification(fixture)
    tool = next(o for o in state['objects'] if o['id']==spec['tool_id'])
    pose = model.tool_matrix(state['q'])
    rotation = Rotation.from_matrix(pose[:3,:3])*Rotation.from_rotvec([0,0,state['spindle_angle_rad']])
    tool['position_m'] = (pose[:3,3]-.045*pose[:3,2]).tolist()
    tool['orientation_xyzw'] = rotation.as_quat().tolist()


def advance(state: Json, fixture: Json, model: RobotModel, task: Json, dt: float) -> None:
    """Advance exactly one accepted operation inside Runtime's checkpoint transaction."""
    spec = specification(fixture)
    operation = task['operations'][task['operation_index']]
    verb = operation['verb']
    task['trace_operation_id'] = operation['id']
    task['trace_command_id'] = operation['command_id']
    require_ready(evaluate(state,fixture,model,engaged=verb in ('fasten','verify')))
    task['active_elapsed_s'] += dt
    if task['active_elapsed_s']>spec['active_deadline_s']:
        raise ValueError('OPERATION_DEADLINE_EXCEEDED')
    if operation['status']=='pending':
        operation.update({'status':'accepted','start_revision':state['revision']})
        task.setdefault('controller_receipts',[]).append({'command_id':operation['command_id'],
            'operation_id':operation['id'],'accepted_revision':state['revision'],'completed_revision':None})
    complete = verb in ('inspect','verify')
    if verb in ('align','fasten'):
        task['step_elapsed_s'] = min(task['durations'][verb],task['step_elapsed_s']+dt)
        fraction = task['step_elapsed_s']/task['durations'][verb]
        points = task['paths'][verb]
        index = min(len(points)-2,int(fraction*(len(points)-1)))
        blend = fraction*(len(points)-1)-index
        state['q'] = (np.array(points[index])+(np.array(points[index+1])-points[index])*blend).tolist()
        tool_clearance(state,model,state['q'])
        task['goal_q'] = points[-1]
        if verb=='fasten':
            depth = task['initial_depth_m']+fraction*(spec['required_depth_m']-task['initial_depth_m'])
            screw = next(o for o in state['objects'] if o['id']==spec['screw_id'])
            head, axis = target(fixture)
            state['spindle_angle_rad'] = depth/spec['pitch_m']*2*np.pi
            screw['fastener'].update({'insertion_m':depth,'installed':fraction>=1})
            screw['position_m'] = (head+axis*(.01+depth)).tolist()
            screw['orientation_xyzw'] = (Rotation.align_vectors([axis],[[0,0,1]])[0]*Rotation.from_rotvec([0,0,state['spindle_angle_rad']])).as_quat().tolist()
            connection = next(c for c in state['connections'] if c['id']==spec['joint_id'])
            connection.update({'state':'connected' if fraction>=1 else 'partial','verified':False})
        update_tool(state,fixture,model)
        if verb=='fasten' or fraction>=1:
            require_ready(evaluate(state,fixture,model,engaged=True))
        complete = fraction>=1
    if verb=='verify':
        task['result'] = evaluate(state,fixture,model,final=True)
        require_ready(task['result'])
        for connection in state['connections']:
            connection['verified'] = True
        task['stage'] = 'completed'
    task['progress'] = (task['operation_index']+(1 if complete else task['step_elapsed_s']/task['durations'][verb]))/4
    if complete:
        operation.update({'status':'completed','end_revision':state['revision']})
        task['controller_receipts'][-1]['completed_revision'] = state['revision']
        operation['postcondition'] = deepcopy(evaluate(state,fixture,model,final=verb=='verify',engaged=verb in ('align','fasten')))
        if verb!='verify':
            task['operation_index'] += 1
            task['step_elapsed_s'] = 0.


def assembly_status(state: Json) -> str:
    """Describe retained connection state independently of the latest chat task."""
    connections = state.get('connections',[])
    if connections and all(c.get('verified') is True and c.get('state')=='connected' for c in connections):
        return 'succeeded_simulated_joint'
    if any(c.get('state') in ('partial','connected') for c in connections):
        return 'partial'
    return 'not_executed'
