"""Compare the preserved Python baseline with JSON configuration and mutation cases."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT/'tools/geospatial'))
sys.path.insert(0, str(HERE.parent))
from controller import Cell
from fetch_assets import main as fetch_assets
from json_workcell import JsonCell, load
from native_trajectory import record_trial

MODEL_FIELDS = ('body_pos','body_quat','body_mass','body_inertia','geom_type','geom_bodyid','geom_pos',
                'geom_quat','geom_size','geom_friction','geom_contype','geom_conaffinity','geom_solref',
                'geom_solimp','jnt_range','jnt_axis','jnt_pos','dof_damping','dof_frictionloss','dof_armature',
                'actuator_gainprm','actuator_biasprm','actuator_forcerange','actuator_ctrlrange',
                'mesh_vert','mesh_face','qpos0')


def summary(report: dict[str, Any]) -> dict[str, Any]:
    """Keep benchmark results readable while full traces remain in render evidence."""
    return {k: v for k, v in report.items() if k != 'trajectory'}


def set_pointer(document: dict[str, Any], path: str, value: Any) -> None:
    """Apply a literal JSON Pointer assignment, with no executable expressions."""
    parts = [p.replace('~1','/').replace('~0','~') for p in path.lstrip('/').split('/')]
    target: Any = document
    for part in parts[:-1]:
        target = target[int(part)] if isinstance(target, list) else target[part]
    target[int(parts[-1]) if isinstance(target, list) else parts[-1]] = value


def mutation(case: dict[str, Any]) -> dict[str, Any]:
    """Run a case described exclusively by JSON edits to the candidate configs."""
    docs = {name: json.loads((HERE/name).read_text()) for name in ('workcell.json','robot-adapter.json','task.json','render.json')}
    for change in case['changes']:
        set_pointer(docs[change['file']], change['path'], change['value'])
    with tempfile.TemporaryDirectory(prefix='oi-json-case-') as temp:
        directory = Path(temp)
        robot = docs['workcell.json']['robot']
        robot['file'] = str((HERE/robot['file']).resolve())
        robot['meshDirectory'] = str((HERE/robot['meshDirectory']).resolve())
        for name, value in docs.items():
            (directory/name).write_text(json.dumps(value))
        try:
            cell = JsonCell(directory/'workcell.json', directory/'robot-adapter.json', directory/'task.json')
            _, _, report = record_trial(cell, cell.task)
            result = summary(report)
            result['expected'] = case['expected']
            result['passed'] = report['success'] if case['expected'] == 'success' else not report['success'] and case.get('errorContains','') in (report['error'] or '')
            return result
        except ValueError as error:
            return {'expected': case['expected'], 'passed': case['expected'] == 'invalid' and case.get('errorContains','') in str(error), 'error': str(error)}


def main() -> None:
    """Run parity, deterministic repeats and config-only robustness/negative checks."""
    fetch_assets()
    task = load(HERE/'task.json', 'oi.pick-place-task')
    baseline, candidate = Cell(), JsonCell(HERE/'workcell.json', HERE/'robot-adapter.json', HERE/'task.json')
    model_checks = {field: bool(np.array_equal(getattr(baseline.m, field), getattr(candidate.m, field))) for field in MODEL_FIELDS}
    model_checks['counts'] = all(getattr(baseline.m,k) == getattr(candidate.m,k) for k in ('nq','nv','nu','nbody','ngeom','njnt'))
    model_checks['timestep'] = baseline.m.opt.timestep == candidate.m.opt.timestep
    model_checks['gravity'] = bool(np.array_equal(baseline.m.opt.gravity,candidate.m.opt.gravity))
    model_checks['integrator'] = baseline.m.opt.integrator == candidate.m.opt.integrator
    reports = []
    for index in range(3):
        a = baseline if index == 0 else Cell()
        b = candidate if index == 0 else JsonCell(HERE/'workcell.json', HERE/'robot-adapter.json', HERE/'task.json')
        _, _, ar = record_trial(a,task)
        _, _, br = record_trial(b,task)
        pa = np.array([v['object_position'] for v in ar['trajectory']])
        pb = np.array([v['object_position'] for v in br['trajectory']])
        same_grid = [v['time'] for v in ar['trajectory']] == [v['time'] for v in br['trajectory']]
        delta = {'duration_seconds': abs(ar['duration_seconds']-br['duration_seconds']),
                 'lift_height_m': abs(ar['maximum_object_height_m']-br['maximum_object_height_m']),
                 'final_position_m': float(np.linalg.norm(np.array(ar['final_object_position_m'])-br['final_object_position_m'])),
                 'max_trajectory_position_m': float(np.max(np.linalg.norm(pa-pb,axis=1))) if same_grid else None,
                 'phase_timing_equal': ar['events'] == br['events']}
        reports.append({'baseline':summary(ar),'json':summary(br),'delta':delta})
    tolerances = json.loads((HERE/'cases.json').read_text())['parityTolerances']
    parity = all(model_checks.values()) and all(r['baseline']['success'] and r['json']['success'] and
        r['delta']['duration_seconds'] <= tolerances['durationSeconds'] and
        r['delta']['lift_height_m'] <= tolerances['liftHeightM'] and
        r['delta']['final_position_m'] <= tolerances['finalPositionM'] and
        r['delta']['max_trajectory_position_m'] is not None and
        r['delta']['max_trajectory_position_m'] <= tolerances['trajectoryPositionM'] for r in reports)
    cases = {case['name']:mutation(case) for case in json.loads((HERE/'cases.json').read_text())['cases']}
    # Apply the same disabled-contact negative test to the untouched baseline.
    negative = Cell()
    for name in task['success']['fingerGeoms']:
        i=negative.m.geom(name).id
        negative.m.geom_contype[i]=negative.m.geom_conaffinity[i]=0
    _, _, nr = record_trial(negative,task)
    baseline_negative = not nr['success'] and 'Grasp failed' in (nr['error'] or '')
    report = {'baseline_commit':'aff9e1d7b22b8d4ec7ded48b322781c7f00abfab',
              'baseline_controller_sha256':hashlib.sha256((HERE.parent/'controller.py').read_bytes()).hexdigest(),
              'configuration_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [HERE/'workcell.json',HERE/'robot-adapter.json',HERE/'task.json',HERE/'render.json',HERE/'cases.json']},
              'model_parity':model_checks,'tolerances':tolerances,'repeats':reports,
              'baseline_disabled_contacts':summary(nr),'baseline_negative_passed':baseline_negative,
              'cases':cases,'parity_passed':bool(parity),
              'passed':bool(parity and baseline_negative and all(c['passed'] for c in cases.values()))}
    (HERE/'comparison.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':report['passed'],'parity':parity,'delta':reports[0]['delta'],
                     'cases':{name:{'passed':r['passed'],'error':r.get('error')} for name,r in cases.items()}},indent=2))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
