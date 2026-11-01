# CABINET-01: supported two-panel, one-screw joint

`assemble_cabinet(S, CabinetComponents, A, M) -> AssemblyResult`

This is **Milestone A / #74**, not a complete cabinet or a physical trial. One
`assemble corner` chat command runs inspect → align tool → fasten → independently
verify through the existing Python worker, SQLite task/checkpoint authority and
OI workbench. It requires no model credentials or cloud account.

## Reproduce locally (Linux / WSL2)

Install the pinned dependencies, upstream robot assets and build the UI using
[the embodied setup](embodied-chat.md#local-setup-linux--wsl2). Then run:

```bash
.venv-embodied/bin/python scripts/embodied_runtime.py \
  --source ../SO-ARM100 --cabinet-fixture fastening-a \
  --state-dir "$HOME/.local/share/open-industries/cabinet-fastening-a"
```

Open `http://127.0.0.1:4197/?run=so101`, click **Enter Run mode**, and send
**`assemble corner`**. Selection is unnecessary: the command identifies the single
registered `corner` connection. The visible arm, mounted driver, rotating/inserting
screw, actuator table and connection status all project authoritative snapshots.
An LLM cannot supply poses or assert success. `inspect selected` remains available;
other arm motions are blocked in this mounted-tool fixture.

For an unattended reproducible integration run of all three configurations:

```bash
.venv-embodied/bin/python benchmarks/cabinet/run_joint.py
```

This writes `deliverables/cabinet-joint/results.json` and three complete compressed
JSON traces. The command uses the same request schema and worker as HTTP, with a
fresh temporary SQLite station per episode. Run IDs and timing vary; source,
fixture and model hashes identify the inputs. Failed/partial runs are not counted
as successful realizations. The integration tests also exercise blocked outcomes.

## Inputs and manual setup

| Input | Concrete binding |
| --- | --- |
| S | `base_link`, metres/radians, Z-up, rigid pedestal and ideal corner clamps; fixed arm base |
| CabinetComponents | Pinned #73 coupon: `base_panel`, `upright_panel`, `screw_1`; connection `corner`, hole `corner_hole` |
| A | `cabinet-agent`, deterministic registered procedure; zero automatic recovery attempts, 45 active simulation seconds |
| M | Pinned SO-101 model and existing `so101-kinematic-v1` controller, plus explicit **simulated** TCP spindle adapter v1 |

Before execution both printed panels are manually placed at their target corner
poses and clamped. The M3 screw is manually prepositioned with its tip at the hole
entrance, zero insertion; its 20 mm length points along +X. The screwdriver is
manually mounted and the arm initialized at the declared pose. No unsupported
panel is held by a gripper while fastening. No pick/place, automatic feeding,
tool changing, unpacking or contact-based manipulation is claimed.

The fixtures derive from `joint.json`, retaining its source and geometry identities,
and record the parent fixture digest. The coupon is raised onto a pedestal and
clamps explicitly support both panels. The arm base and initial arm coordinates
are identical across the three configurations:

| Fixture | Hole centre (m) | Inward axis | Target depth |
| --- | --- | --- | --- |
| `fastening-a` | (0.30, 0, 0.18) | +X | 0.006 m |
| `fastening-b` | (0.32, 0, 0.20) | +X | 0.006 m |
| `fastening-c` | (0.34, 0, 0.22) | +X | 0.006 m |

`build_joint_fixtures.py` generates these versioned inputs. Paths are solved from
the current TCP, hole, screw depth and axis; no edited waypoint routes are stored
in fixtures. Every path uses the pinned joint bounds and tool-position/axis IK.
Sampled tool/bit envelopes are checked against panel and support envelopes and the
table. Full-arm collision, dynamics and thread contact remain unvalidated.

The simulated adapter replaces the moving jaw in the viewer; its tip is at the
pinned TCP, spindle local +Z is the insertion axis and the tool envelope extends
90 mm behind the tip. This is an explicit model extension, **not an existing or
validated SO-101 hardware attachment**. The independent spindle adds an unwrapped
radian actuator. Declared simulation inputs are 35 g tool mass, 25 g per panel,
150 g arm payload, 0.15 N·m wrist moment and 200 g clamp capacity. These are not
measurements or manufacturer ratings. Physical adapter/calibration, measured
forces, torque, current, energy and hardware feasibility remain unknown.

## Operations and independent checks

The typed `JointOperation` contract carries operation/command IDs, machine/tool
binding, component and hole IDs, SI parameters, scene revision, dependencies,
preconditions, expected postconditions, deadline, cancellation semantics and
actual trace intervals. Each accepted controller operation records a receipt;
acceptance and completion revisions are separate. The supported operation order is:

1. **Inspect:** confirm inventory, mapping, staged panel poses, support and loads.
2. **Align:** solve and execute the tool-head position and axis target.
3. **Fasten:** advance absolute insertion depth and unwrapped spindle angle at a
   bounded modeled feed rate (1.5 mm/s, 0.5 mm pitch). Only accepted controller
   steps can mutate screw pose, insertion and connection state.
4. **Verify:** independently read authoritative component/tool/actuator state and
   compare it with the pinned specification. Narration, planned poses and task
   success labels are not inputs to the evaluator.

Required checks include panel poses (3 mm / 0.035 rad), screw identity and hole,
clamps and declared loads, mounted-tool pose, TCP/head alignment (0.75 mm /
0.015 rad), insertion/spindle coherence, 6 mm depth (0.05 mm tolerance), and
connected/installed state. Every required check must be `pass`; `unknown` blocks.
The modeled connection becomes connected only at full insertion, and verified
only after the independent evaluator passes. Completion is labeled
`succeeded_simulated_joint`; the real execution set remains unestablished.

Missing screw, bad hole, misalignment, unavailable support, inaccessible or
unreachable tool targets and unknown required loads produce bounded `blocked`
outcomes. A lost precondition during execution stops with `failed` and retains
the last valid partial checkpoint. No automatic speculative recovery is attempted.

## Stop, cancellation, retries and recovery

**Stop** is handled directly under the runtime lock and does not invoke or wait
for model inference. It pauses the worker and retains arm coordinates, tool/screw
poses, insertion, spindle angle, operation cursor and receipts. **Resume** observes
again and validates support, load, tool binding and insertion coherence before
continuing the same operation. Cancellation retains partial work with an explicit
`cancelled` result; a new task resolves its remaining depth from that state.

The existing request UUID receipts make retries of an uncertain acknowledgement
idempotent. State, receipts and frame projection share the existing SQLite
transaction. Restart pauses the same task; downtime produces no inferred motion.
The simulator is an in-process transactional controller, so there is no external
hardware acknowledgement protocol here. Physical reconciliation is not claimed.
No second scheduler, persistence authority or task queue is introduced for #56.

## Evidence and video handoff

The trace includes S_i, intermediate states and the final/partial state, component
connections, all six original actuators plus spindle position/target, tool poses,
source pins, command receipts, operation-to-revision intervals and independent
checks. Unknown telemetry stays null. Existing retention preserves S_i and the
latest 511 revisions; long histories explicitly report gaps. The bounded fixtures
fit inside this retention. Replay displays the same state IDs and cannot dispatch.

Validation commands:

```bash
python3 benchmarks/cabinet/build_joint_fixtures.py
SO101_SOURCE_ROOT="$PWD/../SO-ARM100" PYTHONPATH=services/embodied \
  .venv-embodied/bin/python -m unittest discover -s services/embodied/tests -v
npm run build
npm run test:cabinet-scene
SO101_SOURCE_ROOT="$PWD/../SO-ARM100" PYTHON=.venv-embodied/bin/python \
  npm run test:cabinet-joint-browser
```

CI runs these with the existing embodied/fixture regressions and uploads traces,
result manifests and browser screenshots. The Python tests cover three reachable
configurations, false/unknown preconditions, unreachable tool access, partial
Stop/resume, changed support before resume, cancellation/new attempts, duplicate
acknowledgements, abrupt process exit and independent rejection of forged success.
The browser test submits the real chat command, stops during insertion, reloads,
resumes, verifies connection state and checks read-only replay.

For the human-recorded end-to-end footage:

1. Start a fresh `fastening-a` state directory. Show the fixture name and staged
   clamps/tool. Label the capture **simplified simulation; manual staging**.
2. Enter Run mode and send `assemble corner` on screen. Keep the robot, screw,
   actuator values and connection status visible.
3. Stop during insertion, show `partial` and the retained unwrapped spindle angle,
   then Resume. Show the independent checks and `succeeded_simulated_joint`.
4. Export the trace. Include its run ID and final state ID with the recording.
5. Optionally replay S_i → S_f with **Inspect recorded states**, visibly labeled
   replay. Replay does not execute the procedure.

The human owner records and sends the video. Capture instructions, screenshots
and simulated traces do not establish that end-to-end footage or a physical trial
exists. Video remains null in the result manifest until that separate handoff.
