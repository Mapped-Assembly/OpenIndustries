# Standalone live runtime (issue #114)

The live runtime loads the existing JSON workcells and runs physics continuously.
It does not start Chromium, Electron, a web server or a browser. `--view window`
uses a native GLFW window; `--view offscreen` renders the evolving physics state
without a display. GIF recording captures those live frames, not a separately
simulated replay.

## Install and run

```bash
pip install -e '.[physics,native-render,live]'
python benchmarks/native-render/so101/fetch_assets.py

oi-live benchmarks/native-render/so101/json --view window --backend wasm
# Independent mechanism: open, hold and close a motorized gate.
oi-live benchmarks/live-runtime/gate --view window --backend wasm
# Browser-free headless execution and an evidence report.
oi-live benchmarks/native-render/so101/json/five-cans --report five-cans-live.json
# Same runtime, different geometry/task configuration.
oi-live benchmarks/native-render/so101/json/block-transfer --backend native
# Live offscreen capture; requires a Vulkan-capable native graphics driver.
oi-live benchmarks/live-runtime/gate --view offscreen --gif gate-live.gif
```

Space pauses/resumes; N advances exactly one physics step while paused; R resets
and leaves the world ready; Escape stops/closes. Terminal runs close the window
and write the report. `--max-wall` bounds an unattended run (default 120 seconds,
including pauses). The headless CLI exits nonzero on a fault or an unverified
physical outcome. The Python API exposes `start`, `pause`, `step`, `reset`, `stop`,
`dispose`, read-only `snapshot`, and `actuator(name, value)`; `None` releases an
override. `start_worker` owns the clock independently of rendering/polling.

For a slower actuator update rate, use `--control-every N`. Physics still uses the
model's unchanged timestep; phase predicates are assessed on physics ticks. The
fixture's `maxJointStep` is per control update, so changing N changes behavior and
must be evaluated rather than assumed equivalent. Default N=1 retains the
benchmark's 500 Hz control/physics cadence. Rendering defaults to 30 Hz and can
be changed using `--fps`.

## Architecture decision: WASM policy ABI v1

| Responsibility | Implementation |
| --- | --- |
| Actuator slew / rate limiting | WASM guest, or equivalent Python reference |
| Phase dwell, reach gating, retry and timeout decisions | WASM guest, or equivalent Python reference |
| JSON validation, task references, current phase state | Python host/capability adapter |
| IK, measured contacts and physical predicates | Native MuJoCo with Python adapter |
| Physics, actuator forces and integration | Native MuJoCo |
| Scheduling, command ordering, lifecycle, faults | Python host |
| Display and user input | Native pygfx/wgpu and GLFW |

The guest executes actuator update math and phase transition decisions through
exported WASM functions. This is a **policy backend**; Python continues to own
task state and native MuJoCo supplies physics. The native reference implements
the same policy ABI for direct command and outcome comparisons.

`wasm_policy.py` contains the auditable WAT module; Wasmtime compiles it locally.
No compiler toolchain or opaque checked-in binary is required. Guest exports:

- `slew(f64 current, f64 target, f64 max_delta) -> f64 command`
- `transition(f64 elapsed, f64 minimum, f64 timeout, f64 retry,
  i32 require_reached, i32 reached, i32 predicate_passed) -> i32 decision`
- Decision codes: 0 wait, 1 advance, -1 predicate fault, -2 timeout.
- `slew_many(i32 count, f64 max_delta)` processes up to 256 actuator targets.
  The guest exports one 64 KiB memory. Current f64 values start at byte 0,
  targets at byte 2048, and output commands at byte 4096 (little endian).

Arguments/results are copied scalars or bounded vectors, with no shared host
arrays, model pointers or ownership transfer. The batch call copies inputs into
guest-owned memory and copies outputs back once per control tick. ABI signatures, output finiteness, command
increments and actuator ranges are validated by the host. Version 1 allows no imports, WASI,
network, filesystem, clock access or host callbacks. Modules are limited to
256 KiB input, one store instance and at most one 64 KiB linear memory; tables
are prohibited. Each call has a replenished 10,000-unit Wasmtime fuel budget.
Traps, fuel exhaustion and invalid output become observable runtime faults.
JSON/model files are trusted host inputs loaded through the explicitly supplied
scenario path; the WASM sandbox does not make arbitrary asset paths safe.

### Why MuJoCo remains native

The working reference and fixtures use native MuJoCo 4.0.1. Browser MuJoCo builds
use browser/JavaScript integration (see the upstream [WASM build README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md) and [Emscripten build selection](https://github.com/google-deepmind/mujoco/blob/main/CMakeLists.txt)); they are not assumed compatible with a
no-import Wasmtime host. Moving physics itself into WASM would require a separate
standalone build, an asset/model-loading ABI, memory sizing and numerical and
performance comparisons. This implementation chooses native physics rather than
claiming an untested browser binary can be loaded directly. Full MuJoCo-in-WASM
is not implemented; the standalone controller path is.

## Host scheduling and safety semantics

A physics owner thread uses a monotonic clock. The renderer obtains copied pose
arrays under a session lock and renders outside that lock. Reads never step the
world. Commands are validated when submitted and applied FIFO at the next tick
boundary. Overrides persist until released/reset and may make a task fail; they
do not alter the task's success criteria. The queue is bounded to 1,024 commands.

At most eight overdue physics steps run per pump. Excess wall-clock debt is
counted as overload and discarded from the scheduling deadline, not compensated
with a larger simulation timestep. This means simulation visibly slows under
sustained overload. Pause/resume discards paused wall time. Reset rebuilds the
world and guest, clears pending commands and overrides, and restores initial
state. Dispose joins the worker and closes the guest store.

This is soft real-time execution, not a hard real-time controller for hardware.
Python scheduling, IK and rendering can miss deadlines; the report exposes those
misses. Rendering FPS alone is not proof that physics kept up.

## Capabilities and schema boundaries

`oi.pick-place-task` uses the existing validated JSON task and robot adapter.
`oi.joint-task` adds a reusable scalar hinge/slide actuator sequence: bindings,
phase target arrays, dwell, timeout, position tolerance and speed tolerance.
The gate fixture is configuration, not a gate-specific branch in host code.
Unknown task schemas, unresolved bindings and unsupported joint types fail before
starting. This does not introduce arbitrary planning or support every physical
operation. Existing `astra.scene` remains the presentation format; no schema was
silently replaced.

Five cans still means one configured transfer with four other simulated cans.
The three SO-101 fixtures preserve their previous acceptance criteria. The
independent assessment reports contact history, maximum height, destination
support, containment, settled velocity and remaining finger contact. In particular,
the original can fixtures can pass their existing placement criterion while still
touching one finger; `no_finger_contact` makes that limitation explicit. The block
fixture may differ. A future requirement for complete contact separation needs a
separate task/benchmark change, not silently relaxed or rewritten evidence.

## Verification and reproducibility

```bash
python -m pytest tools/geospatial/test_live_runtime.py tools/geospatial/test_json_workcell.py -q
python benchmarks/live-runtime/compare.py --repeats 3
# Throughput comparison, explicitly unpaced:
python benchmarks/live-runtime/compare.py --fast --output /tmp/throughput.json
```

Each benchmark trial runs in a fresh process. The comparison requires physical
success, identical sample times and phase events, and maximum qpos difference
<=1e-8 across both backends. This stricter numerical parity test supplements the
preserved physical tolerances from the existing fixture. Tests cover the original
JSON executor, lifecycle, a background clock, invalid commands/references,
unsupported capability, guest trap/fuel/memory faults, lost contacts and overload.

Reports include JSON hashes, dependency versions, hardware/OS, compilation/load
and renderer warmup separately, simulation/wall ratio, tick latency percentiles,
control-update ticks (including their physics work), missed compute deadlines,
accepted-command enqueue-to-observation latency, CPU and process high-water RSS, frame count/FPS,
physical outcomes and trajectory samples. RSS is process-wide and includes startup;
it is null where unavailable. Timing arrays and trajectories are bounded.
`--probe-commands` measures harmless override-release commands at 10 Hz in CLI
headless/offscreen runs. No probe changes actuator targets.

The frame counter measures completed CPU render submissions/readbacks; it is not
an independent display-scanout measurement. Recorded GIF delays follow simulation
time, so inspect the report's simulation/wall ratio to assess real-time pacing.

The native-window smoke check additionally requires changing live frames, so a
successful physics run with a frozen window cannot pass:

```bash
xvfb-run -a python benchmarks/live-runtime/window_smoke.py
```

On a desktop, omit `xvfb-run -a`. This smoke check establishes window operation,
not the 30 FPS performance target.
