"""Real-physics lifecycle, sandbox fault and native/WASM parity regressions."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import tempfile

import numpy as np
import pytest

from live_runtime import LiveRuntime, make_cell
from wasm_policy import NativePolicy, WasmPolicy, WAT

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT/'benchmarks/live-runtime/gate'
SO = ROOT/'benchmarks/native-render/so101/json'


def finish(runtime: LiveRuntime, steps: int = 10000) -> dict:
    """Run unpaced through actual MuJoCo until completion or fault."""
    runtime.start()
    for _ in range(steps):
        runtime.tick()
        if runtime.state != 'running':
            break
    return runtime.assessment.report()


@pytest.mark.parametrize('folder', [GATE, SO, SO/'five-cans', SO/'block-transfer'])
def test_backend_physical_parity(folder: Path) -> None:
    """Both policies must achieve the independently measured physical task outcome."""
    results = []
    for backend in ('native', 'wasm'):
        r = LiveRuntime(folder, backend)
        try:
            assert finish(r)['success'], r.snapshot()
            results.append((r.cell.d.qpos.copy(), r.cell.d.time, r.cell.events.copy()))
        finally:
            r.dispose()
    np.testing.assert_allclose(results[0][0], results[1][0], atol=1e-8, rtol=0)
    assert results[0][1:] == results[1][1:]


def test_lifecycle_and_read_only_observation() -> None:
    """Pause, step, resume, reset, stop and dispose have explicit temporal semantics."""
    r = LiveRuntime(GATE)
    initial = r.snapshot()['qpos']
    r.step()
    assert r.state == 'paused' and r.cell.d.time == r.cell.m.opt.timestep
    before = r.snapshot()
    for _ in range(5):
        r.pump(100); r.tick()
        assert r.snapshot() == before
    r.start(); r.tick(); r.pause()
    assert r.cell.d.time == 2*r.cell.m.opt.timestep
    r.stop()
    with pytest.raises(ValueError): r.start()
    r.reset()
    assert r.cell.d.time == 0 and r.snapshot()['qpos'] == initial
    assert not r.pending and not r.cell.overrides
    r.dispose(); r.dispose()
    assert r.cell is None and r.policy is None
    with pytest.raises(RuntimeError): r.reset()


def test_commands_are_bounded_and_applied_fifo_at_tick() -> None:
    """Commands cannot mutate physics asynchronously or bypass actuator limits."""
    r = LiveRuntime(GATE)
    try:
        for name, value in [('absent', 0), ('gate-motor', float('nan')), ('gate-motor', 99), ('gate-motor', True)]:
            with pytest.raises(ValueError): r.actuator(name, value)
        r.actuator('gate-motor', -.2); r.actuator('gate-motor', -.3)
        assert not r.cell.overrides
        r.step()
        assert r.cell.d.ctrl[0] == -.3 and len(r.latencies) == 2
        r.actuator('gate-motor', None); r.step()
        assert not r.cell.overrides
    finally:
        r.dispose()


def test_overload_preserves_timestep_and_bounds_catchup() -> None:
    """Wall debt is reported explicitly, never converted into a larger physics step."""
    r = LiveRuntime(GATE, max_catchup=3)
    try:
        r.start(); r.pump(0)
        assert r.pump(1) == 3
        assert r.cell.m.opt.timestep == .002 and r.cell.d.time == .006
        assert r.overloads == 1 and r.discarded_wall_seconds > .9
    finally:
        r.dispose()


@pytest.mark.parametrize('prefix', ['unreachable', '(loop $spin br $spin)'])
def test_guest_trap_and_fuel_exhaustion_fault_runtime(prefix: str) -> None:
    """Guest failures terminate the task instead of hanging or advancing physics."""
    module = WAT.replace('  local.get $x\n', f'  {prefix}\n  local.get $x\n', 1)
    r = LiveRuntime(GATE, policy_factory=lambda: WasmPolicy(module, fuel=1000))
    try:
        r.start(); r.tick()
        assert r.state == 'fault' and r.cell.d.time == 0
        assert not r.assessment.report()['success']
    finally:
        r.dispose()


def test_guest_invalid_command_and_memory_cap() -> None:
    """Nonfinite output and oversized guest memory cannot reach the physics engine."""
    module = WAT.replace('f64.min f64.add)', 'f64.min f64.add drop f64.const nan)')
    r = LiveRuntime(GATE, policy_factory=lambda: WasmPolicy(module))
    try:
        r.start(); r.tick()
        assert r.state == 'fault' and r.cell.d.time == 0
    finally:
        r.dispose()
    with pytest.raises(Exception): WasmPolicy(WAT.replace('(module', '(module (memory 2)', 1))
    with pytest.raises(ValueError, match='import'): WasmPolicy(WAT.replace('(module', '(module (import "host" "escape" (func))', 1))


def test_unknown_capability_and_missing_reference(tmp_path: Path) -> None:
    """Configuration errors are rejected before the live clock starts."""
    shutil.copytree(GATE, tmp_path/'gate')
    p = tmp_path/'gate/task.json'; task = json.loads(p.read_text())
    task['bindings'][0]['joint'] = 'missing'; p.write_text(json.dumps(task))
    with pytest.raises(KeyError): make_cell(p.parent)
    task['schema'] = 'oi.unimplemented'; p.write_text(json.dumps(task))
    with pytest.raises(ValueError, match='Unsupported'): make_cell(p.parent)


def test_disabled_finger_contacts_cannot_succeed() -> None:
    """Independent assessment refuses success when fingers cannot physically grasp."""
    r = LiveRuntime(SO)
    try:
        for name in r.cell.task['success']['fingerGeoms']:
            geom = r.cell.m.geom(name).id
            r.cell.m.geom_contype[geom] = 0; r.cell.m.geom_conaffinity[geom] = 0
        assert not finish(r)['success']
        assert r.state == 'fault'
    finally:
        r.dispose()


def test_transition_abi_boundaries() -> None:
    """Native and guest predicates agree at dwell/retry/timeout boundaries."""
    native, wasm = NativePolicy(), WasmPolicy()
    try:
        for elapsed in (0., 1., 1.001, 2., 3., 3.001):
            for reached in (False, True):
                for check in (False, True):
                    args = (elapsed, 1., 3., 2., True, reached, check)
                    assert native.transition(*args) == wasm.transition(*args)
    finally:
        wasm.close()


def test_background_clock_pause_and_disposal() -> None:
    """Physics runs without rendering/polling and worker resources terminate cleanly."""
    import time
    r = LiveRuntime(GATE)
    try:
        r.start(); r.start_worker()
        deadline = time.monotonic()+2
        while r.snapshot()['steps'] < 10 and time.monotonic() < deadline:
            time.sleep(.01)
        assert r.snapshot()['steps'] >= 10
        r.pause(); before = r.snapshot()['time']; time.sleep(.03)
        assert r.snapshot()['time'] == before
        r.step(); assert r.snapshot()['time'] == pytest.approx(before+.002)
        r.reset(); assert r.snapshot()['time'] == 0
        r.start(); time.sleep(.03)
        assert r.snapshot()['time'] > 0
    finally:
        r.dispose()
    assert r.worker is None


def test_original_json_executor_parity() -> None:
    """The new guest preserves the original JSON fixture's numerical trajectory."""
    from json_workcell import JsonCell
    from native_trajectory import record_trial
    baseline = JsonCell(SO/'workcell.json', SO/'robot-adapter.json', SO/'task.json')
    _, _, report = record_trial(baseline, baseline.task)
    r = LiveRuntime(SO)
    try:
        assert report['success'] and finish(r)['success']
        np.testing.assert_allclose(baseline.d.qpos, r.cell.d.qpos, atol=1e-8, rtol=0)
        assert baseline.events == r.cell.events
    finally:
        r.dispose()


def test_batched_actuator_abi_bounds() -> None:
    """The maximum batch matches native math and cannot overrun its fixed memory slots."""
    native, wasm = NativePolicy(), WasmPolicy()
    try:
        current = [0.1]*256; targets = [-0.5]*128+[0.7]*128
        assert wasm.slew_many(current, targets, .01) == native.slew_many(current, targets, .01)
        with pytest.raises(ValueError): wasm.slew_many(current+[0.], targets+[0.], .01)
    finally:
        wasm.close()
