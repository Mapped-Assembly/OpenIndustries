# CABINET-01 fixtures in the local OI workbench

Issue #73 integrates the cabinet into OI's existing SO-101 authority and viewer.
It provides inspection, bounded position-only approach, preflight refusals and
recorded state replay. The original `joint` and `packaged` fixtures do **not** execute assembly.
The separate [supported-joint fixtures](cabinet-joint.md) implement #74 with an
explicit simulated spindle adapter and manually clamped panels. Unpacking (#75)
and grasp/contact (#54) remain outside these fixtures.

## Start locally (Linux / WSL2)

Use the [embodied setup](embodied-chat.md#local-setup-linux--wsl2) to install the
pinned Python dependencies, build OI, and obtain the verified SO-ARM100 assets.
No model key, GMI account, AWS or cloud persistence is required.

```bash
# From the OI checkout, after the documented setup:
.venv-embodied/bin/python scripts/embodied_runtime.py \
  --source ../SO-ARM100 --cabinet-fixture joint \
  --state-dir "$HOME/.local/share/open-industries/cabinet-joint"
```

Open `http://127.0.0.1:4197/?run=so101`. Select **base panel**, enter Run mode,
and submit `approach selected`. The controller solves a TCP position 100 mm
above the panel and records the motion; the panel stays stationary.
`inspect selected` and `home` use the same registered controller/policy path.
Use **Check lift requirements** to inspect load/capability blockers without
dispatching a motion command. Stop, Resume and reconnect retain existing semantics.

For the complete package, stop the first launcher and run:

```bash
.venv-embodied/bin/python scripts/embodied_runtime.py \
  --source ../SO-ARM100 --cabinet-fixture packaged \
  --state-dir "$HOME/.local/share/open-industries/cabinet-packaged"
```

Select **box lid** for a reachable approach target. Approaching a panel beneath
the sealed lid is blocked with `PACKAGE_ACCESS_BLOCKED`. **Reveal contents**
only hides packaging in the viewer; it does not open the box or enable access.
Restart with the same fixture and directory. A changed fixture hash or using
a different fixture with an existing station is rejected; it never replaces a run.
Pinned cabinet fixtures cannot be changed using the tabletop object editor.

## Fixture and machine contract

The signature stays `assemble_cabinet(S, CabinetComponents, A, M) -> AssemblyResult`.
This issue supplies its inputs and state integration, not a completed assembly skill.

| Fixture | Contents | Interpretation |
| --- | --- | --- |
| `joint` | 80 × 50 × 6 mm base, 60 × 50 × 6 mm upright, one M3 screw, support and parked screwdriver | Separate SO-101 test coupon. Authored staged state; support and grasp strength unverified. |
| `packaged` | Original five printed panel envelopes, twelve M3 screw envelopes, cardboard box, separators, carrier, seal, support and parked screwdriver | Source dimensions retained; package translated in Y by −0.27 m. Full assembly reach is unverified. |

`benchmarks/cabinet/source` contains the owner-provided synthetic design's geometry,
task contract, initial state and SHA-256 source lock. It is available in the repository;
no owner-only file link is required. `build_fixtures.py` reproducibly derives the two
JSON fixtures, including stable inventory IDs, target poses, eight full-kit joints,
screw-to-hole mappings, geometry hashes, packaging access order and tolerances.
The full target assembly translation and the independent coupon dimensions are
recorded as adaptations. They are not proof of machine feasibility.

The shapes are centre-origin **box envelopes**, including simplified screw/tool
shapes. No fabrication-ready holes, threads, inserts, supplier dieline or validated
grasp geometry are claimed. Grasp-boss dimensions/offsets are metadata; the source
does not establish printable strength or a physical machine interface. Optional
brackets are not required by this version's target graph.

Generated primitives use the `oi-fixture` provenance label. Portable scene/asset
serialization preserves each component contract and a complete fixture manifest
on the first component, including inventory, units, target assembly and connections.
That static scene export remains an inspection view; importing geometry never
installs executable manipulation capabilities.

M is the existing pinned SO-101 follower, not the preview's generic XYZ gantry.
It uses the same controller, six revolute joint coordinates, source joint limits,
link transforms, TCP, model hash and upstream visual meshes. The source lock pins
the URDF containing collision elements; only sampled TCP-versus-oriented-envelope
and tabletop checks are executed here. Full-link collision/contact checks are absent.
The gripper coordinate is radians, not jaw aperture or a calibrated hardware servo
command. The screwdriver is parked geometry with no mount adapter or spindle
actuator; inventing an extra executable actuator would misrepresent M.

Each printed part retains material/profile, shell/infill, mass and centre-of-mass
fields. Unknown values, tool mass, payload, wrist moment and grip limits remain
null. Unsupported manipulation always blocks; missing ratings additionally report
`UNKNOWN_LOAD_LIMIT`, and a declared excess reports `PAYLOAD_EXCEEDED`. Declared
simulation inputs must never be presented as measurements. Reachable approach
targets do not establish lifting, tool access for fastening, or assembly feasibility.

## State, persistence and replay

The existing Python worker and SQLite station remain the sole state authority.
Fixture IDs, hashes, inventory and connection specification persist through the
station's fixture pin. A cabinet frame and its command receipt/checkpoint commit
in the same SQLite transaction. Snapshots include component poses/connections,
machine base/link/TCP matrices, all six actuators, their simulated positions and
separate command targets, plus observation IDs and step results. Telemetry that
was not measured stays null. SI units, Z-up `base_link`, XYZW quaternions and
wall-clock timestamps are explicit. Authored stationary components are distinguished
from controller-produced simulated kinematics; physical feasibility stays unknown.

**Inspect recorded states** reads `/api/embodied/trace` and displays the same state
IDs, robot transforms and object poses used by live viewing. Replay disables
command controls and does not advance the authority. The replay button is disabled
while work is active, keeping live Stop available during motion. Export trace
downloads the fixture/machine manifest, snapshots, receipts and initial/latest
state IDs. A snapshot is not proof that assembly was performed.

Retention is explicitly bounded: retain S_i and the latest 511 revisions. Longer
runs export `complete: false` with the surviving revision IDs, and the UI announces
the gap. No missing trajectory is synthesized. Export's final state means the
latest recorded state at capture, which may be partial or nonterminal. Full-run
streaming/media retention belongs to #15; this fixture does not claim an MP4 export.
Backend rendering remains #67. Replay/media must never dispatch controller actions.

## Verification and handoff

```bash
python3 benchmarks/cabinet/build_fixtures.py
PYTHONPATH=services/embodied .venv-embodied/bin/python \
  -m unittest discover -s services/embodied/tests -v
npm run build
npm run test:cabinet-scene
npx playwright install chromium ffmpeg
SO101_SOURCE_ROOT="$PWD/../SO-ARM100" PYTHON=.venv-embodied/bin/python \
  npm run test:cabinet-browser
```

Python checks cover reproducible source geometry, invalid hashes/references,
required approach targets, blocked access/load/frame/revision conditions, actual
controller approach, Stop/resume, restart, state/actuator consistency, fixture-pin
rejection and explicit trace retention gaps. Browser checks exercise both fixtures
through the actual built OI page, with load preflight, package access refusal,
controller motion, reload, read-only replay, transformed geometry and trace download.
Evidence is written to `deliverables/cabinet` and uploaded by the existing field-lab
CI job. Default tabletop controller/browser checks remain regression coverage.

For the eventual #71 video, the human owner records and sends the implemented
end-to-end run after #74/#75 are delivered. A recording of this integration should
be labeled **fixture inspection and bounded approach only**.
