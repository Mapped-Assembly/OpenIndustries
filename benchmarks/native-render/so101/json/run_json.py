"""Run the JSON-defined workcell/task without importing the baseline scene builder."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

import pygfx as gfx

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tools/geospatial'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fetch_assets import main as fetch_assets
from json_workcell import JsonCell, keys, load
from native_mujoco_scene import project_model
from native_trajectory import record_trial, RecordedReplay
from native_render import render_gif


def run(config: Path, output: Path, verify_only: bool = False) -> dict[str, Any]:
    """Compile four explicit configs, assess the run, and optionally render its physics."""
    cell = JsonCell(config/'workcell.json', config/'robot-adapter.json', config/'task.json')
    times, states, report = record_trial(cell, cell.task)
    report['configuration_sha256'] = {name: hashlib.sha256((config/name).read_bytes()).hexdigest()
                                       for name in ('workcell.json','robot-adapter.json','task.json','render.json')}
    if not report['success']:
        raise RuntimeError(f'JSON task failed: {report["phase"]}: {report["error"]}')
    if not verify_only:
        view = load(config/'render.json', 'oi.native-view')
        keys(view, {'schema','version','width','height','fps','azimuth','elevation','loop','room','roomGuides','exclude','frame'})
        if view['frame'] != 'non-world-bodies':
            raise ValueError('Unsupported framing policy')
        doc, bindings = project_model(cell.m, set(view['exclude']), view['room'])
        def factory(scene: gfx.Scene) -> RecordedReplay:
            """Bind the JSON-run trajectory to native graphics."""
            return RecordedReplay(scene, bindings, times, states, report)
        encoded = render_gif(doc, output, width=view['width'], height=view['height'], fps=view['fps'],
                             duration=times[-1], motion='physics', physics_factory=factory,
                             room_guides=view['roomGuides'], azimuth=view['azimuth'], elevation=view['elevation'],
                             loop=view['loop'], frame_instances={b['instanceId'] for b in bindings if b['body'] != 0})
        report['gif'] = {key: value for key, value in encoded.items() if key != 'physics'}
        report['gif_sha256'] = hashlib.sha256(output.read_bytes()).hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.with_suffix('.render.json').write_text(json.dumps(report, indent=2)+'\n')
    return report


def main() -> None:
    """Run JSON configuration supplied by path, with no scene-specific runtime defaults."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('json-pick-and-place.gif'))
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    fetch_assets()
    report = run(args.config, args.output, args.verify_only)
    print(json.dumps({key: report[key] for key in ('success','duration_seconds','maximum_object_height_m','final_object_position_m')}, indent=2))


if __name__ == '__main__':
    main()
