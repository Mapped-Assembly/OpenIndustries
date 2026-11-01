"""Exercise cabinet fixture pins, preflight refusals and actual durable state replay."""
from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from uuid import uuid4

import numpy as np

from oi_embodied.cabinet import check_tcp_path, load_fixture, preflight
from oi_embodied.model import RobotModel
from oi_embodied.runtime import Runtime

ROOT = Path(__file__).resolve().parents[3]
MODEL = ROOT/'benchmarks/embodied'
CABINET = ROOT/'benchmarks/cabinet'


class CabinetTests(unittest.TestCase):
    """Use real SO-101 IK, SQLite and workers without pretending to execute assembly."""

    def setUp(self) -> None:
        """Create a separate station for each test."""
        self.directory = tempfile.TemporaryDirectory()
        self.runtime = Runtime(Path(self.directory.name), MODEL, cabinet_path=CABINET/'joint.json')

    def tearDown(self) -> None:
        """Release workers, leases and temporary state."""
        self.runtime.close()
        self.directory.cleanup()

    def send(self, action: str, text: str = '', selected: str | None = None, **changes: object) -> dict:
        """Send a normal correlated intent, optionally injecting invalid revision data."""
        state = self.runtime.snapshot()
        body = {'request_id':str(uuid4()),'run_id':state['run_id'],'action':action,'text':text,
                'selected_id':selected,'scene_revision':state['scene_revision'],'task_id':state['task']['id'] if state['task'] else None}
        body.update(changes)
        return self.runtime.request(body)

    def wait(self, *stages: str) -> dict:
        """Fail within a bounded time if the real controller stalls."""
        deadline = time.monotonic()+12
        while time.monotonic()<deadline:
            state = self.runtime.snapshot()
            if state['task'] and state['task']['stage'] in stages:
                return state
            time.sleep(.02)
        self.fail('Controller did not reach '+str(stages))

    def test_generated_inputs_reproduce_and_references_resolve(self) -> None:
        """Check committed geometry against its pinned generator, not an unrelated copy."""
        spec = importlib.util.spec_from_file_location('cabinet_builder', CABINET/'build_fixtures.py')
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name, expected in module.build().items():
            with self.subTest(fixture=name):
                self.assertEqual(json.loads((CABINET/(name+'.json')).read_text()), expected)
                loaded = load_fixture(CABINET/(name+'.json'), self.runtime.model)
                self.assertEqual(len(loaded['inventory']), 3 if name=='joint' else 17)
                for target in loaded['approach_targets']:
                    obj = next(obj for obj in loaded['objects'] if obj['id']==target)
                    goal = self.runtime.model.approach(self.runtime.state['q'],obj['position_m'])
                    check_tcp_path(loaded['objects'],self.runtime.model,self.runtime.state['q'],goal)
                    self.assertLess(np.linalg.norm(self.runtime.model.tcp(goal)-np.array(obj['position_m'])-[0,0,.1]),.003)

    def test_invalid_geometry_and_machine_pins_are_rejected(self) -> None:
        """A modified size, joint reference or frame cannot keep the old contract identity."""
        original = json.loads((CABINET/'joint.json').read_text())
        for field, value, code in [('frame','wrong','INCOMPATIBLE_FRAME'),('model_sha256','bad','PIN_MISMATCH')]:
            bad = deepcopy(original); bad[field] = value
            path = Path(self.directory.name)/'invalid.json'; path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError,code):
                load_fixture(path,self.runtime.model)
        bad = deepcopy(original); bad['objects'][0]['size_m'][0] *= 2
        path.write_text(json.dumps(bad))
        with self.assertRaisesRegex(ValueError,'GEOMETRY_PIN'):
            load_fixture(path,self.runtime.model)
        bad = deepcopy(original); bad['connections'][0]['features'][0]['hole_id']='wrong'
        path.write_text(json.dumps(bad))
        with self.assertRaisesRegex(ValueError,'FASTENER_MAPPING'):
            load_fixture(path,self.runtime.model)

    def test_preflight_reasons_before_dispatch_and_load_exceeded(self) -> None:
        """Missing parts, unsupported lifts, wrong units and unresolved ratings never move M."""
        original = self.runtime.snapshot()
        operation = {'verb':'lift','component_ids':['base_panel'],'frame':'base_link','units':self.runtime.cabinet['units']}
        result = self.send('preflight',json.dumps(operation),'base_panel')
        self.assertEqual(result['status'],'blocked')
        self.assertIn('UNKNOWN_LOAD_LIMIT',result['reasons'])
        self.assertIn('UNSUPPORTED_CAPABILITY',result['reasons'])
        self.assertFalse(result['command_dispatched'])
        self.assertEqual(original['q'],self.runtime.snapshot()['q'])
        self.assertIsNone(self.runtime.snapshot()['task'])
        bad = {**operation,'verb':'inspect','component_ids':['absent'],'frame':'camera'}
        result = self.send('preflight',json.dumps(bad))
        self.assertIn('MISSING_COMPONENT',result['reasons'])
        self.assertIn('INCOMPATIBLE_FRAME_OR_UNITS',result['reasons'])
        unreachable = deepcopy(self.runtime.state['objects'])
        unreachable[0]['position_m'] = [5,0,.1]
        check = preflight(self.runtime.cabinet,unreachable,{**operation,'verb':'approach'},self.runtime.model,self.runtime.state['q'])
        self.assertIn('UNREACHABLE_TARGET',check['reasons'])
        with self.assertRaisesRegex(ValueError,'SCENE_CHANGED'):
            self.send('preflight',json.dumps(operation),scene_revision=-1)
        fixture = deepcopy(self.runtime.cabinet)
        fixture['limits'] = {'payload_kg':.01,'tool_mass_kg':.02,'wrist_moment_Nm':1.,'grip_force_N':1.}
        objects = deepcopy(self.runtime.state['objects'])
        objects[0].update({'mass_kg':.02,'center_of_mass_m':[0,0,0]})
        result = preflight(fixture,objects,operation,self.runtime.model,self.runtime.state['q'])
        self.assertIn('PAYLOAD_EXCEEDED',result['reasons'])

    def test_motion_replay_restart_and_state_identity(self) -> None:
        """Recorded snapshots reproduce live joints/poses while assembly remains unexecuted."""
        initial = self.runtime.trace()['states'][0]
        self.send('run')
        self.send('chat','approach selected','base_panel')
        self.wait('running')
        self.send('stop')
        self.assertEqual(self.wait('paused')['task']['stage'],'paused')
        self.send('resume')
        done = self.wait('completed','needs_review')
        self.assertEqual(done['task']['stage'],'completed',done['task'])
        self.assertEqual(done['objects'],initial['objects'])
        trace = self.runtime.trace()
        self.assertTrue(trace['complete'])
        self.assertGreater(len(trace['states']),4)
        self.assertEqual(trace['states'][-1]['dataset_state'],done['dataset_state'])
        for state in trace['states']:
            data = state['dataset_state']; machine = data['M']
            self.assertEqual(data['state_id'],f"{trace['run_id']}:{state['revision']}")
            self.assertEqual(machine['link_matrices_m'],state['robot']['frames'])
            self.assertEqual([a['position'] for a in machine['actuators']],state['q'])
            self.assertEqual(len(machine['actuators']),6)
            self.assertTrue(all(a['measured_position'] is None for a in machine['actuators']))
            self.assertEqual(data['assembly_status'],'not_executed')
        self.runtime.close()
        self.runtime = Runtime(Path(self.directory.name),MODEL,cabinet_path=CABINET/'joint.json')
        recovered = self.runtime.trace()
        self.assertEqual(recovered['states'][0],initial)
        self.assertEqual(recovered['fixture'],trace['fixture'])
        self.assertEqual(recovered['run_id'],trace['run_id'])
        self.assertEqual(recovered['states'][-1]['q'],done['q'])

    def test_wrong_fixture_on_restart_does_not_replace_station(self) -> None:
        """Prevent silently changing a saved joint station into the packaged scene."""
        run = self.runtime.state['run_id']
        self.runtime.close()
        try:
            with self.assertRaisesRegex(ValueError,'FIXTURE_PIN_MISMATCH'):
                Runtime(Path(self.directory.name),MODEL,cabinet_path=CABINET/'packaged.json')
        finally:
            self.runtime = Runtime(Path(self.directory.name),MODEL,cabinet_path=CABINET/'joint.json')
        self.assertEqual(self.runtime.state['run_id'],run)

    def test_closed_package_blocks_hidden_target(self) -> None:
        """An inaccessible panel cannot be approached through the lid."""
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(Path(directory),MODEL,cabinet_path=CABINET/'packaged.json')
            try:
                operation = {'verb':'approach','component_ids':['bottom_panel'],'frame':'base_link','units':runtime.cabinet['units']}
                check = preflight(runtime.cabinet,runtime.state['objects'],operation,runtime.model,runtime.state['q'])
                self.assertEqual(check['reasons'],['PACKAGE_ACCESS_BLOCKED'])
                obstacle = deepcopy(runtime.state['objects'][0])
                obstacle.update({'position_m':runtime.model.tcp(runtime.state['q']).tolist(),'size_m':[.1,.1,.1]})
                with self.assertRaisesRegex(ValueError,'BLOCKED_TCP_ENVELOPE'):
                    check_tcp_path([obstacle],runtime.model,runtime.state['q'],runtime.model.home.tolist())
            finally:
                runtime.close()

    def test_retention_gap_is_explicit_and_keeps_initial_state(self) -> None:
        """Long runs cannot silently export a truncated trace as complete."""
        initial = self.runtime.trace()['states'][0]
        with self.runtime.lock:
            for revision in range(1,515):
                self.runtime.state['revision'] = revision
                self.runtime.persist()
        trace = self.runtime.trace()
        self.assertEqual(len(trace['states']),512)
        self.assertFalse(trace['complete'])
        self.assertEqual(trace['states'][0],initial)
        self.assertEqual(trace['states'][-1]['revision'],514)


if __name__=='__main__':
    unittest.main()
