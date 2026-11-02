# Concurrent scene edits and recovery

Every write to an existing scene requires an explicit expected revision. `openindustries.update_scene`, `openindustries.mutate_scene`, `openindustries scenes mutate`, and local browser commits use `base_revision`. Cloud save, restore and delete RPCs use `p_expected_revision`. Missing, null or invalid revisions are rejected. Revision 0 is reserved for creation; it cannot overwrite an existing scene.

## Conflict contract

A stale full replacement or object batch commits no scene revision. MCP returns `isError: true` with the following object in both `structuredContent` and JSON text content. The mutation CLI exits 1 and writes it to stderr (Node warnings may also appear on stderr).

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Scene has changed. Read the current revision, review changed fields, and reapply your edit with a new request_id.",
    "scene_id": "22222222-2222-4222-8222-222222222222",
    "expected_revision": 4,
    "actual_revision": 5,
    "current_revision": 5,
    "applied": false,
    "base_available": true,
    "changed_instances": [
      { "instance_id": "monitor", "change": "updated", "fields": ["position"] }
    ],
    "scene_fields": [],
    "retry": "refresh_and_reapply"
  }
}
```

`current_revision` is retained for compatibility and equals `actual_revision`. Local HTTP commits return status 409 with these details flattened alongside `code` and the message in `error`. Cloud RPCs use SQLSTATE `40001`, with the same details JSON in `details`; the browser exposes these through `SceneConflictError` and retains its dirty draft.

Changed instance entries are sorted by stable ID. `change` is `added`, `removed` or `updated`. `fields` contains `presence` for additions/removals, otherwise any of `name`, `asset`, `position`, `rotation`, `visible`. `asset` covers identity and immutable version. `scene_fields` may contain `name`, `room`, `assets`, `animation`, `instance_order`. No field values, geometry or credentials enter the report. These are **net snapshot differences**, not an audit of intervening writes: a field changed and reverted may not appear. If the requested base does not exist (including a future base or legacy unrecorded revision), `base_available` is false and change lists are empty, not proof of independent edits. The reported head may advance again; reread before recovery and retain CAS on the next write.

## Safe refresh and retry

1. Keep the rejected request and its original base snapshot. Read the latest scene.
2. Compare the intended fields against their original values. Resolve overlapping edits explicitly; do not silently replace another writer's values.
3. For an independent object edit, send the intended patch against the freshly read revision with a **new request ID**. Include field `preconditions` from the original snapshot to reject unexpected overlaps. Include every field the decision depends on, not just the field being written.
4. For a full replacement, start with the fresh scene and reapply only the intended changes. **Never change only `base_revision` on an old complete document**: that explicitly submits stale values for everything else.
5. If another writer wins again, repeat the review. There is no force-save, automatic merge, or unconditional server retry.

Example: agents A and B read revision 4. A moves `monitor`, publishing 5. B's stale move of `robot` returns `CONFLICT`. B reads 5, verifies `robot.position` still matches revision 4, then patches it at base 5 with that position as a precondition and a new UUID. Revision 6 preserves A's monitor move. If B intended to move the monitor using its old position, the refreshed request's precondition fails with `PRECONDITION_FAILED`; no revision is published. A caller deliberately accepting changed values can submit a new reviewed edit.

Local browser drafts and pending request IDs are journaled in IndexedDB before sending. After a conflict, export the draft, load the stored head through the explicit discard action, and reapply the reviewed changes. Polling and conflict errors never replace a dirty draft. Cloud browser conflicts retain the current workspace and show the changed IDs/fields; export or save a separate copy before reopening head. Neither viewer automatically merges drafts.

## Unknown outcomes and durable receipts

Generate a UUID once per logical write and retain the **whole original request** before sending. If a connection dies, a process restarts, or a response is lost, resend the identical request, including the original base, agent and UUID. An accepted retry returns its original revision identity and result even after later writes. It never rewinds head or creates another revision. This applies to creates, full updates and patches. Changing the payload, base, or scene while reusing an accepted ID returns `REQUEST_ID_REUSED`. A rejected, uncommitted request reserves no receipt; use a new UUID for a reviewed edit regardless.

The cloud browser's retry action captures the same edit and write ID; edits made after an uncertain response remain dirty when the earlier save is confirmed. Programmatic `SceneRepository.save(..., writeId)` and `restore(..., writeId)` callers can persist the ID across restarts. Agent clients must persist their requests themselves. Cloud browser reload retains its room draft, but does not automatically replay a pending cloud action; reopen/compare the saved history before choosing the next edit. The local browser provides reload-safe pending-commit recovery.

Request IDs are unique across a local store, and across an authenticated cloud owner's retained revisions. Other owners cannot read each other's receipts. Cloud scene deletion removes its history and receipts under the existing deletion policy; receipt guarantees apply while the scene history is retained. Previously saved revisions lacking a recoverable write ID remain readable but cannot acquire historical retry identity retroactively.

## Transaction boundaries and deployment

- **Local:** SQLite `BEGIN IMMEDIATE` encloses receipt lookup, revision comparison, ready-asset checks, head update and immutable revision/receipt insertion. Competing processes cannot both publish from one base. A rollback leaves the old head and earlier snapshots intact.
- **Cloud:** apply `20261102010000_scene_write_conflicts.sql` with the existing migrations before deploying these clients. It adds receipt metadata to the existing revision table, backfills recoverable unambiguous IDs, and adds an owner/request uniqueness index. Save/restore use a per-scene transaction advisory lock (including scene creation) and row locks. The expected revision, references, snapshot and receipt commit together. Conflicts report the locked rejected head, not a later unrelated read. Direct scene writes remain revoked; owner-scoped RPCs remain the mutation boundary.
- **Geometry:** imports/uploads are independently durable and may finish before a scene loses its CAS. Full saves can leave unused uploaded assets after a conflict; they never partially publish a scene. Object patches reference existing immutable assets and do not upload geometry.
- The protocol does not claim physical feasibility, collision checking, automatic semantic merging, or cross-scene atomicity. Restore creates a new revision; it does not rewrite history. Delete requires a matching positive revision.

## Validation

`npm run test:scene-conflicts` launches independent MCP processes for full replacement and patch races on SQLite and the migration-backed cloud fixture. It verifies structured conflicts, fresh-read disjoint recovery, overlapping preconditions, historical request reuse, post-commit response loss, new-process recovery, immutable snapshots, store-level CAS, null-base rejection, and owner isolation. The cloud fixture uses actual migrations/RLS but serializes SQL through PGlite; production PostgreSQL lock contention is not benchmarked by this fixture.

`npm run test:local-scene-sync` covers browser conflicts, retained/reloaded dirty drafts, lost HTTP commit responses, and the HTTP conflict contract. Existing mutation, persistence, scene-history and browser workflows remain regression checks.
