# Native 2D Plan (OpenIndustries issue #96)

The **2D Plan** toggle in the main workbench projects the current, authoritative
`astra.scene` v1 / workspace directly into a top-down SVG view. It is **not**
the independent `SpaceIR` discussed for floorplan understanding; no SpaceIR
instance, new scene database, or source-format migration is required.

## Coordinates and fidelity

- OpenIndustries retains meters and right-handed Y-up coordinates.
- Plan horizontal is **world X**; plan vertical is **world Z**, increasing downward.
  The room envelope is centered on the world origin and spans
  `[-width/2, width/2] × [-depth/2, depth/2]`.
- Asset geometry is transformed through the same instance Euler XYZ rotation
  and optional component pivot/animation poses as the 3D viewer.
- The renderer draws a **conservative convex envelope of component 3D bounding
  boxes**. This includes the full height of a part: it does **not** impose an
  architectural cut plane or reconstruct an exact silhouette, interior void,
  doors, clearances, code compliance, or travel paths. Missing geometry uses
  declared asset dimensions and is rendered with a distinct warning color.
- A grid pattern and SVG scale bar are measured in meters from the existing
  scene. The SVG download stores the visible projection, not an independent
  editable floorplan or synthetic dimensions.
- Larger footprint envelopes render behind smaller ones, reducing occlusion of
  equipment by architectural bounding shapes; precise walls and doors require
  actual source geometry or separately supplied spatial metadata.
- No zone or flow overlay is invented. Optional annotations, semantic room
  partitions, and floorplan-image understanding should be separate, sourced
  capabilities. The latter belongs in the proposed SpaceIR pipeline.

## Interaction

- Use **3D / 2D Plan** to toggle without changing the scene, selection, source
  assets, animation, scene revision or browser draft.
- **Fit**, **+/-**, wheel zoom and drag on empty space navigate the 2D view.
- Click a footprint to select the **same workspace instance ID** as 3D.
- Drag a footprint to change its base X/Z position, snapped to **0.1 m**.
  Elevation (Y) and all three rotation angles are preserved.
- Rotate the selected instance by ±5° about world Y using the toolbar. Both
  operations use the main workspace's existing `change` path, and therefore
  participate in undo/redo, portable export and ordinary draft saving.
- Pinned local revisions and linked cloud scenes are view-only in this
  viewport. Local head scene edits remain drafts until explicitly committed.
  Switching view mode never commits anything.
- **Export SVG** downloads an image of the current view. For a complete editable
  scene, use the existing **Export OI project** action instead.

## Verification

```bash
npm ci
npm run build
npm run test:plan
npm run test:workspace
npm run test:scene
npm run test:animation
```

The deterministic test covers metric room dimensions, translated and 90°
rotated footprints, hidden objects, negative positions, evaluated animation,
missing geometry, 79 individually addressable instances sharing an immutable
asset, and portable scene identity round-tripping.

Browser review still required for actual kitchen and cleanroom source scenes:
check layout semantics, hit-testing with overlapping geometry, rotation, pan,
zoom, export, selection, pinned revisions, commit, undo/redo, fullscreen and
mobile responsive behavior. No unexecuted visual benchmark is represented as
passed.

This is a planning viewport, not a validated architectural/safety drawing.
