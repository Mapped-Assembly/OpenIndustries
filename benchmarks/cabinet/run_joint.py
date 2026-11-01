"""Execute the three supported joints through OI's existing request/worker authority."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'services/embodied'))
from oi_embodied.runtime import Runtime
from oi_embodied.joint import evaluate


def send(runtime: Runtime, action: str, text: str = '') -> dict[str, Any]:
    """Submit the same versioned intent body used by the workbench HTTP endpoint."""
    state = runtime.snapshot()
    return runtime.request({'request_id':str(uuid4()),'run_id':state['run_id'],'action':action,'text':text,
        'selected_id':None,'scene_revision':state['scene_revision'],'task_id':state['task']['id'] if state['task'] else None})


def run(label: str, output: Path) -> dict[str, Any]:
    """Run a fresh local fixture; export actual snapshots and separately evaluated results."""
    with tempfile.TemporaryDirectory(prefix='oi-joint-') as directory:
        runtime = Runtime(Path(directory),ROOT/'benchmarks/embodied',cabinet_path=ROOT/f'benchmarks/cabinet/fastening-{label}.json')
        try:
            send(runtime,'run'); send(runtime,'chat','assemble corner')
            deadline = time.monotonic()+60
            while time.monotonic()<deadline:
                state = runtime.snapshot()
                if not state['healthy']:
                    raise RuntimeError('Authority failed: '+str(runtime.failure))
                if state['task']['stage'] not in ('planning','running'):
                    break
                time.sleep(.05)
            else:
                send(runtime,'stop')
                raise TimeoutError('Controller exceeded the capture deadline; partial state retained')
            trace = runtime.trace()
            check = evaluate(state,runtime.cabinet,runtime.model,final=True)
            data = gzip.compress(json.dumps(trace,sort_keys=True,separators=(',',':'),allow_nan=False).encode(),mtime=0)
            name = f'fastening-{label}-trace.json.gz'
            (output/name).write_bytes(data)
            result = {'fixture':runtime.cabinet['id'],'fixture_sha256':runtime.cabinet['sha256'],
                'source_revision':runtime.code_revision,'model_sha256':runtime.model.sha,'run_id':state['run_id'],
                'status':check['status'] if state['task']['stage']=='completed' else state['task']['stage'],
                'initial_state_id':trace['initial_state_id'],'final_state_id':trace['final_state_id'],
                'state_count':len(trace['states']),'trace_complete':trace['complete'],
                'trace':name,'trace_sha256':hashlib.sha256(data).hexdigest(),'checks':check['checks'],
                'domain':'sim','physical_evidence':None,'video':None,'resources':{'screws_installed':int(check['status']=='succeeded'),
                'active_simulation_s':state['task'].get('active_elapsed_s'),'energy_J':None,'torque_Nm':None},
                'operation_receipts':trace['operation_receipts']}
            if result['status']!='succeeded':
                raise RuntimeError(json.dumps(result))
            return result
        finally:
            runtime.close()


def main() -> None:
    """Publish a versioned manifest and compressed complete traces for every configuration."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'deliverables/cabinet-joint')
    args = parser.parse_args(); args.output.mkdir(parents=True,exist_ok=True)
    results = [run(label,args.output) for label in ('a','b','c')]
    (args.output/'results.json').write_text(json.dumps({'schema_version':1,'capability':'supported-joint-v1',
        'domain':'sim','results':results,'physical_validation':False,'human_video_recording':None},indent=2)+'\n')
    print('PASS three target-derived supported joints; traces and results: '+str(args.output))


if __name__=='__main__':
    main()
