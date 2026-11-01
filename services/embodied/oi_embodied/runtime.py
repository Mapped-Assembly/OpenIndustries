"""Durable single-robot authority: chat requests, controller jobs, evidence and receipts."""
from __future__ import annotations

from copy import deepcopy
import fcntl
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
from typing import Any
from uuid import UUID, uuid4, uuid5

import numpy as np

from .model import RobotModel
from .policy import Policy
from . import joint
from .cabinet import check_tcp_path, dataset_state, load_fixture, preflight

Json = dict[str, Any]
ACTIVE = ('planning', 'running', 'paused')


def canonical(value: Any) -> str:
    """Encode bounded durable JSON without nonfinite numbers."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def require(condition: bool, code: str) -> None:
    """Use stable public validation failures, never optimizable assertions."""
    if not condition:
        raise ValueError(code)


class Runtime:
    """Own the only writable robot state; model and browser only submit validated intents."""

    def __init__(self, directory: Path, fixture: Path, policy: Policy | None = None, cabinet_path: Path | None = None) -> None:
        """Load one persistent station, rejecting incompatible pins and pausing on restart."""
        self.model = RobotModel(fixture)
        self.cabinet = load_fixture(cabinet_path, self.model) if cabinet_path else None
        if self.cabinet and self.cabinet.get('fastening'):
            joint.validate_fixture(self.cabinet,self.model)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lease = (directory / 'station.lock').open('a+b')
        try:
            fcntl.flock(self.lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lease.close()
            raise ValueError('STATION_ALREADY_RUNNING') from None
        self.lock = threading.RLock()
        self.policy = policy or Policy()
        root = fixture.resolve().parents[1]
        try:
            self.code_revision = (root / 'RELEASE').read_text().strip() if (root / 'RELEASE').is_file() else subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
            if not (root / 'RELEASE').is_file() and subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=root, text=True).strip():
                self.code_revision += '+dirty'
        except (OSError, subprocess.CalledProcessError):
            self.code_revision = 'unrecorded-source'

        self.stop_event = threading.Event()
        self.policy_busy = False
        self.failure: str | None = None
        self.db = sqlite3.connect(directory / 'station.sqlite', check_same_thread=False)
        os.chmod(directory / 'station.sqlite', 0o600)
        app = self.db.execute('PRAGMA application_id').fetchone()[0]
        tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        require(app == 1330200904 or (app == 0 and not tables), 'INCOMPATIBLE_DATABASE')
        require(self.db.execute('PRAGMA user_version').fetchone()[0] in (0, 1), 'INCOMPATIBLE_VERSION')
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS station(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cabinet_frames(revision INTEGER PRIMARY KEY, body TEXT NOT NULL);
            PRAGMA application_id=1330200904; PRAGMA user_version=1;''')
        row = self.db.execute('SELECT body FROM station WHERE id=1').fetchone()
        self.state: Json = json.loads(row[0]) if row else {
            'controller_version': 'so101-kinematic-v1', 'run_id': str(uuid4()), 'scene_id': 'so101-tabletop-v1', 'scene_revision': 1,
            'model_sha256': self.model.sha, 'revision': 0, 'mode': 'edit',
            'q': self.model.home.tolist(), 'task': None, 'task_history': [], 'messages': [], 'observations': [],
            'objects': [{'id': 'red-block', 'name': 'red block', 'position_m': [.15, -.05, .015], 'size_m': [.03, .03, .03]},
                        {'id': 'blue-block', 'name': 'blue block', 'position_m': [.17, .05, .015], 'size_m': [.03, .03, .03]}],
            'destination': {'id': 'marked-area', 'position_m': [.24, 0, .002], 'size_m': [.08, .08, .004]},
        }
        if row:
            if self.state.get('cabinet_sha256') != (self.cabinet['sha256'] if self.cabinet else None):
                self.db.close()
                self.lease.close()
                raise ValueError('CABINET_FIXTURE_PIN_MISMATCH: use its original fixture or a separate state directory')
            if self.cabinet:
                self.state['revision'] += 1  # Record recovery without rewriting S_i.
        elif self.cabinet:
            self.state.update({'scene_id':self.cabinet['id'], 'cabinet_sha256':self.cabinet['sha256'],
                               'objects':deepcopy(self.cabinet['objects']), 'preflight':None})
        if not row and self.cabinet and self.cabinet.get('fastening'):
            self.state.update({'q':list(self.cabinet['initial_q_rad']), 'spindle_angle_rad':0.,
                               'connections':deepcopy(self.cabinet['connections'])})
            joint.update_tool(self.state,self.cabinet,self.model)
        require(self.state.get('controller_version') == 'so101-kinematic-v1', 'CONTROLLER_VERSION_MISMATCH')
        require(self.state['model_sha256'] == self.model.sha, 'MODEL_PIN_MISMATCH')
        if self.state['task'] and self.state['task']['stage'] in ACTIVE:
            self.state['task']['stage'] = 'paused'
            self.message('assistant', 'Recovered paused after process restart. Re-observe before Resume; no downtime motion was inferred.')
        self.persist()
        self.last_tick = time.monotonic()
        self.thread = threading.Thread(target=self.work, daemon=True)
        self.thread.start()

    def persist(self) -> None:
        """Write the current checkpoint inside the caller's SQLite transaction."""
        try:
            if self.cabinet:
                self.state['at_ms'] = int(time.time()*1000)
                projection = self.projection()
                self.db.execute('INSERT OR REPLACE INTO cabinet_frames VALUES(?,?)', (self.state['revision'], canonical(projection)))
                # Keep S_i plus the most recent 511 revisions; export declares any gap.
                self.db.execute('DELETE FROM cabinet_frames WHERE revision != 0 AND revision NOT IN (SELECT revision FROM cabinet_frames ORDER BY revision DESC LIMIT 511)')
            self.db.execute('INSERT OR REPLACE INTO station VALUES(1,?)', (canonical(self.state),))
            self.db.commit()
        except Exception:
            self.db.rollback()
            previous = self.db.execute('SELECT body FROM station WHERE id=1').fetchone()
            if previous:
                self.state = json.loads(previous[0])
            self.failure = 'WORKER_STORAGE_FAILURE'
            self.stop_event.set()
            raise

    def message(self, role: str, text: str, task_id: str | None = None) -> None:
        """Append bounded recorded narration; never accept model-written outcome claims."""
        self.state['messages'].append({'id': str(uuid4()), 'role': role, 'text': text,
                                       'task_id': task_id, 'at_ms': int(time.time() * 1000)})
        self.state['messages'] = self.state['messages'][-128:]

    def snapshot(self) -> Json:
        """Project the single local run without secrets or mutable references."""
        with self.lock:
            return {**self.projection(), **({'cabinet':deepcopy(self.cabinet)} if self.cabinet else {})}

    def projection(self) -> Json:
        """Produce the same authoritative display state for live view and recorded replay."""
        result = {**deepcopy(self.state), 'robot': self.model.projection(self.state['q']),
                  'source_revision': self.code_revision, 'policy_mode': self.policy.mode, 'skills': ['approach', 'inspect', 'home'],
                  'healthy': self.failure is None, 'cadence_ms': 50,
                  'observation_basis': 'privileged_simulated_state; no camera/contact/physical evidence'}
        if self.cabinet:
            if self.cabinet.get('fastening'):
                result['skills'] = ['inspect','assemble corner']
            result['dataset_state'] = dataset_state(self.state, self.cabinet, self.model)
        return result

    def trace(self) -> Json:
        """Export recorded states without dispatching commands; explicitly report retention gaps."""
        with self.lock:
            require(self.cabinet is not None, 'CABINET_FIXTURE_REQUIRED')
            states = [json.loads(row[0]) for row in self.db.execute('SELECT body FROM cabinet_frames ORDER BY revision')]
            revisions = [state['revision'] for state in states]
            receipts = [json.loads(row[0]) for row in self.db.execute('SELECT result FROM receipts ORDER BY rowid')]
            return {'schema_version':1, 'run_id':self.state['run_id'], 'fixture':deepcopy(self.cabinet),
                    'source_revision':self.code_revision, 'model_sha256':self.model.sha, 'machine_contract':deepcopy(self.model.contract),
                    'initial_state_id':states[0]['dataset_state']['state_id'], 'final_state_id':states[-1]['dataset_state']['state_id'],
                    'complete':revisions==list(range(revisions[-1]+1)), 'retention':'S_i and latest 511 revisions; gaps are explicit',
                    'states':states, 'receipts':receipts, 'replay_dispatches_commands':False, 'assembly_status':joint.assembly_status(self.state),
                    'operation_receipts':[r for t in [*self.state.get('task_history',[]),self.state.get('task')] if t for r in t.get('controller_receipts',[])]}

    def request(self, body: Json) -> Json:
        """Commit user intent and its immutable receipt once; accepted is not completed."""
        require(isinstance(body, dict) and set(body) == {'request_id', 'run_id', 'action', 'text', 'selected_id', 'scene_revision', 'task_id'}, 'INVALID_REQUEST')
        require(isinstance(body['request_id'], str) and str(UUID(body['request_id'])) == body['request_id'], 'INVALID_REQUEST_ID')
        require(isinstance(body['text'], str) and len(body['text']) <= 2000, 'INVALID_TEXT')
        require(body['task_id'] is None or isinstance(body['task_id'], str), 'INVALID_TASK_ID')
        require(body['selected_id'] is None or isinstance(body['selected_id'], str), 'INVALID_SELECTION')
        with self.lock:
            require(body['run_id'] == self.state['run_id'], 'RUN_NOT_AVAILABLE')
            old = self.db.execute('SELECT request,result FROM receipts WHERE id=?', (body['request_id'],)).fetchone()
            if old:
                require(old[0] == canonical(body), 'REQUEST_ID_REUSED')
                return json.loads(old[1])
            full = self.db.execute('SELECT count(*) FROM receipts').fetchone()[0] >= 512
            stop = body['action'] == 'stop' or body['action'] == 'chat' and body['text'].strip().lower() in ('stop', 'pause')
            require(not full or stop or body['action'] == 'cancel', 'REQUEST_LIMIT_REACHED')
            require(body['scene_revision'] == self.state['scene_revision'], 'SCENE_CHANGED')
            require(body['selected_id'] is None or body['selected_id'] in [o['id'] for o in self.state['objects']], 'TARGET_NOT_AVAILABLE')
            if full and stop and self.state['task'] and self.state['task']['stage'] == 'paused':
                # Global Stop is idempotent. At capacity acknowledge the already-stopped
                # controller without unbounded receipt growth. No new motion can start.
                return {'request_id': body['request_id'], 'run_id': self.state['run_id'], 'status': 'paused', 'task_id': self.state['task']['id']}
            before = deepcopy(self.state)
            try:
                result = self.apply_request(body)
                self.state['revision'] += 1
                receipt = {'request_id': body['request_id'], 'run_id': self.state['run_id'], **result}
                self.db.execute('INSERT INTO receipts VALUES(?,?,?)', (body['request_id'], canonical(body), canonical(receipt)))
                self.persist()
                return receipt
            except BaseException:
                self.db.rollback()
                self.state = before
                raise

    def apply_request(self, body: Json) -> Json:
        """Handle controls synchronously so Stop never waits for a model response."""
        action = body['action']
        text = body['text'].strip()
        if action == 'chat' and text.lower() in ('stop', 'pause', 'resume', 'status', 'what are you doing?'):
            action = {'pause': 'stop', 'what are you doing?': 'status'}.get(text.lower(), text.lower())
        task = self.state['task']
        if action == 'preflight':
            require(self.cabinet is not None, 'CABINET_FIXTURE_REQUIRED')
            require(not task or task['stage'] not in ACTIVE, 'TASK_ACTIVE')
            result = preflight(self.cabinet, self.state['objects'], json.loads(text), self.model, self.state['q'])
            self.state['preflight'] = result
            return result
        if action == 'edit_object':
            require(self.cabinet is None, 'PINNED_CABINET_FIXTURE: create a new version for edits')
            require(self.state['mode'] == 'edit' and (not task or task['stage'] not in ACTIVE), 'EDIT_MODE_REQUIRED')
            position = json.loads(text)
            require(isinstance(position, list) and len(position) == 3 and all(type(v) in (float, int) and np.isfinite(v) for v in position), 'INVALID_POSITION')
            require(.05 <= position[0] <= .35 and -.15 <= position[1] <= .15 and position[2] == .015, 'OUTSIDE_TABLETOP')
            target = next((o for o in self.state['objects'] if o['id'] == body['selected_id']), None)
            require(target is not None, 'SELECT_OBJECT')
            require(all(o['id'] == target['id'] or np.linalg.norm(np.array(position) - np.array(o['position_m'])) >= .05 for o in self.state['objects']), 'OBJECTS_OVERLAP')
            target['position_m'] = position
            self.state['scene_revision'] += 1
            self.message('assistant', 'Explicit scene edit saved. Subsequent tasks bind the new scene revision.')
            return {'status': 'scene_updated', 'scene_revision': self.state['scene_revision']}
        if action in ('run', 'edit'):
            require(not task or task['stage'] not in ACTIVE, 'TASK_ACTIVE')
            self.state['mode'] = action
            return {'status': action}
        if action == 'status':
            self.message('assistant', f"Recorded task: {task['stage'] if task else 'idle'}. Model: {self.policy.mode}.", task['id'] if task else None)
            return {'status': 'reported'}
        if action in ('stop', 'resume', 'cancel'):
            require(task is not None and task['stage'] in ACTIVE, 'NO_ACTIVE_TASK')
            if action in ('resume', 'cancel'):
                require(body['task_id'] == task['id'], 'TASK_CHANGED')
            if action == 'cancel':
                task['stage'] = 'cancelled'
                task['generation'] += 1
                if task.get('capability')==joint.CAPABILITY:
                    operation = task['operations'][task['operation_index']]
                    operation.update({'status':'cancelled','end_revision':self.state['revision']+1})
                    for receipt in task.get('controller_receipts',[]):
                        if receipt['operation_id']==operation['id']:
                            receipt['cancelled_revision'] = self.state['revision']+1
                    task['result'] = {'status':'cancelled','partial_state_preserved':True,'physical_validated':False}
                self.message('assistant', 'Cancelled. Saved arm, tool and component state retained.', task['id'])
            elif action == 'stop':
                task['stage'] = 'paused'
                task['generation'] += 1  # Late model/IK result cannot dispatch after Stop.
                task['stopped_at_ms'] = int(time.time() * 1000)
                self.message('assistant', 'Controller acknowledged stopped. Arm/tool poses and partial component state retained.', task['id'])
            else:
                require(task['stage'] == 'paused', 'NOT_PAUSED')
                require(task['scene_revision'] == self.state['scene_revision'], 'SCENE_CHANGED')
                self.observe(task)
                if task.get('capability')==joint.CAPABILITY:
                    verb = task['operations'][task['operation_index']]['verb']
                    joint.require_ready(joint.evaluate(self.state,self.cabinet,self.model,engaged=verb in ('fasten','verify')))
                    joint.tool_clearance(self.state,self.model,self.state['q'])
                task['stage'] = 'running' if task.get('goal_q') or task.get('capability')==joint.CAPABILITY else 'planning'
                self.last_tick = time.monotonic()
                self.message('assistant', 'Resuming the same task from its saved joint pose.', task['id'])
            return {'status': task['stage'], 'task_id': task['id']}
        require(action == 'chat' and text and self.state['mode'] == 'run', 'ENTER_RUN_MODE')
        require(not task or task['stage'] not in ACTIVE, 'TASK_ACTIVE: stop/cancel current work before a new goal')
        if task:
            self.state['task_history'] = (self.state.get('task_history', []) + [deepcopy(task)])[-64:]
        task_id = str(uuid4())
        self.state['task'] = {'id': task_id, 'request_id': body['request_id'], 'command_id': str(uuid5(UUID(task_id), 'controller-v1')),
                              'stage': 'planning', 'text': text, 'selected_id': body['selected_id'],
                              'scene_revision': self.state['scene_revision'], 'generation': 0, 'progress': 0,
                              'source_revision': self.code_revision, 'origin': 'model' if self.policy.mode == 'model' else 'manual', 'started_ms': int(time.time() * 1000)}
        self.message('user', text, task_id)
        return {'status': 'accepted', 'task_id': task_id}

    def observe(self, task: Json) -> Json:
        """Retain evaluator-state evidence with run/scene/model/frame/time provenance."""
        observation = {'id': str(uuid4()), 'run_id': self.state['run_id'], 'task_id': task['id'],
                       'scene_revision': self.state['scene_revision'], 'revision': self.state['revision'],
                       'at_ms': int(time.time() * 1000), 'frame': 'base_link', 'units': 'm/rad',
                       'kind': 'privileged_simulated_state', 'source_revision': self.code_revision, 'model_sha256': self.model.sha,
                       'robot': self.model.projection(self.state['q']), 'objects': deepcopy(self.state['objects'])}
        self.state['observations'] = (self.state['observations'] + [observation])[-64:]
        return observation

    def plan(self, task: Json, snapshot: Json) -> None:
        """Resolve one bounded proposal off-lock, then revalidate before authoritative dispatch."""
        try:
            if task['text'].strip().lower() == 'assemble corner':
                require(self.cabinet is not None, 'CABINET_FIXTURE_REQUIRED')
                prepared = joint.prepare(snapshot,self.cabinet,self.model,task)
                with self.lock:
                    current = self.state['task']
                    if current['id']!=task['id'] or current['stage']!='planning' or current['generation']!=task['generation']:
                        return
                    require(self.state['scene_revision']==task['scene_revision'] and self.state['q']==snapshot['q'] and self.state['objects']==snapshot['objects'] and self.state.get('connections')==snapshot.get('connections') and self.state.get('spindle_angle_rad')==snapshot.get('spindle_angle_rad'), 'STATE_CHANGED')
                    current.update(prepared)
                    current.update({'skill':'assemble corner','target_id':'corner','stage':'running',
                                    'before_observation':self.observe(current)['id']})
                    self.message('assistant','Executing supported joint: inspect, align tool, modeled fastening, independent verification. Panels were manually clamped; no grasp/contact or hardware validation.',current['id'])
                    self.state['revision'] += 1
                    self.persist()
                return
            decision = self.policy.decide(task['text'], task['selected_id'], {'objects': snapshot['objects'], 'destination': snapshot['destination'], 'recent_conversation': snapshot['messages'][-8:]})
            require(isinstance(decision, dict) and set(decision) == {'skill', 'target_id'}, 'INVALID_MODEL_PROPOSAL')
            skill, target = decision['skill'], decision['target_id']
            require(isinstance(skill, str) and skill in ('approach', 'inspect', 'home', 'clarify', 'unsupported'), 'UNSUPPORTED_SKILL')
            require(target is None or isinstance(target, str), 'INVALID_TARGET')
            targets = [o for o in snapshot['objects'] if o['id'] == target]
            if skill in ('approach', 'inspect'):
                words = task['text'].lower()
                named = [o['id'] for o in snapshot['objects'] if o['id'] in words or o['name'] in words]
                grounded = named[0] if len(named) == 1 else task['selected_id'] if not named else None
                require(grounded is not None, 'CLARIFICATION_REQUIRED: select a block or name its ID.')
                require(target == grounded, 'GROUNDING_MISMATCH: model target differs from explicit selection/name.')
            if skill in ('approach', 'home'):
                require(not re.search(r'\b(pick|place|grasp|grab|put|drop|lift)\b', task['text'], re.I), 'UNSUPPORTED_MANIPULATION: no pick/place skill is registered.')
            if skill == 'clarify' or skill in ('approach', 'inspect') and not targets:
                raise ValueError('CLARIFICATION_REQUIRED: select red-block or blue-block, then submit the request again.')
            require(skill != 'unsupported', 'UNSUPPORTED: pick/place, grasp/contact and physical control are not implemented in this milestone.')
            if self.cabinet and self.cabinet.get('fastening'):
                require(skill=='inspect','USE_ASSEMBLE_CORNER: mounted-tool motion is restricted to the registered joint procedure')
            if self.cabinet:
                check = preflight(self.cabinet, snapshot['objects'], {'verb':skill, 'component_ids':[target] if target else [],
                                  'frame':self.cabinet['frame'], 'units':self.cabinet['units']}, self.model, snapshot['q'])
                require(check['status']=='ready', '; '.join(check['reasons']))
            goal = self.model.home.tolist() if skill == 'home' else self.model.approach(snapshot['q'], targets[0]['position_m']) if skill == 'approach' else None
            with self.lock:
                current = self.state['task']
                if current['id'] != task['id'] or current['stage'] != 'planning' or current['generation'] != task['generation']:
                    return
                require(self.state['scene_revision'] == task['scene_revision'], 'SCENE_CHANGED')
                require(self.state['objects'] == snapshot['objects'] and self.state['q'] == snapshot['q'], 'STATE_CHANGED: re-observation required')
                current.update({'skill': skill, 'target_id': target, 'before_observation': self.observe(current)['id']})
                if goal is not None:
                    require(len(goal) == len(self.model.names) and np.all(np.isfinite(goal)) and np.all(np.array(goal) >= self.model.lower) and np.all(np.array(goal) <= self.model.upper), 'JOINT_LIMIT')
                    if self.cabinet:
                        check_tcp_path(snapshot['objects'], self.model, self.state['q'], goal)
                    for fraction in np.linspace(0, 1, 64):
                        point = self.model.tcp(np.array(self.state['q']) + fraction * (np.array(goal) - np.array(self.state['q'])))
                        require(point[2] >= .035, 'BLOCKED_TCP_TABLE')
                        if not self.cabinet:
                            require(all(np.linalg.norm(point - np.array(o['position_m'])) > .035 for o in snapshot['objects']), 'BLOCKED_TCP_OBJECT')
                if goal is None:
                    current['stage'] = 'completed'
                    self.message('assistant', f'Inspected {target} using simulated state. No motion or camera validation performed.', current['id'])
                else:
                    duration = max(2., float(np.max(np.abs(np.array(goal) - np.array(self.state['q'])))) / .35)
                    current.update({'goal_q': goal, 'start_q': list(self.state['q']), 'duration_s': duration, 'elapsed_s': 0., 'stage': 'running'})
                    self.message('assistant', f'Executing {skill} for {target or "reference home"}. Kinematic motion only; collision/contact unvalidated.', current['id'])
                self.state['revision'] += 1
                self.persist()
        except Exception as error:
            with self.lock:
                current = self.state['task']
                if current['id'] == task['id'] and current['stage'] == 'planning' and current['generation'] == task['generation']:
                    current['stage'] = 'needs_review'
                    current['reason'] = str(error) if isinstance(error, ValueError) else 'PLANNING_FAILED'
                    if task['text'].strip().lower()=='assemble corner':
                        current['stage'] = 'blocked'
                        current['result'] = {'status':'blocked','reason':current['reason'],'physical_validated':False}
                    self.message('assistant', current['reason'], current['id'])
                    self.state['revision'] += 1
                    self.persist()
        finally:
            with self.lock:
                self.policy_busy = False

    def work(self) -> None:
        """Advance accepted motion at 20 Hz independently of clients; bound elapsed steps."""
        while not self.stop_event.wait(.05):
            try:
                with self.lock:
                    now = time.monotonic()
                    dt = min(.1, max(0., now - self.last_tick))
                    self.last_tick = now
                    task = self.state['task']
                    if not task:
                        continue
                    if task['stage'] == 'planning' and not self.policy_busy:
                        self.policy_busy = True
                        threading.Thread(target=self.plan, args=(deepcopy(task), deepcopy(self.state)), daemon=True).start()
                    if task['stage'] != 'running':
                        continue
                    if task.get('capability')==joint.CAPABILITY:
                        before = deepcopy(self.state)
                        self.state['revision'] += 1
                        try:
                            joint.advance(self.state,self.cabinet,self.model,task,dt)
                        except ValueError as error:
                            self.state = before
                            task = self.state['task']
                            self.state['revision'] += 1
                            operation = task['operations'][task['operation_index']]
                            operation.update({'status':'failed','end_revision':self.state['revision']})
                            for receipt in task.get('controller_receipts',[]):
                                if receipt['operation_id']==operation['id']:
                                    receipt['failed_revision'] = self.state['revision']
                            task.update({'stage':'failed','reason':str(error),
                                         'result':{'status':'failed','reason':str(error),'partial_state_preserved':True,'physical_validated':False}})
                        if task['stage'] in ('completed','failed'):
                            task['after_observation'] = self.observe(task)['id']
                            self.message('assistant','Independent joint checks passed in the simplified simulation.' if task['stage']=='completed' else 'Joint execution stopped: '+task['reason'],task['id'])
                        self.persist()
                        continue
                    task['elapsed_s'] = min(task['duration_s'], task['elapsed_s'] + dt)
                    fraction = task['elapsed_s'] / task['duration_s']
                    self.state['q'] = (np.array(task['start_q']) + fraction * (np.array(task['goal_q']) - np.array(task['start_q']))).tolist()
                    task['progress'] = fraction
                    self.state['revision'] += 1
                    if fraction >= 1:
                        target = next((o for o in self.state['objects'] if o['id'] == task.get('target_id')), None)
                        error = float(np.linalg.norm(self.model.tcp(self.state['q']) - (np.array(target['position_m']) + [0, 0, .1]))) if task['skill'] == 'approach' and target else float(np.max(np.abs(np.array(self.state['q']) - self.model.home)))
                        task['stage'] = 'completed' if error <= .003 else 'needs_review'
                        task['after_observation'] = self.observe(task)['id']
                        task['result'] = {'motion_completed': error <= .003, 'tcp_error_m_or_home_joint_error_rad': error, 'tolerance': .003, 'contact_validated': False, 'physical_validated': False}
                        self.message('assistant', 'Recorded motion completed. No object was picked up or placed; contact and physical outcomes remain unvalidated.' if error <= .003 else 'Postcondition failed: stopped for review. No task success is claimed.', task['id'])
                    self.persist()
            except Exception:
                self.failure = 'WORKER_STORAGE_FAILURE'
                self.stop_event.set()

    def close(self) -> None:
        """Stop ticks; a fresh process must explicitly resume persisted active work."""
        self.stop_event.set()
        self.thread.join(timeout=2)
        # A bounded model request may still finish; invalidate it before closing storage.
        with self.lock:
            if self.state['task'] and self.state['task']['stage'] in ACTIVE:
                self.state['task']['stage'] = 'paused'
                self.state['task']['generation'] += 1
                if self.cabinet:
                    self.state['revision'] += 1
                self.persist()
            self.db.close()
            self.lease.close()
