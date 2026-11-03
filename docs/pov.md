# First-person POV walkthrough

Issue: [#103](https://github.com/Mapped-Assembly/OpenIndustries/issues/103) · Epic: [#102](https://github.com/Mapped-Assembly/OpenIndustries/issues/102)

The scene editor now offers **3D**, **2D Plan**, and **POV** views of the same OpenIndustries workspace. POV is a viewer mode; moving the viewpoint does **not** mutate assets, item transforms, animation tracks, or saved scene revisions.

## Using POV

1. Open a workspace in the local web editor and choose **POV** from the viewport control.
2. Click inside the 3D canvas to focus and capture the mouse (pointer lock).
3. Move with **W / A / S / D** or the arrow keys. Hold **Shift** to walk faster. Move the mouse to look around.
4. Press **Esc** to release pointer lock; click the canvas again to reenter mouse-look. Click the center reticle to select equipment while locked.
5. Choose **Reset POV** to return to an initial spawn, or choose **3D** / **2D Plan** to inspect the same scene from another perspective.

On touch devices, drag within the canvas to look and hold the onscreen movement/turn controls. Controls stop on pointer release, canceled touch, canvas blur, tab visibility loss, or viewport unmount.

POV keeps its view position and angle while switching between views **within the current session**. A room replacement or new scene resets the camera. Saved camera presets, synthetic PNG and GIF export are described in [POV capture](pov-capture.md) (#105). Interactive robot-mounted camera controls remain tracked by [#104](https://github.com/Mapped-Assembly/OpenIndustries/issues/104).

## Geometry and safety limits

The camera's default eye height is 1.65 m in rooms tall enough to accommodate it, and movement is clamped to the declared rectangular room envelope. A bounded spawn search checks available visible object bounds and reports when no unobstructed candidate is found.

This is **visual navigation**, not validated human-access clearance or rigid-body collision simulation. The camera can pass through modeled objects. Imported CAD with missing or incomplete walls, doorways, or machine geometry cannot establish traversability or certify safe access. For engineering decisions, treat POV imagery as a review aid, not an independently measured sensor observation.

POV uses the existing Three.js renderer, the same scene objects and evaluated animation poses as orbit, and an independent first-person near/far clipping range. It does not require SpaceIR, OpenForma changes, 3D Lite, or a new render backend.

## Local checks

```bash
npm run build
npm run test:pov-camera
npm run test:camera-depth
npm start
# In a separate shell after the server is ready:
npm run test:pov-browser
```

The browser test uses local Chromium from Playwright and expects the built app at `http://127.0.0.1:8787/`. Install the browser with `npx playwright install chromium` if needed. The PR workflow runs these tests automatically.
