# Supported-joint execution evidence

These are actual local OI controller runs, not synthetic route playback or physical
measurements. Implementation source is pinned inside every trace; the final fixture
runs use commit `dfa36c6` (the implementation plus a reproducible initial-pose pin).

- `results.json`: three successful configurations, fixture/model/code hashes,
  run/state IDs, independent checks, operation receipts and trace hashes.
- `fastening-{a,b,c}-trace.json.gz`: complete authoritative snapshots for each run.
- `browser-trace.json.gz` and `browser-checks.json`: actual OI UI command, partial
  Stop, reload, Resume, verified completion and read-only replay.
- `partial.png` and `complete.png`: screenshots from that browser run. They are
  not substitutes for the human-recorded end-to-end video.
- `SHA256SUMS.json`: hashes of evidence payloads.

Validated locally: 24 Python tests (including actual HTTP/auth and persistence),
production TypeScript/Vite build, cabinet scene serialization, the new joint browser
path, and both original cabinet browser fixtures. After pinning the initial pose,
all three target-derived fixture runs and the joint browser test passed again.
The only browser-environment adjustment was selecting the already installed Chromium
headless-shell executable using `ASTRA_CHROME_PATH`; no application behavior changed.

Reproduce using [the joint guide](../../cabinet-joint.md). The CI workflow repeats
controller/browser checks and uploads freshly generated evidence. Remote CI has not
been run for this local branch yet.

All panels are manually staged in declared ideal clamps; the spindle adapter,
loads and pitch/depth progression are simulation assumptions. Required state checks
pass, but full-link collision, contact/thread physics, measured torque, physical
adapter/hardware validation, complete-cabinet assembly and human video remain outside
this evidence. `physical_evidence` and `video` are explicitly null in the manifest.
