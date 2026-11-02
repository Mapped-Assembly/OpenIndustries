# Atomic object-level scene mutations

`openindustries.mutate_scene` applies an ordered batch of instance edits to a persisted scene. Agents send only the objects/fields they intend to change. The service preserves other instance records, immutable asset bindings, room dimensions and the complete animation, then commits one revision through the existing backend's revision check. `create_scene`, `read_scene`, and full-document `update_scene` remain compatible.

The tool supports both the local SQLite store and the authenticated cloud backend. Use the [existing scene-tool configuration](mcp-scenes.md); local use requires no cloud account. The legacy `astra.mutate_scene` alias accepts the same contract.

## Add one object

Import geometry separately through the existing immutable asset workflow. For local assets:

```bash
node --import tsx cli/local-scenes.ts import-asset monitor.asset.json
```

The bundle is `{"schemaVersion":1,"asset":...}`. The command returns a local `version_id`. Existing objects' references can also be obtained from `openindustries.read_scene`. Cloud clients use their existing authenticated asset-upload workflow and `{"kind":"cloud","version_id":"..."}` references. Mutations accept persisted local/cloud references only: no paths, inline geometry, or `example` references. An imported asset is independently durable; a subsequent failed mutation leaves that asset available but changes no scene.

Pass the following to `openindustries.mutate_scene`, replacing the example UUIDs with the scene ID, a new request UUID, and the imported asset version:

```json
{
  "version": 1,
  "request_id": "11111111-1111-4111-8111-111111111111",
  "scene_id": "22222222-2222-4222-8222-222222222222",
  "base_revision": 1,
  "agent": "monitoring-agent",
  "operations": [
    {
      "op": "add_instance",
      "instance": {
        "id": "environment-monitor-01",
        "name": "Environment monitor",
        "asset": { "kind": "local", "version_id": "33333333-3333-4333-8333-333333333333" },
        "position": [2, 0, 2],
        "rotation": [0, 0, 0],
        "visible": true
      }
    }
  ]
}
```

The same request works from the CLI:

```bash
node cli/openindustries.mjs scenes mutate request.json
# Or, with the package installed:
openindustries scenes mutate request.json
```

Success prints JSON to stdout. Failure exits nonzero and prints an error JSON object to stderr. The CLI uses the same enable flag, backend, authentication, data directory, validation and transaction code as MCP. Relative scene data directories resolve against `OI_ROOT` (the current working directory by default for this CLI); use a shared absolute `OI_SCENE_DATA_DIR` if clients run from different directories.

## Update and remove

For each new request, use a new `request_id` and the current `base_revision`. An update's nonempty `patch` is its explicit field mask: only supplied fields change. Vectors replace all three coordinates; they are not deltas. IDs are immutable.

```json
{
  "op": "update_instance",
  "instance_id": "environment-monitor-01",
  "preconditions": { "position": [2, 0, 2], "visible": true },
  "patch": { "position": [3, 0.5, 4], "rotation": [0, 90, 0] }
}
```

```json
{
  "op": "remove_instance",
  "instance_id": "environment-monitor-01",
  "preconditions": { "position": [3, 0.5, 4] }
}
```

| Operation | Required behavior |
| --- | --- |
| `add_instance` | Full instance fields; ID must not already exist at this point in the batch. New instances append to the collection. |
| `update_instance` | Existing `instance_id` and nonempty `patch`; allowed fields are `name`, `asset`, `position`, `rotation`, `visible`. |
| `remove_instance` | Existing `instance_id`; remaining instances retain their order. |
| `preconditions` | Optional nonempty expected-value object on update/remove. Uses the same five fields as patch and exact canonical comparison against the state produced by preceding operations. |

All batches require an existing scene and matching positive `base_revision`. After structural validation, operations run in order in memory; later operations see earlier changes. The final graph must satisfy the scene schema. A valid batch, including a no-op patch, creates exactly one revision.

Positions use metres in the existing Y-up frame (X width, Y height, Z depth); rotations are absolute Euler XYZ degrees. Transform coordinates must be finite three-vectors within ±1,000,000. Geometry uses the existing immutable-file size/hash and renderable triangle/bounds checks, with scene asset dimensions bounded by the manifest schema. This does not certify collision freedom, physical reachability, or placement within room walls.

Replacing an asset reference updates its version and corresponding scene asset metadata. One asset ID cannot refer to two different versions in the final scene: replace all its instances together, or import a distinct asset ID. Metadata and blobs for removed instances are not garbage-collected by mutations. Unrelated asset records are retained canonically unchanged.

Animation tracks and key IDs are never rewritten or silently removed. Removing an animated instance, or rebinding it to geometry without a targeted component, fails with `ANIMATION_REFERENCE`. Use a complete `update_scene` to change animation, or a batch that leaves the final references valid (for example, remove/re-add the same ID with compatible geometry).

## Results, retries and failures

A success includes the usual `scene_id`, `revision_id`, head/revision URLs, plus:

- `changes`: one entry per operation with zero-based `operation_index`, `op`, `instance_id`, `status: "applied"`, and the explicitly affected `fields`.
- `summary`: `added`, `updated`, and `removed` **operation counts**, not a net diff. A batch adding then removing an object reports both operations.
- `provenance`: `agent`, `parent_revision`, `request_id` and canonical request SHA-256 `request_digest`.

The summary is stored in that revision's authoring metadata. An identical retry returns the original receipt, even after another writer advances head. A different payload reusing the same receipt ID is rejected. Use the returned revision for the next edit; after a stale-base `CONFLICT`, read the new head and reconcile before issuing a new request. No force-save or automatic semantic merge is provided.

Structural or semantic operation failures identify the failed operation:

```json
{
  "error": {
    "code": "INSTANCE_UNAVAILABLE",
    "message": "The target instance does not exist at this point in the batch.",
    "applied": false,
    "operation_errors": [
      { "operation_index": 1, "op": "remove_instance", "instance_id": "missing", "code": "INSTANCE_UNAVAILABLE", "message": "The target instance does not exist at this point in the batch." }
    ]
  }
}
```

Validation stops at the first failure; there is no partial-success result. Failures before a particular operation (configuration, authentication, invalid envelope, damaged base scene, stale revision, or store commit failure) are scene/request-level errors. A conflict includes `current_revision`. No mutation operation uploads assets, so a failed batch produces no partial scene revision or new asset version. Both the candidate document and success receipt are validated before the existing backend performs the sole durable scene commit.

Limits: 1–100 operations, 1 MiB request/response and resulting scene metadata, 1,000 scene instances/assets, and the existing 25 MiB per geometry file / 50 MiB geometry-loading budget. The service validates the base geometry as well as new bindings; smaller agent requests do not eliminate server-side scene validation.

## Verification

`npm run test:scene-mutations` exercises real MCP processes and the CLI against SQLite and the existing HTTP/PGlite cloud fixture with actual migrations and account isolation. It verifies nine original objects remain exact across add/move/remove, complete geometry hashes, immutable animation, process restart, ordered batches, field preconditions, rollback, invalid references/transforms/bounds, asset-version replacement, receipt replay, stale writes, concurrent writers and full-document update compatibility. Scene authoring CI runs this suite.

See [concurrent edits and recovery](scene-conflicts.md) for structured conflicts, safe refresh-and-retry, durable request identity and backend transaction boundaries.
