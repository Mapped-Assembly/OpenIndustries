# POV presets and evidence-backed synthetic capture

Issue: [#105](https://github.com/Mapped-Assembly/OpenIndustries/issues/105) · Epic: #102 · Depends on merged #103 / PR #106.

OpenIndustries can save named human POV viewpoints or camera mounts attached to an **existing** scene instance and export a PNG still, static POV GIF, or GIF over an authored animation. All captures reuse the original OI scene/animation evaluator and Three.js world; no new geometry or scene representation is generated.

## Workflow

1. Open a space, select **POV** in the viewport, and position the camera with mouse/keyboard or touch.
2. Open **GIF studio → POV capture** and choose **Save current POV**. A name is required.
3. Alternatively, select an existing scene instance and press **Save selected instance camera**. This creates a simple mount with a local +0.12 m vertical offset. This is a synthetic camera; full tool/robot camera controls belong to #104.
4. Select the saved preset, choose **PNG screenshot**, **fixed POV GIF**, or **authored timeline GIF**, then export.
5. For a saved world camera, click **Use saved POV in viewer** to restore its original position and look direction. Attached camera views are currently capture-only pending #104.
6. Download the media and accompanying **POV evidence** JSON. Reuse named presets in the same scene on this browser. Presets are not embedded in exported OI scene JSON and do not alter scene revisions.

Any preset saved for an earlier numbered scene revision requires an **explicit rebind** before capture. Rebinding changes the local preset only. The renderer fails closed for missing or hidden camera-parent instance/part bindings.

## Contract

A versioned `PovCameraPreset` includes preset ID/name, scene key and revision (or `null` for unversioned local draft), saved timestamp, field of view, near/far clip planes, and one of:

- `worldPose`: Y-up metric world position and unit quaternion.
- `attachedPose`: existing instance ID, optional part ID, metric local offset, unit quaternion.

The camera is resolved from `applyWorldPoses(evaluateWorkspace(...))` at each frame time. A mounted camera follows the real evaluated parent mesh transform, including rotations; it never uses a duplicate scripted camera track. The screenshot at time `t` uses the same state evaluator as the POV GIF at `t`.

### Evidence

The JSON sidecar includes `sourceClassification: "synthetic_scene_render"`, a SHA-256 digest of the scene manifest used for capture, media SHA-256, camera preset/binding and actual evaluated world camera transforms for each frame. GIF metadata also retains asset source digests, instance IDs and animation frame poses. The image itself is stamped **SYNTHETIC POV**.

A scene manifest hash binds asset references and source digests, not independent proof of the real-world machine or the quality of its sensors. The encoded media hash allows verifying that the downloaded PNG/GIF bytes match the sidecar. A saved scene ID/revision reflects the source context but is not a cryptographic signature of ownership.

## Budget and backend integration

Browser capture is bounded to **128 expanded scene instances, 300,000 expanded vertices, 1,024 parts**, 320/480/640 px and existing 2–4 second / 10–15 fps GIF settings (no more than 60 frames). Invalid presets, missing geometry, outdated scene revisions and unsupported animation ranges return explicit errors.

The existing backend **#67 GIF-only** render service accepts the new `options.pov` field and `motion: "pov"`, with its existing **64 instances, 200,000 vertices, 600,000 indices, 512 parts, 60 frames, 8 MiB request and 64 MiB output** limits. For saved scenes, the backend requires the camera preset's `sceneKey` and `sceneRevision` to exactly match its pinned saved-scene source. For portable scenes, a camera preset must use `sceneRevision: null` because it cannot substantiate a saved revision claim. The backend continues to publish GIF media and independently stamped render job metadata; PNG capture is currently browser-local.

This feature is **not** a real camera stream, automatic inspection result, calibration, traversability or physically validated motion.

## Regression tests

```bash
npm run build
npm run test:pov-camera
npm run test:pov-capture
npm run test:camera-depth
npm start
# Separate terminal with the production server up:
npm run test:pov-browser
npm run test:pov-capture-browser
```

CI runs the above POV-specific commands on pull requests.
