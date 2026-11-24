"""Compile declarative workcell/adapter JSON and execute a configured manipulation task."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

import mujoco as mj
import numpy as np


def keys(value: dict[str, Any], required: set[str], optional: set[str] = frozenset()) -> None:
    """Reject missing/unknown fields instead of silently accepting misspelled configuration."""
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - optional:
        raise ValueError(f'Expected fields {sorted(required)}, optional {sorted(optional)}; got {value}')


def load(path: Path, schema: str) -> dict[str, Any]:
    """Read versioned JSON with nonstandard NaN/Infinity constants rejected."""
    def invalid_constant(value: str) -> None:
        """Reject non-JSON numeric constants."""
        raise ValueError(f'Invalid JSON constant: {value}')
    value = json.loads(path.read_text(), parse_constant=invalid_constant)
    if not isinstance(value, dict) or value.get('schema') != schema or value.get('version') != 1:
        raise ValueError(f'Expected {schema} version 1')
    return value


def attributes(values: dict[str, Any]) -> dict[str, str]:
    """Encode typed numeric vectors/scalars or string enum attributes for MuJoCo."""
    def scalar(value: Any) -> str:
        """Validate a single native MJCF attribute component."""
        if isinstance(value, str):
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value):
            raise ValueError('MJCF attributes require strings or finite numbers')
        return str(int(value)) if float(value).is_integer() else str(value)
    return {key: ' '.join(scalar(v) for v in value) if isinstance(value, list) else scalar(value)
            for key, value in values.items()}


def append_node(parent: ET.Element, spec: dict[str, Any]) -> None:
    """Compile a bounded structural MJCF node; no Python code or expressions are evaluated."""
    keys(spec, {'tag', 'attributes'}, {'children'})
    if spec['tag'] not in {'body', 'geom', 'joint', 'freejoint', 'site', 'inertial'}:
        raise ValueError(f'Unsupported workcell node: {spec["tag"]}')
    node = ET.SubElement(parent, spec['tag'], attributes(spec['attributes']))
    for child in spec.get('children', []):
        append_node(node, child)


def select(root: ET.Element, selector: dict[str, str], many: bool = False) -> list[ET.Element]:
    """Select existing robot elements by exact attributes, rejecting unresolved references."""
    if 'tag' not in selector:
        raise ValueError('Robot selector requires tag')
    found = [node for node in root.iter(selector['tag'])
             if all(node.get(key) == value for key, value in selector.items() if key != 'tag')]
    if not found or not many and len(found) != 1:
        raise ValueError(f'Robot selector must resolve {"one or more" if many else "exactly one"} elements: {selector}')
    return found


def compile_workcell(scene_path: Path, adapter_path: Path) -> mj.MjModel:
    """Load the pinned robot and compile JSON geometry and explicit robot adaptations."""
    scene = load(scene_path, 'oi.mujoco-workcell')
    keys(scene, {'schema', 'version', 'units', 'upAxis', 'robot', 'options', 'world'})
    if scene['units'] != 'm-kg-s-rad' or scene['upAxis'] != 'Z':
        raise ValueError('Physics workcell must use SI/radians and Z-up')
    robot = scene['robot']
    keys(robot, {'file', 'sha256', 'meshDirectory'})
    raw = (scene_path.parent / robot['file']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != robot['sha256']:
        raise ValueError('Pinned robot XML hash mismatch')
    root = ET.fromstring(raw)
    select(root, {'tag': 'compiler'})[0].set('meshdir', str((scene_path.parent / robot['meshDirectory']).resolve()))
    option = root.find('option')
    if option is None:
        option = ET.SubElement(root, 'option')
    option.attrib.update(attributes(scene['options']))
    world = select(root, {'tag': 'worldbody'})[0]
    for node in scene['world']:
        append_node(world, node)
    adapter = load(adapter_path, 'oi.mujoco-adapter')
    keys(adapter, {'schema', 'version', 'updates', 'append', 'unnamedGeomPrefix'})
    for update in adapter['updates']:
        keys(update, {'selector', 'attributes', 'many'})
        if not isinstance(update['many'], bool):
            raise ValueError('Selector many must be boolean')
        for target in select(root, update['selector'], update['many']):
            target.attrib.update(attributes(update['attributes']))
    for addition in adapter['append']:
        keys(addition, {'selector', 'nodes'})
        target = select(root, addition['selector'])[0]
        for node in addition['nodes']:
            append_node(target, node)
    for geom in world.iter('geom'):
        if 'name' not in geom.attrib:
            geom.set('name', adapter['unnamedGeomPrefix'] + str(sum('name' in node.attrib for node in root.iter('geom'))))
    return mj.MjModel.from_xml_string(ET.tostring(root, encoding='unicode'))


def positive(value: Any, label: str, allow_zero: bool = False) -> None:
    """Validate a finite positive configuration parameter without accepting booleans."""
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not np.isfinite(value) or (value < 0 if allow_zero else value <= 0):
        raise ValueError(f'{label} must be finite and {"nonnegative" if allow_zero else "positive"}')


def vector(value: Any, length: int, label: str) -> np.ndarray:
    """Validate a numeric vector with an explicit dimension."""
    if not isinstance(value, list) or len(value) != length or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in value):
        raise ValueError(f'{label} requires {length} numbers')
    array = np.array(value, dtype=float)
    if not np.isfinite(array).all():
        raise ValueError(f'{label} must be finite')
    return array


class JsonCell:
    """Task-independent state-machine executor; all scene/task identifiers come from JSON."""

    def __init__(self, scene: Path, adapter: Path, task: Path) -> None:
        """Compile configuration, resolve model references and initialize actuator state."""
        self.policy = None
        self.control_due = True
        self.overrides: dict[int, float] = {}
        self.m = compile_workcell(scene, adapter)
        self.task = load(task, 'oi.pick-place-task')
        keys(self.task, {'schema', 'version', 'robot', 'initial', 'ik', 'control', 'gripperCommands', 'references', 'success', 'phases', 'record'})
        self.d, self.ikdata = mj.MjData(self.m), mj.MjData(self.m)
        self.phase, self.running, self.error = 'ready', False, None
        self.index, self.phase_index, self.phase_time = 0, -1, 0.
        self.target: np.ndarray | None = None
        self.events: list[dict[str, Any]] = []
        robot = self.task['robot']
        keys(robot, {'armJoints', 'armActuators', 'gripperJoint', 'gripperActuator', 'tcpSite'})
        self.joints = np.array([self.resolve(mj.mjtObj.mjOBJ_JOINT, name) for name in robot['armJoints']])
        self.actuators = np.array([self.resolve(mj.mjtObj.mjOBJ_ACTUATOR, name) for name in robot['armActuators']])
        if len(self.joints) != len(self.actuators) or len(set(self.joints)) != len(self.joints) or not len(self.joints):
            raise ValueError('Arm joints/actuators must be unique, nonempty and equally sized')
        if any(self.m.jnt_type[j] != int(mj.mjtJoint.mjJNT_HINGE) for j in self.joints):
            raise ValueError('This IK executor supports hinge arm joints')
        if not np.array_equal(self.m.actuator_trnid[self.actuators, 0], self.joints):
            raise ValueError('Actuators must drive their corresponding declared joints')
        self.qadr, self.vadr = self.m.jnt_qposadr[self.joints], self.m.jnt_dofadr[self.joints]
        self.grip_joint = self.resolve(mj.mjtObj.mjOBJ_JOINT, robot['gripperJoint'])
        self.grip_actuator = self.resolve(mj.mjtObj.mjOBJ_ACTUATOR, robot['gripperActuator'])
        self.site = self.resolve(mj.mjtObj.mjOBJ_SITE, robot['tcpSite'])
        self.validate_task()
        initial = self.task['initial']
        self.d.qpos[self.qadr] = initial['arm']
        self.d.qpos[self.m.jnt_qposadr[self.grip_joint]] = initial['gripper']
        self.d.ctrl[self.actuators], self.d.ctrl[self.grip_actuator] = initial['arm'], initial['gripper']
        mj.mj_forward(self.m, self.d)
        self.d.qpos[self.qadr] = self.ik(initial['tcp'])
        self.d.ctrl[self.actuators] = self.d.qpos[self.qadr]
        mj.mj_forward(self.m, self.d)

    def resolve(self, kind: mj.mjtObj, name: str) -> int:
        """Resolve named model references once and fail on missing IDs."""
        index = mj.mj_name2id(self.m, kind, name)
        if index < 0:
            raise ValueError(f'Missing {kind.name} reference: {name}')
        return index

    def validate_task(self) -> None:
        """Validate all task targets and phase conditions before simulation starts."""
        task, n = self.task, len(self.joints)
        keys(task['initial'], {'arm', 'gripper', 'tcp'})
        initial_arm = vector(task['initial']['arm'], n, 'initial.arm')
        vector(task['initial']['tcp'], 3, 'initial.tcp')
        if np.any(initial_arm < self.m.jnt_range[self.joints, 0]) or np.any(initial_arm > self.m.jnt_range[self.joints, 1]):
            raise ValueError('Initial arm state exceeds joint limits')
        keys(task['ik'], {'seeds', 'iterations', 'orientationWeight', 'orientationAxes', 'toolAxis', 'worldAxis', 'convergence', 'damping', 'maxJointStep', 'jointMargin', 'maxPositionError'})
        for seed in task['ik']['seeds']:
            vector(seed, n, 'IK seed')
        for field in ('iterations', 'orientationWeight', 'convergence', 'damping', 'maxJointStep', 'jointMargin', 'maxPositionError'):
            positive(task['ik'][field], field)
        if type(task['ik']['iterations']) is not int or task['ik']['iterations'] > 1000:
            raise ValueError('IK iterations must be an integer <= 1000')
        axis = vector(task['ik']['worldAxis'], 3, 'worldAxis')
        if not np.isclose(np.linalg.norm(axis), 1) or task['ik']['toolAxis'] not in (0, 1, 2) or not task['ik']['orientationAxes'] or any(type(a) is not int or a not in (0, 1, 2) for a in task['ik']['orientationAxes']):
            raise ValueError('Invalid IK orientation axes')
        keys(task['control'], {'maxJointStep', 'reachedTolerance', 'phaseTimeout'})
        for name, value in task['control'].items():
            positive(value, name)
        for value in [task['initial']['gripper'], *task['gripperCommands'].values()]:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or not self.m.actuator_ctrlrange[self.grip_actuator, 0] <= value <= self.m.actuator_ctrlrange[self.grip_actuator, 1]:
                raise ValueError('Gripper command outside actuator limits')
        for reference in task['references'].values():
            if set(reference) == {'body'}:
                self.resolve(mj.mjtObj.mjOBJ_BODY, reference['body'])
            elif set(reference) == {'position'}:
                vector(reference['position'], 3, 'reference.position')
            else:
                raise ValueError('Reference requires exactly body or position')
        success = task['success']
        keys(success, {'body','geom','freeJoint','fingerGeoms','supportGeom','center','axes','tolerance','maxSpeed','heightAxis','minLiftHeight'})
        for field, kind in [('body', mj.mjtObj.mjOBJ_BODY), ('geom', mj.mjtObj.mjOBJ_GEOM), ('freeJoint', mj.mjtObj.mjOBJ_JOINT), ('supportGeom', mj.mjtObj.mjOBJ_GEOM)]:
            self.resolve(kind, success[field])
        for name in success['fingerGeoms']:
            self.resolve(mj.mjtObj.mjOBJ_GEOM, name)
        if not success['fingerGeoms'] or len(set(success['fingerGeoms'])) != len(success['fingerGeoms']):
            raise ValueError('Finger contact references must be distinct and nonempty')
        if self.m.jnt_type[self.m.joint(success['freeJoint']).id] != int(mj.mjtJoint.mjJNT_FREE):
            raise ValueError('Task object must have a free joint')
        if not success['axes'] or any(type(a) is not int or a not in (0, 1, 2) for a in success['axes']) or success['heightAxis'] not in (0, 1, 2):
            raise ValueError('Invalid success coordinate axes')
        vector(success['center'], len(success['axes']), 'center')
        tolerances = vector(success['tolerance'], len(success['axes']), 'tolerance')
        if np.any(tolerances <= 0):
            raise ValueError('Placement tolerances must be positive')
        positive(success['maxSpeed'], 'maxSpeed'); positive(success['minLiftHeight'], 'minLiftHeight', True)
        ids = set()
        if not task['phases']:
            raise ValueError('Task requires phases')
        for phase in task['phases']:
            keys(phase, {'id','minSeconds','requireReached'}, {'target','grip','check','retryUntil'})
            if not isinstance(phase['id'], str) or phase['id'] in ids or phase['id'] in ('ready','complete','fault'):
                raise ValueError('Invalid or duplicate phase ID')
            ids.add(phase['id'])
            positive(phase['minSeconds'], 'minSeconds', True)
            if phase['minSeconds'] >= task['control']['phaseTimeout'] or not isinstance(phase['requireReached'], bool):
                raise ValueError('Invalid phase timing/condition')
            if phase.get('check') not in (None, 'bilateral_contact', 'lift_height', 'placement'):
                raise ValueError('Unknown phase check')
            if 'retryUntil' in phase:
                positive(phase['retryUntil'], 'retryUntil')
                if not phase['minSeconds'] < phase['retryUntil'] < task['control']['phaseTimeout']:
                    raise ValueError('retryUntil must follow minSeconds and precede timeout')
            if 'grip' in phase and phase['grip'] not in task['gripperCommands']:
                raise ValueError('Missing gripper command')
            if 'target' in phase:
                keys(phase['target'], {'reference','offset'})
                if phase['target']['reference'] not in task['references']:
                    raise ValueError('Missing task target reference')
                vector(phase['target']['offset'], 3, 'target.offset')
        keys(task['record'], {'maxSteps', 'sampleEverySteps', 'negativeMaxSteps'})
        for value in task['record'].values():
            if type(value) is not int or not 1 <= value <= 1_000_000:
                raise ValueError('Recording budgets must be bounded positive integers')

    def ik(self, position: list[float] | np.ndarray) -> np.ndarray:
        """Solve configured TCP translation and orientation with damped Jacobian IK."""
        p, d, best = self.task['ik'], self.ikdata, None
        axes = p['orientationAxes']
        for seed in [self.d.qpos[self.qadr], *[np.array(seed) for seed in p['seeds']]]:
            d.qpos[:] = self.d.qpos
            d.qpos[self.qadr] = seed
            for _ in range(p['iterations']):
                mj.mj_forward(self.m, d)
                rot = d.site_xmat[self.site].reshape(3, 3)
                error = np.r_[np.array(position)-d.site_xpos[self.site], np.cross(rot[:, p['toolAxis']], p['worldAxis'])[axes]*p['orientationWeight']]
                if np.linalg.norm(error) < p['convergence']:
                    break
                jp, jr = np.zeros((3, self.m.nv)), np.zeros((3, self.m.nv))
                mj.mj_jacSite(self.m, d, jp, jr, self.site)
                jac = np.vstack([jp[:, self.vadr], jr[axes][:, self.vadr]*p['orientationWeight']])
                delta = jac.T @ np.linalg.solve(jac@jac.T + np.eye(len(error))*p['damping'], error)
                d.qpos[self.qadr] = np.clip(d.qpos[self.qadr] + np.clip(delta, -p['maxJointStep'], p['maxJointStep']), self.m.jnt_range[self.joints,0]+p['jointMargin'], self.m.jnt_range[self.joints,1]-p['jointMargin'])
            distance = np.linalg.norm(d.site_xpos[self.site]-position)
            if best is None or distance < best[0]:
                best = distance, d.qpos[self.qadr].copy()
        if best is None or best[0] > p['maxPositionError']:
            raise RuntimeError(f'Unreachable task target: {position}')
        return best[1]

    def enter(self, index: int) -> None:
        """Resolve a phase target from current object state or a declared world point."""
        self.phase_index, self.phase_time = index, self.d.time
        if index == len(self.task['phases']):
            self.phase, self.running, self.index = 'complete', False, 1
        else:
            phase = self.task['phases'][index]
            self.phase = phase['id']
            if 'target' in phase:
                target = phase['target']; ref = self.task['references'][target['reference']]
                position = self.d.body(ref['body']).xpos.copy() if 'body' in ref else np.array(ref['position'])
                self.target = self.ik(position + target['offset'])
            if 'grip' in phase:
                self.d.ctrl[self.grip_actuator] = self.task['gripperCommands'][phase['grip']]
        self.events.append({'time': round(self.d.time, 3), 'phase': self.phase, 'can': self.index})

    def command(self, command: str) -> None:
        """Start/resume or pause; completed and failed tasks cannot restart implicitly."""
        if command == 'start':
            if self.phase == 'ready':
                self.enter(0)
            if self.phase not in ('complete', 'fault'):
                self.running = True
        elif command == 'pause':
            self.running = False
        else:
            raise ValueError(f'Unsupported command: {command}')

    def contact(self, other: str) -> bool:
        """Test real contact pairs between the configured task object and another geom."""
        a, b = self.m.geom(self.task['success']['geom']).id, self.m.geom(other).id
        return any({c.geom1, c.geom2} == {a, b} for c in self.d.contact)

    def check(self, kind: str) -> bool:
        """Evaluate physical task predicates entirely against MuJoCo state."""
        s = self.task['success']
        if kind == 'bilateral_contact':
            return all(self.contact(name) for name in s['fingerGeoms'])
        position = self.d.body(s['body']).xpos
        if kind == 'lift_height':
            return bool(position[s['heightAxis']] >= s['minLiftHeight'])
        if kind == 'placement':
            adr = self.m.joint(s['freeJoint']).dofadr[0]
            return bool(self.contact(s['supportGeom']) and np.all(np.abs(position[s['axes']] - s['center']) < s['tolerance']) and np.linalg.norm(self.d.qvel[adr:adr+6]) < s['maxSpeed'])
        raise ValueError(f'Unknown task predicate: {kind}')

    def tick(self) -> None:
        """Advance controls and fixed-step physics, then evaluate the configured transition."""
        if not self.running:
            return
        try:
            c = self.task['control']
            if self.target is not None and self.control_due:
                if self.policy is None:
                    self.d.ctrl[self.actuators] += np.clip(self.target-self.d.ctrl[self.actuators], -c['maxJointStep'], c['maxJointStep'])
                else:
                    self.d.ctrl[self.actuators] = self.policy.slew_many(self.d.ctrl[self.actuators].tolist(), self.target.tolist(), c['maxJointStep'])
            for a, value in self.overrides.items():
                self.d.ctrl[a] = value
            limited = self.m.actuator_ctrllimited.astype(bool)
            if not np.isfinite(self.d.ctrl).all() or np.any(self.d.ctrl[limited] < self.m.actuator_ctrlrange[limited, 0]) or np.any(self.d.ctrl[limited] > self.m.actuator_ctrlrange[limited, 1]):
                raise RuntimeError("Controller command exceeds actuator limits")
            mj.mj_step(self.m, self.d)
            if any(w.number for w in self.d.warning) or not np.isfinite(self.d.qpos).all():
                raise RuntimeError('MuJoCo instability')
            elapsed = self.d.time - self.phase_time
            phase = self.task['phases'][self.phase_index]
            reached = self.target is None or np.max(np.abs(self.target-self.d.qpos[self.qadr])) < c['reachedTolerance']
            if self.policy is not None:
                passed = 'check' not in phase or self.check(phase['check'])
                decision = self.policy.transition(elapsed, phase['minSeconds'], c['phaseTimeout'],
                                                 phase.get('retryUntil', 0), phase['requireReached'], reached, passed)
                if decision == -2:
                    raise RuntimeError(f'{self.phase} timeout')
                if decision == -1:
                    raise RuntimeError(f'Task check failed: {phase.get("check")}')
                if decision == 0:
                    return
            else:
                if elapsed > c['phaseTimeout']:
                    raise RuntimeError(f'{self.phase} timeout')
                phase = self.task['phases'][self.phase_index]
                reached = self.target is None or np.max(np.abs(self.target-self.d.qpos[self.qadr])) < c['reachedTolerance']
                if elapsed <= phase['minSeconds'] or phase['requireReached'] and not reached:
                    return
                if 'check' in phase and not self.check(phase['check']):
                    if elapsed < phase.get('retryUntil', 0):
                        return
                    raise RuntimeError(f'Task check failed: {phase["check"]}')
            self.enter(self.phase_index + 1)
        except Exception as error:
            self.error, self.phase, self.running = str(error), 'fault', False
