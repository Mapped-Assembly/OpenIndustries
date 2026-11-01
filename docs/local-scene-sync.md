# Live local scene synchronization

A workbench bound to a persistent local scene follows revisions committed by independent MCP or CLI processes. Browser-local rooms and cloud scene links remain separate. No Supabase account, credentials, or external service is required.

## Open a scene

Use Node 22.16+ and configure the **same store** for the HTTP service and the MCP/CLI writer. From the checkout, put this in `.env`:

```dotenv
OI_SCENE_BACKEND=local
OI_SCENE_TOOLS_ENABLED=true
OI_SCENE_DATA_DIR=.astra/scenes
```

Run `npm ci` and `npm run dev`. In **Local scene store**, enter the persistent scene UUID and leave Revision blank to follow head. Alternatively, open:

```text
http://127.0.0.1:5173/?localSceneId=SCENE_UUID
http://127.0.0.1:5173/?localSceneId=SCENE_UUID&revision=1
```

The second URL pins revision 1. The loaded revision stays fixed while the displayed store head updates. Pinned drafts can be edited and exported, but cannot commit; open the head URL to edit the current scene. `oi-local://scene/...` identifiers returned by MCP remain compatible; copy their UUID into the workbench. For a built application, `npm run build && npm start` serves the same bridge at port 8787.

Relative data paths resolve against `OI_ROOT` (the checkout by default). If your agent uses a different working directory, set `OI_SCENE_DATA_DIR` to the same absolute path in both processes. The trusted export/import CLI still works independently; it resolves relative paths from its working directory.

## Transport and state

The browser polls `GET /api/local-scenes/:id/head` every **2 seconds**, with one request sequence in flight and a **10-second timeout** per request. It downloads a portable snapshot from `GET /api/local-scenes/:id?revision=N` only when the selected revision changes. Browser background-tab throttling can delay polling. The service opens the existing SQLite store per request, so updates from other processes and service restarts become visible without a browser restart. Geometry loads retain the backend's size and SHA-256 verification.

A snapshot replaces the editor workspace atomically after validation. Original instance IDs and immutable asset-version bindings remain intact; unchanged asset and item objects are reused. The React application is retained. The existing viewer rebuilds its geometry graph when object membership or version bindings change; transform-only updates use its normal pose update loop.

| State | Behavior and action |
| --- | --- |
| Following head | A clean workspace automatically loads newer committed revisions. |
| Pinned revision | Remains at the URL's revision; head metadata continues updating. |
| Unsaved edits | Browser edits remain private until **Commit browser edits**. Undo to the loaded state permits following again. |
| Conflict — draft retained | Head differs from the edited base. No automatic overwrite, merge, or rebase. Export the draft, then explicitly discard and load store, or detach and keep editing. |
| Detached | No polling or commits. The workspace and recovery draft are retained. Reconnect rechecks head and preserves dirty edits. |
| Offline — retrying | Last geometry and edits remain available. Polling resumes automatically when the service returns. |
| Commit outcome pending | A request may have committed without returning a response. **Retry same commit** uses its original request ID and exact payload, including after reload. |

Commit requests use `POST /api/local-scenes/:id/commit` with `{request_id, base_revision, document}`. The document is a complete portable scene. The service validates geometry/version identity and saves using the backend's atomic compare-and-swap transaction. A stale base returns HTTP 409 with `current_revision`; it never overwrites another writer. Imported unversioned assets are persisted to immutable local versions at commit. Identical retries return the original receipt; reusing an ID with different content is rejected. There is no automatic force-save.

A delayed snapshot response is ignored if the user edited or detached while it was loading. Editors are disabled during commits. Whole-project replacement, new-room and demo-layout actions are disabled while bound; use a browser-local room for those operations. Individual assets, transforms, visibility and animation remain editable.

## Recovery and limits

Drafts and pending request payloads are journaled in IndexedDB, scoped by tab, scene and pinned/head mode. The journal is restored **before** contacting the service. Browser-local room drafts are unaffected. Dirty/pending sessions warn before navigation or reload. Wait for **Recovery draft saved** before reloading; leaving while a journal write is pending can lose that latest edit. Unreadable recovery data blocks loading until reload succeeds or the user explicitly discards recovery. Storage write errors are visible and instruct the user to export; a commit is not sent until its recovery receipt is saved. Recovery is on this browser/device, not a cross-device backup: export before closing the tab or clearing browser storage. A fresh browser session opens the persisted URL, not another tab's private draft.

This bridge is for a single user's machine. It binds to loopback through the existing HTTP service, rejects non-loopback Host and Origin values and cross-site fetches, and does not enable CORS. It is disabled unless `OI_SCENE_BACKEND=local`. Do not expose it via a public reverse proxy. Requests are bounded to 75 MiB; scene metadata to 1 MiB and each immutable geometry bundle to 25 MiB.

## Verification

```bash
npm run test:local-scenes
npx playwright install chromium
npm run test:local-scene-sync
```

`test:local-scene-sync` starts the real HTTP service, Vite, Chromium and a separate stdio MCP process against a temporary SQLite directory. It proves nine original objects become ten after adding `environment-monitor-01`, compares all original IDs/transforms/visibility/version bindings and complete geometry hashes, compares browser exports with persistent state, and checks a changed rendered frame. It also tests pinned views, dirty draft recovery, browser commits, offline edits, restart/fresh-session reopening, detach/reconnect, lost-response retries, in-flight edit races, stale writes and local access boundaries. The Scene authoring CI workflow runs it. `OI_CHROME_PATH` can select an existing Chromium executable.
