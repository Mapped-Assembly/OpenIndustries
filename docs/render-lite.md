# OpenIndustries 3D Lite render profile

Issue: [#97](https://github.com/Mapped-Assembly/OpenIndustries/issues/97) · Related: [#96](https://github.com/Mapped-Assembly/OpenIndustries/issues/96) (2D Plan), [#67](https://github.com/Mapped-Assembly/OpenIndustries/issues/67) (isolated background render), [#102](https://github.com/Mapped-Assembly/OpenIndustries/issues/102) (POV).

## Use

In the workbench's **Viewport mode** toolbar, choose the **3D render profile** drop-down:

- **3D Lite** (default) — material simplification, a 1× device-pixel-ratio cap and demand-driven rendering when the view is stationary. Full hardware WebGL triangles and depth buffering remain enabled.
- **3D Detailed** — existing physically based MeshStandardMaterial shading, up to 2× device pixel ratio, continuously scheduled render loop. Choose when inspecting CAD surface/material appearance.

The profiles share **one** existing canvas, perspective camera, world geometry, instance identities, selection, scene revisions and evaluated animation state. Switching profiles does **not** regenerate assets, remount the canvas, or write scene history.

Lite shares the exact immutable BufferGeometry across repeated asset/part instances only after confirming matching asset ID, source digest, part ID, vertex values and index values. It retains individual Mesh objects, instance groups and per-instance materials so picking, color/emissive selection, transform, visibility and part animation remain independent. The shared resource is disposed once.

In Lite, a static viewer draws when a selection, pose, timeline sample, camera interaction, pointer movement, resize, mode change or scene update requires it; orbit damping continues until it settles, and key-held POV movement continues to update. Hidden tabs do not schedule new frames. Detailed keeps the previous continuously-updating behavior. Source geometry remains unchanged in both profiles.

## Preview export

Press **Capture Lite PNG** in the Lite viewport to capture the **active camera** at 480×480 using a temporary WebGL render target on the **same renderer and evaluated scene**. The render target enforces hardware depth testing, and pixels are flipped into PNG order. No second scene is built and no Chromium worker is launched for the browser snapshot. Download **Lite PNG** and **Lite metadata** as a pair.

The metadata is labeled `synthetic_scene_render`, and contains scene/revision context (when available), a SHA-256 of the camera's scene manifest, a SHA-256 of the exported PNG, camera world position/quaternion and FOV/clipping, timeline time, all instance/asset IDs and source digests, visible states, raster CPU time, and renderer draw call/triangle/resource counters. A synthetic image is **not** a real sensor, measured evidence of inspection, or an engineering clearance check.

Browser snapshots are bounded to **128 instances** and one of 320, 480 or 640 pixels (UI uses 480). Missing geometry is explicitly refused, rather than inventing placeholder proof. The static export freezes the current camera; if a scene is animated, metadata identifies the displayed time.

Existing GIF Studio has an optional quality profile from the main viewport, which is carried into the same GIF evaluator (both static and POV GIF). The backend `/v1/render/jobs` also accepts `options.profile = "lite" | "detailed"`, validates it and preserves its sandbox/Chromium process isolation.

### Backend 79-instance constraint

The backend GIF worker **still has a hard 64-instance ceiling**. A 79-instance GIF will return the structured `GEOMETRY_LIMIT` error with the observed count and supported limit, regardless of profile. This is intentional: simply increasing the instance ceiling would bypass a capacity decision without confirming worst-case expanded vertices, memory, worker deadline, frame count and output size. The 79-instance browser Lite snapshot is supported independently.

A future backend capacity change must run worker measurements under the existing 8 MiB input, 64 MiB output, 60-frame, 200k expanded vertex, and 120s deadline limits before increasing the instance cap. A Lite profile alone does not make Chromium/SwiftShader safe to bypass or magically replace.

## 60-asset / 79-instance kitchen benchmark

`benchmarks/kitchen-lite/79-instance-synthetic.oi.json` is a **synthetic fixture**, *not* the original user's restaurant CAD or a claim about that restaurant's actual layout. The fixture represents 60 separately identified equipment envelopes and 79 independently placed instances, including 19 repeats; its goal is to stress source identity, GPU geometry reuse, depth, and view state.

Run:

```bash
npm run build
npm run test:render-lite
npm start
# Another terminal with the built server running:
npm run test:render-lite-browser
```

The browser benchmark writes `test-results/lite-kitchen-metrics.json` and two screenshots, comparing both profiles on exactly the same scene, browser, viewport and runtime. Metrics include the wall clock to first loaded scene (which can include startup and import), number of idle Lite frames vs continuously updating Detailed frames, CPU-side frame times, draw calls, geometry allocations and PNG byte size. The metrics are **environment-specific** (Ubuntu Playwright/SwiftShader in CI, not a benchmark of integrated GPUs or phones), and CPU-side raster/readback times **must not** be presented as GPU execution timing.

The fixture checks that 79 instances remain present, 60 distinct asset resources are reused, 1 instance edit does not mutate other placements or IDs, the canvas survives reversible profile switching, and a real PNG and source metadata can be downloaded. PNG capture is a synthetic geometric review, not a solution for poor input CAD, missing openings, floating stations or validated food-service compliance.

## Future work outside this PR

- Import and inspect the user's **original 79-instance kitchen** from its exact scene file to validate actual CAD proportions, occlusion, annotation, doorways and floor contact. The synthetic fixture is a prerequisite stress test, not a substitute.
- Run measured low-power/iGPU/mobile hardware tests and tune budgets only from collected metrics.
- Benchmark Chromium worker startup cost and worker isolation before considering any persistent/pooled renderer.
- Consider selective draw-call batching/instancing after proving preserved per-part selection and independent transforms. Current Lite sharing saves BufferGeometry allocations but does not automatically reduce draw calls.
