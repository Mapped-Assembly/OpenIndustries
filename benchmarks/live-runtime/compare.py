"""Compare repeated native/WASM live runs against physical and numerical baselines."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    """Run isolated processes, retaining metrics without redundant full trajectories."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--fast', action='store_true')
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('comparison.json'))
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error('repeats must be 1..10')
    scenes = {'single-can': 'benchmarks/native-render/so101/json',
              'five-cans': 'benchmarks/native-render/so101/json/five-cans',
              'blocks': 'benchmarks/native-render/so101/json/block-transfer',
              'gate': 'benchmarks/live-runtime/gate'}
    trials, parity = [], []
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for name, config in scenes.items():
        for repeat in range(args.repeats):
            pair = []
            for backend in ('native', 'wasm'):
                path = args.output.parent/f'.{name}-{backend}.json'
                command = [sys.executable, str(ROOT/'tools/geospatial/live_runtime.py'), str(ROOT/config),
                           '--backend', backend, '--probe-commands', '--report', str(path)]
                if args.fast:
                    command.append('--fast')
                result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
                if not path.exists():
                    raise RuntimeError(result.stderr or result.stdout)
                report = json.loads(path.read_text()); path.unlink()
                pair.append(report)
                summary = {k: v for k, v in report.items() if k not in ('trajectory', 'events', 'state')}
                summary.update(scene=name, repeat=repeat, state={k:v for k,v in report['state'].items() if k not in ('bodies','contacts','qpos')})
                trials.append(summary)
                print(f'{name} #{repeat+1} {backend}: success={report["assessment"]["success"]}, ratio={report["simulation_wall_ratio"]:.3f}', flush=True)
            a,b = pair
            same_times = [x['time'] for x in a['trajectory']] == [x['time'] for x in b['trajectory']]
            delta = float(np.max(np.abs(np.array([x['qpos'] for x in a['trajectory']])-np.array([x['qpos'] for x in b['trajectory']])))) if same_times else None
            parity.append({'scene':name,'repeat':repeat,'same_sample_times':same_times,'max_qpos_delta':delta,
                           'same_events':a['events']==b['events'],
                           'passed':bool(same_times and delta is not None and delta<=1e-8 and a['events']==b['events'] and a['assessment']['success'] and b['assessment']['success'])})
    output = {'repeats':args.repeats,'paced':not args.fast,'qpos_tolerance':1e-8,
              'passed':all(p['passed'] for p in parity),'parity':parity,'trials':trials}
    args.output.write_text(json.dumps(output,indent=2)+'\n')
    if not output['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
