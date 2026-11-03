# Mounted POV — live cameras on scene instances and robot frames

Issue [#104](https://github.com/Mapped-Assembly/OpenIndustries/issues/104) · [POV epic #102](https://github.com/Mapped-Assembly/OpenIndustries/issues/102)

A mounted POV is a **synthetic** perspective camera bound to an existing OpenIndustries scene instance or explicitly represented part. It shows the pose from the same evaluated scene as orbit, 2D Plan and animation playback. A camera mount does not create geometry, edit an object's transform, command a physical robot, or certify anything about a real sensor.

## Workbench walkthrough

1. Open a scene, then select **Mounted POV** in the view switch.
2. Under **Attached camera controls**, choose **Parent instance**. The viewport stays unbound until you explicitly select an instance. It never substitutes a different parent automatically.
3. Optionally choose a declared **Mount frame** (an existing part ID), or use the instance origin.
4. Adjust **Local offset X/Y/Z (meters)**, **Pitch/Yaw/Roll (degrees)**, and **field of view**. Changes apply only to the camera rig, not scene geometry. The rotation convention is Three.js YXZ with a right-handed Y-up world.
5. Play/scrub the authored timeline. The mounted camera follows the chosen instance **and part** transform at that exact evaluation time. You can switch to 3D, free POV or 2D Plan without altering scene revisions.
6. Save the current mount in **GIF studio → POV capture → Save current mounted camera**. Saved mounts retain the parent ID, selected part, immutable asset ID/source digest when available, local pose, and camera clipping. You can use **Use saved POV in viewer** to restore it, or export the PNG/GIF evidence through #105.

The initial mount offset is 0.12m above the selected instance or part origin. This is only a starting view, **not** an inferred camera location or optical calibration. The active camera binding is transient until explicitly saved to browser-local presets.

## SO-101 Run workspace

Open **Robot Run**, select **Robot camera POV**, and choose an actual link instance (for example an available gripper link). The Run workspace creates objects for the robot links and applies the controller-supplied transform to each one. The camera therefore follows those link poses without a second animation track. The view reports a disconnected/stale state when the local runtime is unhealthy, and recorded replay is clearly labeled read-only.

**Important:** An OpenCAD/URDF visual part is not automatically a separately evaluated joint or calibrated tool center point. Only select frames actually represented by OI, and do not infer undeclared robot frames from names. A camera on a robot link that has a known controller pose is the bounded supported path; independent tip-frame sensors need an explicit resolved frame binding.

## Unbound, stale, and revision behavior

The viewer fails closed (black frame with visible reason) instead of silently swapping the mount when:
- the bound instance was deleted, geometry is missing, or the part ID no longer exists;
- a bound asset ID, source digest or cloud version changes;
- the parent is hidden at a displayed timeline frame;
- the Run runtime is unhealthy/disconnected, or a saved view's numbered scene revision is no longer current.

An explicit selection of another instance or frame creates a fresh binding. Moving a machine within the same scene is **not** itself a failure: the camera follows the new evaluated pose. Offsets and camera FOV cannot mutate a scene or its revision.

## Source and evidence boundaries

The renderer's output is labeled **simulated/synthetic POV**, never hardware video or measured perception. Real-world cameras, optical calibration, robot safety/clearance, depth estimation, autonomous navigation and verified machine dynamics are outside this issue. PNG and GIF evidence still use the bounded #105 capture path, with timestamps and source provenance.

## Verification

```bash
npm run build
npm run test:pov-camera
npm run test:pov-capture
npm run test:mounted-pov
npm run test:camera-depth
npm start
# After the local production server starts:
npm run test:pov-browser
npm run test:pov-capture-browser
npm run test:mounted-pov-browser
```

The PR's POV GitHub Actions workflow executes these and cross-checks regressions.
