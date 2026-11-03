# Interactive system inspector

The workbench can inspect OpenForma semantic bindings and locate their body-level geometry in the same OI viewport. The optional `inspection` field in `astra.scene` v1 survives portable export/import, local drafts and scene saves. It does not change domain ownership or apply another placement transform.

## Try it

1. Import `public/examples/system-inspector.oi.json` with **Import OI project**. An empty inspector also offers this file as **Download example project**.
2. Choose **Irrigation pump** under **System inspector**. Inspect function, supplied power assumption, source revisions, evidence and declared connections.
3. Choose **Locate Irrigation station / Irrigation pump**. The existing viewport focuses and highlights that exact part. Locate returns to the static 3D view so animation cannot hide the selected geometry.
4. Click a body in the viewport to inspect its semantic associations. Connections navigate to another binding; **Locate** then focuses its geometry.
5. Export the OI project, reopen it, or reload the browser. The bindings and annotations remain attached.

This example uses synthetic envelopes and illustrative engineering notes. Its 20 W input and 100 L capacity are not measured specifications or estimates derived from the rendered dimensions. The domain digest is an explicitly illustrative reference. No ProcessIR validation or physical performance claim is made by this fixture.

## Import an existing binding manifest

Use **Import project** to attach one JSON sidecar to the current scene:

```json
{
  "format": "oi.system-inspection",
  "version": 1,
  "systems": [{
    "id": "my-system",
    "manifest": "REPLACE WITH THE OPENFORMA BindingManifest OBJECT",
    "targets": [{
      "bindingId": "binding-in-the-manifest",
      "instanceId": "exact-scene-instance-id",
      "assetId": "exact-asset-id",
      "sourceDigest": "the-imported-asset-source-digest",
      "meshSha256": "SHA-256-from-meshFingerprint",
      "partId": "exact-scene-part-id"
    }],
    "annotations": []
  }]
}
```

The above is a structural illustration; replace the string placeholder with the actual manifest object and supply real hashes. `meshFingerprint(asset)` in `src/lib/system-inspection.ts` hashes UTF-8 `JSON.stringify(asset.parts.map(p => ({id:p.id, vertices:p.vertices, indices:p.indices})))`. Part IDs and mesh content are pinned. Labels and world placement are deliberately excluded. Omit `partId` only for an explicitly mapped whole-instance target.

An imported sidecar replaces the current inspection document through ordinary workspace history. Invalid input leaves the previous document intact. Missing bindings are retained with diagnostics rather than silently dropped. Sidecars are limited to 4 MiB, 50 systems and 5,000 total bindings/entities/requirements/targets. Geometry retains existing scene budgets.

The manifest is OpenForma's `BindingManifest` 1.0, not an OI reinterpretation of the domain IR. `src/lib/schemas/forma-binding-manifest-v1.json` was exported with `BindingManifest.model_json_schema()` from OpenForma commit `ed8fa32ef7f9dc9dbdb97070aa48418105f1635e`. OI validates its JSON shape and enforces the identity/status rules needed for this adapter. It preserves full manifest fields, including occurrence poses and geometric requirements. It does not run OpenForma's geometric evaluators.

### Supported geometry

- Native/synthetic scene meshes: `manifest.geometry.sha256` must equal the whole asset mesh fingerprint.
- Standalone STEP: the geometry digest must equal the original imported STEP bytes.
- Forma project + sibling STEP: the importer retains the original STEP digest in `asset.cadSource` separately from the Forma JSON source digest. The same digest check applies.
- Body, assembly and mesh-group entities with `physical_body` or `envelope` roles. Exact face, port, datum and contact selection remains unsupported.

The mapping from a catalog selector to an OI part is explicitly supplied by the exporter/author. Hash checking prevents applying that mapping to different geometry; it does not independently prove that the author mapped the correct physical body. `verified_from_artifact` is a source declaration, not a new OI certification.

### States

Declared unresolved, ambiguous, stale, unsupported and nonspatial states are preserved. Resolved declarations additionally require exactly one catalog selector match, a supported target kind/role, the original source/mesh digest, and a present visible scene occurrence/part. Names and array indices never repair a broken mapping. A duplicate instance receives no inherited mapping; removing a mapped instance retains its unresolved record. Copying a scene through a facility that assigns new instance IDs requires a new explicit map.

### Notes and evidence

Optional per-binding annotations contain `function`, `properties: [{name,value,unit?,source}]` and `connections: [{relationship,bindingId,source}]`. Connection targets belong to the same system. These are labeled **Supplied engineering notes**. Missing values are not estimated. Domain artifact references and hashes remain inspectable, but OI does not fetch or validate the original domain documents, infer physical connectivity from spatial proximity, validate live sensors, or execute geometric requirements. World-placement changes do not reinterpret artifact-local occurrence poses or certify clearance.

## Verification

```bash
npm run build
npm run test:system-inspector
npm run test:system-inspector-browser
```

The browser test starts Vite and exercises public file controls, WebGL raycast selection, semantic-to-body highlighting, connection navigation, IndexedDB reload, portable export, malformed/stale sidecars, and real OpenCascade STEP conversion followed by sidecar import. It emits a screenshot and portable project evidence under `test-results/system-inspector/`. `OI_CHROME_PATH` optionally selects an installed Chromium binary. CI runs the tests in `.github/workflows/system-inspector.yml`.

Regenerate the synthetic example with `npm run demo:system-inspector`. The exported manifests also validate against OpenForma's Python `BindingManifest.model_validate`.

This delivers the OI body-level import/UI portion of OpenForma #21. Persistent BRep feature selectors, typed feature authoring, regenerated face lineage, production CAD exporter automation, and domain-document revision reconciliation remain separate work. Keep #21 open.
