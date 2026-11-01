"""Integration tests for supported fastening through the existing durable authority."""
from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from uuid import uuid4
from collections.abc import Callable

import numpy as np

from oi_embodied import joint
from oi_embodied.runtime import Runtime

ROOT = Path(__file__).resolve().parents[3]
MODEL = ROOT/'benchmarks/embodied'
FIXTURES = ROOT/'benchmarks/cabinet'


def request(runtime: Runtime, action: str, text: str = '') -> dict:
    """Build exactly the request schema used by the workbench HTTP endpoint."""
    state = runtime.snapshot()
    return {'request_id':str(uuid4()),'run_id':state['run_id'],'action':action,'text':text,
            'selected_id':None,'scene_revision':state['scene_revision'],'task_id':state['task']['id'] if state['task'] else None}


def wait(runtime: Runtime, predicate: Callable[[dict], bool], timeout: float = 25.) -> dict:
    """Poll a live independent worker with a strict wall-clock bound."""
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        state = runtime.snapshot()
        if predicate(state):
            return state
        if not state['healthy']:
            raise AssertionError('Worker failed: '+str(runtime.failure))
        time.sleep(.02)
    raise AssertionError('Timed out: '+str(runtime.snapshot()['task']))


def terminal(state: dict) -> bool:
    """Recognize real task terminal outcomes, including truthful refusal."""
    return bool(state['task'] and state['task']['stage'] in ('completed','blocked','failed','needs_review'))


class JointTests(unittest.TestCase):
    """Check observable effects, interruption boundaries and evaluator independence."""

    def setUp(self) -> None:
        """Create a unique SQLite station with the staged A fixture."""
        self.directory = tempfile.TemporaryDirectory()
        self.runtime = Runtime(Path(self.directory.name),MODEL,cabinet_path=FIXTURES/'fastening-a.json')

    def tearDown(self) -> None:
        """Release the station worker and lease."""
        self.runtime.close()
        self.directory.cleanup()

    def begin(self) -> dict:
        """Submit one command through the same task API as chat."""
        if self.runtime.state['mode']!='run':
            self.runtime.request(request(self.runtime,'run'))
        body = request(self.runtime,'chat','assemble corner')
        self.runtime.request(body)
        return body

    def test_three_reachable_configurations_and_reproducible_inputs(self) -> None:
        """Keep the arm start fixed and prove three distinct target-derived trajectories."""
        spec = importlib.util.spec_from_file_location('joint_builder',FIXTURES/'build_joint_fixtures.py')
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        finals = []; starts = []
        for name,expected in module.build().items():
            with self.subTest(fixture=name), tempfile.TemporaryDirectory() as directory:
                self.assertEqual(json.loads((FIXTURES/(name+'.json')).read_text()),expected)
                runtime = Runtime(Path(directory),MODEL,cabinet_path=FIXTURES/(name+'.json'))
                try:
                    initial = runtime.snapshot(); starts.append(initial['q'])
                    runtime.request(request(runtime,'run'))
                    runtime.request(request(runtime,'chat','assemble corner'))
                    done = wait(runtime,terminal)
                    self.assertEqual(done['task']['stage'],'completed',done['task'])
                    self.assertEqual(joint.evaluate(done,runtime.cabinet,runtime.model,final=True)['status'],'succeeded')
                    self.assertTrue(all(c['status']=='pass' for c in done['task']['result']['checks'].values()))
                    self.assertAlmostEqual(done['spindle_angle_rad'],24*np.pi)
                    self.assertEqual(done['dataset_state']['assembly_status'],'succeeded_simulated_joint')
                    self.assertFalse(done['task']['result']['physical_validated'])
                    finals.append(done['q'])
                    trace = runtime.trace()
                    self.assertTrue(trace['complete'])
                    self.assertEqual(len(trace['operation_receipts']),4)
                    self.assertEqual(len({r['command_id'] for r in trace['operation_receipts']}),4)
                    for operation in done['task']['operations']:
                        interval = [s for s in trace['states'] if operation['start_revision']<=s['revision']<=operation['end_revision']]
                        self.assertTrue(interval)
                        self.assertTrue(all(s['dataset_state']['operation_id']==operation['id'] for s in interval))
                    self.assertEqual(len(done['dataset_state']['M']['actuators']),7)
                    screw = [s['objects'][2]['fastener']['insertion_m'] for s in trace['states']]
                    self.assertEqual(screw,sorted(screw))
                    self.assertEqual(initial['objects'][:2],done['objects'][:2], 'No unimplemented panel manipulation')
                    self.assertNotEqual(initial['objects'][4]['position_m'],done['objects'][4]['position_m'])
                finally:
                    runtime.close()
        self.assertEqual(starts,[starts[0]]*3)
        self.assertEqual(len({tuple(round(v,4) for v in q) for q in finals}),3)

    def test_preconditions_block_without_fastening_effects(self) -> None:
        """Missing screw, misalignment, tool access, support and unknown loads fail closed."""
        baseline = deepcopy(self.runtime.state['objects'])
        for scenario in ('screw','misalignment','support','unknown_support','tool_access','wrong_hole','unknown_mass'):
            with self.subTest(scenario=scenario):
                with self.runtime.lock:
                    self.runtime.state['objects'] = deepcopy(baseline)
                    objects = self.runtime.state['objects']
                    if scenario=='screw': objects[2]['present']=False
                    if scenario=='misalignment': objects[1]['position_m'][1]+=.01
                    if scenario=='support': objects[3]['clamps_engaged']=False
                    if scenario=='unknown_support': objects[3]['clamps_engaged']=None
                    if scenario=='tool_access': objects[4]['accessible']=False
                    if scenario=='wrong_hole': objects[2]['fastener']['hole_id']='other-hole'
                    if scenario=='unknown_mass': objects[0]['mass_kg']=None
                before = deepcopy(self.runtime.state['q'])
                self.begin(); done = wait(self.runtime,terminal)
                self.assertEqual(done['task']['stage'],'blocked',done['task'])
                self.assertEqual(before,done['q'])
                self.assertEqual(done['spindle_angle_rad'],0.)
                self.assertEqual(done['objects'][2]['fastener']['insertion_m'],0.)
                self.assertNotIn('controller_receipts',done['task'])

    def test_unreachable_tool_target_is_bounded(self) -> None:
        """A consistent but remote clamped setup cannot bypass actual tool-pose IK."""
        fixture = deepcopy(self.runtime.cabinet); fixture.pop('sha256')
        for obj in fixture['objects']:
            if obj['kind']!='tool': obj['position_m'][0]+=1.
        for value in fixture['target_assembly'].values(): value['position_m'][0]+=1.
        fixture['connections'][0]['features'][0]['position_m'][0]+=1.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'fixture.json'; path.write_text(json.dumps(fixture))
            runtime = Runtime(Path(directory)/'station',MODEL,cabinet_path=path)
            try:
                runtime.request(request(runtime,'run'))
                runtime.request(request(runtime,'chat','assemble corner'))
                done = wait(runtime,terminal,8)
                self.assertEqual(done['task']['stage'],'blocked')
                self.assertIn('UNREACHABLE_TOOL_ACCESS',done['task']['reason'])
                self.assertEqual(done['spindle_angle_rad'],0.)
            finally:
                runtime.close()

    def test_stop_resume_retry_and_independent_checks(self) -> None:
        """Retain partial insertion; reject changed support before resume; never double-apply."""
        body = self.begin()
        wait(self.runtime,lambda s: 0.001<s['objects'][2]['fastener']['insertion_m']<.005)
        stopped = self.runtime.request(request(self.runtime,'stop'))
        self.assertEqual(stopped['status'],'paused')
        partial = self.runtime.snapshot()
        time.sleep(.15)
        self.assertEqual(self.runtime.snapshot()['spindle_angle_rad'],partial['spindle_angle_rad'])
        self.assertEqual(self.runtime.request(body)['task_id'],partial['task']['id'])
        self.assertEqual(self.runtime.snapshot()['spindle_angle_rad'],partial['spindle_angle_rad'])
        report = joint.evaluate(partial,self.runtime.cabinet,self.runtime.model,final=True)
        self.assertEqual(report['checks']['insertion_depth']['status'],'fail')
        self.assertEqual(report['checks']['connection']['status'],'fail')
        with self.runtime.lock: self.runtime.state['objects'][3]['clamps_engaged']=False
        with self.assertRaisesRegex(ValueError,'REQUIRED_SUPPORT'):
            self.runtime.request(request(self.runtime,'resume'))
        self.assertEqual(self.runtime.snapshot()['task']['stage'],'paused')
        with self.runtime.lock: self.runtime.state['objects'][3]['clamps_engaged']=True
        self.runtime.request(request(self.runtime,'resume'))
        done = wait(self.runtime,terminal)
        self.assertEqual(done['task']['stage'],'completed',done['task'])
        self.assertAlmostEqual(done['spindle_angle_rad'],24*np.pi)
        self.runtime.request(body)  # Lost completion acknowledgement, same request.
        self.assertEqual(self.runtime.snapshot()['spindle_angle_rad'],done['spindle_angle_rad'])
        # Forged narration and success fields cannot establish a result.
        bad = deepcopy(done); bad['objects'][2]['fastener']['insertion_m']=None
        bad['task']['result']['status']='succeeded'; bad['messages']=[]
        report = joint.evaluate(bad,self.runtime.cabinet,self.runtime.model,final=True)
        self.assertEqual(report['status'],'blocked')
        self.assertEqual(report['checks']['insertion_depth']['status'],'unknown')
        for field in ('hole_id','nominal'):
            bad = deepcopy(done); bad['objects'][2]['fastener'][field]='wrong'
            self.assertEqual(joint.evaluate(bad,self.runtime.cabinet,self.runtime.model,final=True)['status'],'blocked')

    def test_cancel_partial_then_new_task_reconciles_depth(self) -> None:
        """A new attempt continues saved insertion instead of spinning another full screw."""
        self.begin()
        wait(self.runtime,lambda s: s['objects'][2]['fastener']['insertion_m']>.001)
        self.runtime.request(request(self.runtime,'cancel'))
        partial = self.runtime.snapshot()
        self.assertEqual(partial['task']['result']['status'],'cancelled')
        self.assertEqual(partial['dataset_state']['assembly_status'],'partial')
        self.begin(); done = wait(self.runtime,terminal)
        self.assertEqual(done['task']['stage'],'completed',done['task'])
        self.assertGreater(done['task']['initial_depth_m'],0.)
        self.assertAlmostEqual(done['spindle_angle_rad'],24*np.pi)

    def test_lost_support_and_deadline_stop_before_more_effects(self) -> None:
        """Revalidate each controller tick and bound execution without rolling back work."""
        for fault in ('support','deadline'):
            with self.subTest(fault=fault):
                self.begin()
                wait(self.runtime,lambda s: s['task']['stage']=='running' and s['task'].get('capability')==joint.CAPABILITY and s['objects'][2]['fastener']['insertion_m']>.001)
                with self.runtime.lock:
                    before = self.runtime.state['spindle_angle_rad']
                    if fault=='support':
                        self.runtime.state['objects'][3]['clamps_engaged']=False
                    else:
                        self.runtime.state['task']['active_elapsed_s']=46.
                failed = wait(self.runtime,terminal)
                self.assertEqual(failed['task']['stage'],'failed')
                self.assertEqual(failed['spindle_angle_rad'],before)
                self.assertEqual(failed['dataset_state']['assembly_status'],'partial')
                self.assertIn('REQUIRED_SUPPORT' if fault=='support' else 'DEADLINE',failed['task']['reason'])
                with self.runtime.lock:
                    self.runtime.state['objects'][3]['clamps_engaged']=True

    def test_abrupt_exit_restores_receipt_and_partial_state(self) -> None:
        """Kill a separate authority after partial insertion, then reconcile before resume."""
        with tempfile.TemporaryDirectory() as directory:
            code = '''from pathlib import Path
from uuid import uuid4
from collections.abc import Callable
import json,os,time
from oi_embodied.runtime import Runtime
r=Runtime(Path(os.environ['JOINT_STATION']),Path('benchmarks/embodied'),cabinet_path=Path('benchmarks/cabinet/fastening-a.json'))
def send(action,text=''):
 s=r.snapshot();b=dict(request_id=str(uuid4()),run_id=s['run_id'],action=action,text=text,selected_id=None,scene_revision=s['scene_revision'],task_id=None);r.request(b);return b
send('run');b=send('chat','assemble corner')
while r.snapshot()['objects'][2]['fastener']['insertion_m']<.001: time.sleep(.02)
Path(os.environ['JOINT_STATION'],'request.json').write_text(json.dumps(b))
os._exit(0)
'''
            import os
            subprocess.run([sys.executable,'-c',code],cwd=ROOT,env={**os.environ,'JOINT_STATION':directory},check=True,timeout=25)
            runtime = Runtime(Path(directory),MODEL,cabinet_path=FIXTURES/'fastening-a.json')
            try:
                initial = runtime.snapshot()
                self.assertEqual(initial['task']['stage'],'paused')
                self.assertGreater(initial['objects'][2]['fastener']['insertion_m'],0.)
                body = json.loads((Path(directory)/'request.json').read_text())
                runtime.request(body)
                self.assertEqual(runtime.snapshot()['spindle_angle_rad'],initial['spindle_angle_rad'])
                runtime.request(request(runtime,'resume'))
                done = wait(runtime,terminal)
                self.assertEqual(done['task']['stage'],'completed',done['task'])
                self.assertAlmostEqual(done['spindle_angle_rad'],24*np.pi)
                self.assertEqual(len(runtime.trace()['operation_receipts']),4)
            finally:
                runtime.close()


if __name__=='__main__':
    unittest.main()
