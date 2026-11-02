# SpaceIR v0.1 — spatial topology and metric compilation

Status: **domain contract + first deterministic architectural compiler**, issue [#100](https://github.com/Mapped-Assembly/OpenIndustries/issues/100).

## Ownership

The standalone TypeScript module at `packages/space-ir/src/index.ts` owns **spatial meanings**: regions, frame identities, boundaries, portals, adjacency/traversability, evidence, constraints and explicitly unknown geometry. It imports no renderer, LLM, OpenForma classes, simulation state, persistence or database services.

`src/lib/space-ir-compiler.ts` is a separate OpenIndustries adapter. It converts a **validated, metrically calibrated** SpaceIR document into the existing `Workspace` and its portable `astra.scene` v1 manifest. The resulting scene owns its rendered assets, instance positions, animations, edits and revision history. SpaceIR is not kept as a second mutable scene database. The original source is a separate immutable artifact that must be preserved by the caller.

`SPACE_IR_PROVIDER` advertises `domain: space`, provider, schema versions and capabilities for future registration with OpenForma's external domain-provider composition contract (#20). It is **metadata**, not a registered live remote plugin, and does not introduce a circular package dependency.

## Domain conventions

- Root identity: `schema_id = mapped-assembly.space-ir`, `schema_version = 0.1.0`, `id`, `revision`.
- Regions can have **unknown** polygons (`null`) without losing names/identity/topology.
- Each 2D polygon is an implicitly closed, non-self-intersecting ring with no repeated final vertex. `[x,z]` values refer to the named frame.
- Metric `world` frame is X/Z plane in **meters**, Y elevation in OpenIndustries. Source floorplan images can use `image_xy` pixel frames. No implicit pixel-to-meter conversion is allowed.
- Optional `to_world = [a,b,c,d,tx,tz]` explicitly maps `[x,z]` to `[a*x+c*z+tx, b*x+d*z+tz]` meters; invertibility is checked. A valid calibrated site supplies its own **metric dimensions**, never extracted from the drawing without measurement.
- `adjacent` is not traversable. Only a `traversable: true` portal between regions permits `accessibleRegions()` to cross. Windows cannot be marked traversable.
- A boundary path is a straight segment with adjacent region references; a portal's `span = [t0,t1]` denotes the fractional opening along that segment. Unknown wall dimensions are `null`, not zero/defaulted.
- Evidence stores immutable source IDs, SHA-256 source digests, confirmation status and optional locator. Inferred and observed claims are distinguished; model output cannot silently become human-confirmed fact.
- Occupancies can reference external engineering artifacts via stable identifiers without importing MechanicalIR or ElectricalIR. The initial compiler does not create unresolved external hardware.
- Constraint records identify their authority; this is **not** building-code or accessibility certification.

## SPACE-001: first deterministic fixture

`packages/space-ir/fixtures/SPACE-001.json` represents two adjacent rooms (Kitchen and Storage), seven explicit wall boundaries, one shared wall and a central **doorway**. The shared wall is split into two actual geometry segments around the opening.

Tests compare a window-only version, pixel-only (unscaled) version, calibrated pixel version, invalid polygon/ref/cycle/frame variants, and compiled/opened OI scenes. The synthetic fixture contains only declared dimensions (8 × 6 × 3 meters). All source evidence is labeled synthetic.

## Compilation, limitations and diagnostics

`compileSpaceIR(input)` returns `{ workspace, source_sha256, bindings, diagnostics }`.

- It runs domain-local validation before geometry generation.
- It **rejects an uncalibrated or absent metric site**, invalid source IR, non-contained wall geometry, overlapping openings, or unsupported site dimensions.
- It only compiles straight `wall` / `partition` paths with **explicit known height and thickness** to immutable generated boxes. The allowed native generated-asset identity currently uses the `oi-fixture` generator category, with SpaceIR provenance in each part's metadata, stable instance IDs, and SHA-256 input fingerprints.
- Openings are **full-height gaps** in wall geometry. Door leaves, jambs, glass, structural supports and lintels are **not** generated. Every such limitation receives an `OPENING_ONLY` diagnostic. This means the generated visualization is a simplified planning view, not fabrication-ready CAD.
- It does not reconstruct nonrectangular floors, arbitrary curved walls, multistorey structures, site orientation from a photograph, compliance or egress. Unsupported boundaries, missing region geometry and occupancies produce explicit diagnostics.
- The output is an ordinary editable OI scene: use existing 2D Plan (#96), 3D viewport, inspector, export/import, persisted revisions, and immutable geometry semantics. Do not add SpaceIR fields to the scene schema.

To run the focused checks:

```sh
npm ci
npm run typecheck:space-ir
npm run test:space-ir
npm run build
npm run test:plan
```

To export a standalone portable demonstration (the command refuses to overwrite existing output):

```sh
node --import tsx scripts/space-ir-demo.ts
```

Then import `deliverables/space-ir/SPACE-001.oi.json` using **Import OI project**, switch **2D Plan / 3D**, and verify the full-height opening in the shared wall.

## Next workstream: Meta floorplan understanding

The Meta hackathon consumer should independently extract `SpaceIR` from a floorplan, validate it with the pure contract, score region / topology / geometry accuracy against ground truth, and **only then** call this compiler. This separation prevents a visually convincing 3D rendering from counting as proof of floorplan comprehension.

Potential extensions: standalone published language-neutral JSON Schema, OpenForma external provider registration in a composed product, direct CLI/MCP compiler API, calibrated multi-floor coordinate frames, structural openings with door/window geometry, sourced occupancy imports, browser visual regression and a three-fixture image benchmark. These are not claimed implemented here.
