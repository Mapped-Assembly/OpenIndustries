# Native PNG and GIF rendering PoC

Render portable Open-Industries `astra.scene` v1 files with Python, pygfx and
wgpu-native. No Chromium, Playwright, Node service or display server is involved
in rendering or GIF encoding. The existing browser renderer remains unchanged.

## Install and run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[native-render]'

# Still image
oi-render-scene benchmarks/native-render/room-10x10.oi.json /tmp/room.png

# Four-second camera orbit of the existing field lab's base layout
oi-render-scene benchmarks/field-lab/fixtures/field-lab.oi.json /tmp/orbit.gif \
  --motion turntable --base-layout --duration 4 --fps 15

# Play authored animation with a fixed camera
oi-render-scene benchmarks/field-lab/fixtures/field-lab.oi.json /tmp/animation.gif \
  --motion animation --start 0 --duration 3 --fps 15
```

The output extension selects PNG or GIF. Common options:
`--width 640 --height 480 --azimuth 35 --elevation 30` (angles in degrees).
GIFs loop by default; `--no-loop` encodes one playback. `--start` selects a time
in the authored timeline and is only valid with `--motion animation`.

On Linux, install a Vulkan-capable GPU driver. On a machine without a GPU,
Mesa's Lavapipe software Vulkan driver works (`sudo apt-get install
mesa-vulkan-drivers` on Debian/Ubuntu). Removing the browser does not remove the
graphics driver dependency. CPU software rendering is not a GPU performance
benchmark. Missing/unsupported drivers fail explicitly.

## Scene and animation contract

- Reuses `export_scene.validate_scene` for exact bundled mesh/source/version
  resolution, including `bundledVersions`. Missing geometry or revision
  mismatches are errors, not placeholder boxes.
- Preserves indexed mesh positions, colors, instance visibility and Three.js
  intrinsic XYZ rotations in degrees. Does not reapply `originOffset`; the
  vertices are already normalized. Shared assets reuse geometry/materials.
- The room tuple is width/depth/height in meters, Y up. A presentation floor and
  wire envelope show the declared dimensions. Actual wall geometry must come
  from the bundled assets; the renderer does not infer walls.
- PNGs and turntables show base poses. When tracks exist, `--base-layout` is
  required to explicitly ignore them. Authored GIFs instead require
  `--motion animation`; this conflicts with `--base-layout`.
- Authored animation matches `evaluateWorkspace`/`applyWorldPoses`: linear
  position interpolation, shortest-path quaternion slerp, endpoint clamping,
  held instance visibility (omitted values inherit), and part-local transforms
  about each mesh's bounding-box center before the instance transform.
- Validate targets, duplicate tracks/times, finite poses, timeline bounds and
  visibility before encoding. Missing part targets are errors.
- Authored camera framing covers the sampled motion bounds and remains fixed;
  turntable camera framing stays fixed in scale while orbiting 360 degrees.
  Geometry and the native renderer are created once and updated per frame.
- GIF frame times are quantized to centiseconds with cumulative rounding.
  At 15 fps, delays alternate between 60 and 70 ms rather than truncating every
  frame to 60 ms. The sampled range excludes its end (avoiding a duplicate
  turntable endpoint). Pillow may coalesce identical adjacent frames while
  preserving total duration.
- GIF uses 256-color per-frame palettes without dithering. Color fidelity is
  lower than PNG and subtle palette changes may be visible between frames.
- Flat Phong shading converts OI linear RGB to sRGB. This does not promise
  Three.js lighting/shadow/overlay parity. No authored normals or textures,
  physics, live scene synchronization or remote asset retrieval.

## Limits and evidence

PNG dimensions: 64–4096 pixels per side. GIF dimensions: 64–1024 pixels per
side; duration: 0.1–12 seconds; fps: 1–50; at most 240 sampled frames and
32 million total frame-pixels. These limits bound the in-memory frame sequence.
Input files are limited to 75 MiB. Animation ranges cannot extend beyond the
authored timeline; no implicit wrapping is performed.

Every image gets a `.render.json` sidecar with the native adapter, camera/image
settings, source/output SHA-256 hashes and animation status. GIF reports also
record requested fps, sampled/encoded frame counts, quantized duration, start
time and looping. Files sharing an output stem share a sidecar path.

![Native field-lab orbit](../benchmarks/native-render/field-lab-orbit.gif)

## Verification

```bash
pip install pytest
python -m pytest tools/geospatial/test_native_render.py \
  tools/geospatial/test_native_gif.py tools/geospatial/test_export.py -q
```

**19 tests passed** on Python 3.12, pygfx 0.18.0, wgpu 0.33.0 and Mesa 25.0.7
Lavapipe (CPU Vulkan). Tests cover geometry/asset bindings, static pixels,
rotation conventions, shortest-path interpolation, part pivots, visibility,
decoded GIF timing/loop settings, changing native frames and invalid ranges.

Rendered examples and adapter/hash sidecars are in
[`benchmarks/native-render`](../benchmarks/native-render).
This host lacked system Vulkan drivers and administrator access, so the matching
Debian Mesa package was extracted temporarily and selected with `VK_DRIVER_FILES`.
No driver binaries or host-specific paths are included in the Python package.
The optional rendering dependencies leave the standard-library exporter intact.
