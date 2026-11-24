"""JSON controller validation failures must be explicit before physics starts."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from json_workcell import JsonCell, compile_workcell

CONFIG = Path(__file__).resolve().parents[2] / 'benchmarks/native-render/so101/json'


def config_copy(tmp_path: Path, file: str, pointer: list[str | int], value: Any) -> Path:
    """Copy a config set and replace one selected value without modifying the fixture."""
    for name in ('workcell.json', 'robot-adapter.json', 'task.json'):
        doc = json.loads((CONFIG/name).read_text())
        if name == 'workcell.json':
            robot = doc['robot']
            robot['file'] = str((CONFIG/robot['file']).resolve())
            robot['meshDirectory'] = str((CONFIG/robot['meshDirectory']).resolve())
        if name == file:
            target = doc
            for key in pointer[:-1]:
                target = target[key]
            target[pointer[-1]] = value
        (tmp_path/name).write_text(json.dumps(doc))
    return tmp_path


@pytest.mark.parametrize(('pointer','value','message'), [
    (['initial','arm'], [20, -1, 1, 0, 0], 'joint limits'),
    (['control','maxJointStep'], -1, 'positive'),
    (['phases', 0, 'check'], 'pretend_grasp', 'Unknown phase check'),
    (['phases', 1, 'id'], 'approach', 'duplicate phase'),
    (['gripperCommands','open'], True, 'Gripper command'),
])
def test_invalid_task_rejected(tmp_path: Path, pointer: list[str | int], value: Any, message: str) -> None:
    """Reject invalid initial state, controller settings and unsupported phase predicates."""
    directory = config_copy(tmp_path, 'task.json', pointer, value)
    with pytest.raises(ValueError, match=message):
        JsonCell(directory/'workcell.json', directory/'robot-adapter.json', directory/'task.json')


def test_source_hash_rejected(tmp_path: Path) -> None:
    """A scene cannot silently load a different upstream robot revision."""
    directory = config_copy(tmp_path, 'workcell.json', ['robot','sha256'], 'wrong')
    with pytest.raises(ValueError, match='hash mismatch'):
        compile_workcell(directory/'workcell.json', directory/'robot-adapter.json')


def test_adapter_reference_rejected(tmp_path: Path) -> None:
    """Robot-specific alterations must resolve their declared targets exactly."""
    directory = config_copy(tmp_path, 'robot-adapter.json', ['append',0,'selector','name'], 'absent')
    with pytest.raises(ValueError, match='selector must resolve'):
        compile_workcell(directory/'workcell.json', directory/'robot-adapter.json')
