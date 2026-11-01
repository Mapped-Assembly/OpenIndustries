# Backend scene rendering through API and MCP

The local render service accepts a portable `astra.scene` document with bundled
geometry, or an explicit revision in a configured local scene store. It produces
a GIF and review JSON without opening the workbench or keeping an OpenCode/MCP
process alive. It uses the same scene validation, transforms, timeline evaluator,
Three.js world and `renderGif` implementation as GIF studio.

## Install and start

Supported baseline: Linux x86-64 and WSL2 Linux, Node **22.16+**, npm and Playwright
Chromium with its system libraries. Native Windows and macOS hosting are not yet
validated by this feature's CI; Windows users can run the service inside WSL2.
No GPU, display server, cloud account, AWS service or model credential is required.
Software WebGL uses Chromium/SwiftShader.

```bash
# From an OpenIndustries checkout; include development dependencies for tsx/Playwright.
npm ci
npx playwright install --with-deps chromium
npm run build:render
npm run render:serve
```

The default origin is `http://127.0.0.1:4198`. Private state is stored in
`$HOME/.local/share/open-industries/render`. The service writes `client.json`
there with its origin and a persistent bearer capability; only the local owner
should read this file. Startup prints the path, never the token.

Run this process in a separate terminal or under a supervisor. MCP **never starts
or owns the worker**, so restarting OpenCode or closing its stdio server cannot
terminate accepted rendering work. Keep the service up for pending work to finish.

For the reproducible **8 × 6 × 3 m room**, including floor/walls/entrance/window:

```bash
export OI_RENDER_CLIENT_FILE="$HOME/.local/share/open-industries/render/client.json"
npm run demo:render
```

The demo writes its portable input to `.astra/backend-render-room.scene.json`,
submits through the same MCP adapter, prints the job ID, then downloads the GIF
and review metadata to `.astra/render-downloads`. The default preset is **640 ×
640, 60 frames, looping turntable**. No manual workbench import/click is involved.

## MCP tools

Set `OI_RENDER_CLIENT_FILE` in the environment of the existing
`server/openindustries-mcp.mjs` entry point (or `OI_ROOT` for a different checkout).
The canonical tools are:

| Tool | Arguments / result |
| --- | --- |
| `openindustries.render_submit` | `request_id`, exactly one of `scene`, `scene_path`, or `saved_scene`, optional `options`; returns a durable job |
| `openindustries.render_status` | `job_id`; returns state, progress, recorded input identity/options and any failure |
| `openindustries.render_cancel` | `job_id`; directly cancels queued/running work; terminal jobs remain unchanged |
| `openindustries.render_download` | `job_id`; verifies/downloads completed GIF + JSON and returns checkout-relative paths and SHA-256 |

`scene_path` is a checkout-relative portable scene JSON file, confined to the
checkout even through symlinks. It is an MCP convenience; the HTTP API takes the
scene document itself. Download never overwrites a different existing file.
Legacy `astra.render_*` aliases are accepted by the existing compatibility entry
point. The renderer capability is read privately and is never included in tool
responses, scene metadata or review exports.

Example MCP arguments (use a fresh lowercase UUID for each new render):

```json
{
  "request_id": "7b4252da-c9fb-4fd8-8fe6-1b3cbd05bd26",
  "scene_path": ".astra/backend-render-room.scene.json",
  "options": {
    "scope": "room", "motion": "turntable",
    "size": 640, "duration": 4, "fps": 15,
    "camera": {"azimuthDegrees":45,"elevationDegrees":35,"distanceScale":1.15,"fovDegrees":40}
  }
}
```

Retry an uncertain submission with the **same request ID and identical inputs**.
It returns the existing job, including terminal/interrupted state. Reusing an ID
for different normalized content returns `REQUEST_ID_REUSED`. A cancelled,
failed or interrupted job requires a new ID for a new attempt.

## HTTP API

All `/v1/render/*` routes require `Authorization: Bearer <capability>`. The
service binds only to loopback, validates Host and rejects cross-origin browser
requests. `/health` exposes only service identity/health. No user-supplied URL,
script or HTML is fetched or executed. Each renderer uses a fresh private page,
blocks external page requests and loads only the packaged render entry point.

| Method/path | Result |
| --- | --- |
| `POST /v1/render/jobs` | Asynchronous `202` with job ID/status; accepts `request_id`, `scene` or `saved_scene`, `options` |
| `GET /v1/render/jobs` | Bounded retained job list |
| `GET /v1/render/jobs/{id}` | Job status/progress/error/settings |
| `POST /v1/render/jobs/{id}/cancel` | Cancel and return the recorded outcome |
| `GET /v1/render/jobs/{id}/media` | Completed `image/gif` attachment |
| `GET /v1/render/jobs/{id}/metadata` | Completed review JSON attachment |
| `DELETE /v1/render/jobs/{id}` | Delete a terminal job and its retained files |

Example using `curl`, `jq` and a portable input file:

```bash
export OI_RENDER_CLIENT_FILE="$HOME/.local/share/open-industries/render/client.json"
RENDER_ORIGIN="$(jq -r .origin "$OI_RENDER_CLIENT_FILE")"
RENDER_TOKEN="$(jq -r .token "$OI_RENDER_CLIENT_FILE")"
RENDER_ID="$(cat /proc/sys/kernel/random/uuid)"
jq -n --arg id "$RENDER_ID" --slurpfile scene room.scene.json \
  '{request_id:$id,scene:$scene[0],options:{scope:"room",motion:"turntable",size:640,duration:4,fps:15}}' \
  > render-request.json
curl --fail-with-body -H "Authorization: Bearer $RENDER_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @render-request.json \
  "$RENDER_ORIGIN/v1/render/jobs"
curl --fail-with-body -H "Authorization: Bearer $RENDER_TOKEN" \
  "$RENDER_ORIGIN/v1/render/jobs/$RENDER_ID"
# After status becomes completed:
curl --fail-with-body -H "Authorization: Bearer $RENDER_TOKEN" \
  "$RENDER_ORIGIN/v1/render/jobs/$RENDER_ID/media" -o room.gif
curl --fail-with-body -H "Authorization: Bearer $RENDER_TOKEN" \
  "$RENDER_ORIGIN/v1/render/jobs/$RENDER_ID/metadata" -o room.review.json
```

For a saved scene, configure the worker with `OI_RENDER_SCENE_DIR` pointing to
an existing OI local scene store, and submit:

```json
{"request_id":"a6c67ad0-9df1-48e8-899b-04c25051df45","saved_scene":{"scene_id":"875f10e2-662e-442c-ae8e-00f3bdb1817d","revision":1}}
```

The worker resolves and copies that exact revision and hash-verified geometry
**before acknowledging acceptance**. It never silently uses a later head.
Cloud references must first be exported to a portable bundled scene; this initial
worker does not inherit cloud credentials or fetch arbitrary remote assets.

## Scope, camera, limits and timing

Room scope contains the floor/boundary and every visible instance. A truly empty
room renders its environment and records `emptyRoom: true`; invisible nonempty
scenes do not silently become empty-room successes. Missing referenced geometry
always fails with `MISSING_GEOMETRY`, even if the missing instance would lie
outside the requested section. Missing-geometry placeholders are never exported.

Section scope uses the existing floor-region clipping (`region` contains centre
`x/z`, `width/depth` in metres). Asset scope selects the zero-based `assetIndex`.
Turntable orbits the camera; sample is the existing synthetic isolated-asset
lift/return preview; animation evaluates the authored timeline using
`rangeStart/rangeEnd`. These renders do not simulate or validate physical work.

Camera settings: azimuth −360…360°, elevation 5…85°, distance multiplier 1…3 and
vertical field of view 20…70°. The target and fit distance are derived from the
same selected world bounds as GIF studio and recorded in review metadata.

| Resource | Bound |
| --- | --- |
| Input / expanded portable scene | 8 MiB |
| Instantiated geometry | 64 instances, 512 parts, 200,000 vertices, 600,000 indices |
| Resolution | 320, 480 or 640 px square |
| Duration / frame rate | 2, 3 or 4 requested seconds; 10 or 15 requested fps |
| Animation span / frames | At most 4 seconds / 60 frames |
| Concurrency | 1 by default; configurable to 2 |
| Active queue, including running jobs | 8 |
| Wall-clock job deadline | 120 seconds, including Chromium startup |
| GIF / retained records | 64 MiB per output / 128 jobs |
| Retention | 7 days from the last terminal transition; explicit delete also supported |

GIF stores delays in centiseconds. At requested 15 fps, each frame lasts 70 ms,
so the 60-frame preset lasts **4.2 seconds**. Metadata distinguishes requested
options from decoded output dimensions, frame count, delay and actual duration.
It also records the canonical normalized scene SHA-256, pinned revision when
applicable, renderer build hash, Chromium version, camera, animation snapshots,
output hash and byte count.

## Lifecycle and headless deployment

SQLite is the single job authority. Each job runs in a disposable child process
with headless Chromium. Only verified complete artifacts are published; partial
files have no download endpoint. Cancellation stops the child without waiting for
inference. If Chromium exits/crashes, the job becomes `failed`; deadline expiry
reports `RENDER_TIMEOUT`. Shutdown/restart marks queued or running jobs
`interrupted` and never silently replays them. Completed artifacts and the private
client capability survive restarts.

One service owns a data directory; another process is refused even on a different
port. Ownership recovery uses the recorded host/PID and SQLite transaction. This
is a single-host service, not a shared-network-filesystem cluster. If an unrelated
process has reused a stale PID, stop and inspect ownership before manually repairing
the store; do not start multiple writers. Keep the complete state directory for
backup, preferably while the service is stopped. Retention/delete removes both
job records and files; after expiry the old request ID no longer has a receipt.

A Linux systemd example is supplied in `deploy/render/oi-render.service`. For an
installation at `/opt/open-industries`, install/build as above, then provision the
service account and its Chromium cache:

```bash
sudo useradd --system --home /var/lib/open-industries-render --shell /usr/sbin/nologin oi-render
sudo mkdir -p /opt/open-industries/.playwright
sudo chown oi-render:oi-render /opt/open-industries/.playwright
sudo -u oi-render env PLAYWRIGHT_BROWSERS_PATH=/opt/open-industries/.playwright \
  /opt/open-industries/node_modules/.bin/playwright install chromium
sudo cp deploy/render/oi-render.service /etc/systemd/system/oi-render.service
sudo systemctl daemon-reload
sudo systemctl enable --now oi-render
sudo journalctl -u oi-render -f
```

The unit keeps state under `/var/lib/open-industries-render`, restarts after
failure, limits memory/tasks and kills its process group on shutdown. MCP clients
need owner-authorized access to its private `client.json`; keep the API local or
access it through an authenticated local forwarding arrangement. The example unit
is supplied, not installed by running the render demo.

`OI_RENDER_CHROMIUM` selects an existing compatible executable. Chromium sandboxing
is enabled by default; environments that cannot provide its sandbox must explicitly
set `OI_RENDER_NO_SANDBOX=1` in their isolated worker environment. The integration
CI uses that setting with generated fixtures. `OI_RENDER_PORT`,
`OI_RENDER_STATE_DIR`, `OI_RENDER_CONCURRENCY`, and optional
`OI_RENDER_SCENE_DIR` are operator settings, not client-controlled job parameters.

## Verify

```bash
npm run test:render
npm run build
npm run test:mcp-branding
npm run test:animation
npm run test:portable-scenes
```

Integration coverage uses the actual stdio MCP server, HTTP service, child worker,
Chromium renderer and GIF decoder. It covers the one-room GIF, client disconnect,
completed-output restart, empty rooms, timeline/sample output, missing/malformed
geometry, bounded settings, queue ownership, cancel/retry, deadline, renderer
failure, abrupt service death and pinned saved revisions. The existing Scene
authoring CI job runs the renderer checks and uploads the generated GIF, portable
scene and review JSON under `backend-render-evidence`; no separate runner job was
added. Complete lab-run/video exports remain #15.
