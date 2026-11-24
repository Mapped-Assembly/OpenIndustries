"""Render static portable OI scenes through native WebGPU, without a browser."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import imageio.v3 as iio
import numpy as np
import pygfx as gfx
from rendercanvas.offscreen import RenderCanvas

from export_scene import MAX_BYTES, digest, pose_matrix, validate_scene, vector


def build_scene(document: dict[str, Any], *, base_layout: bool = False) -> gfx.Scene:
    """Adapt normalized OI meshes; animation requires explicit base-layout consent."""
    if not isinstance(document, dict):
        raise ValueError("Scene must be a JSON object")
    if (document.get("format"), document.get("version"), document.get("units"), document.get("upAxis")) != ("astra.scene", 1, "m", "Y"):
        raise ValueError("Expected an astra.scene v1 portable manifest in meters, Y-up")
    room = vector(document.get("room"), "room")
    if any(not 1 <= value <= 100 for value in room):
        raise ValueError("Room dimensions must be between 1 and 100 meters")
    instances = document.get("instances")
    if not isinstance(instances, list):
        raise ValueError("instances must be an array")
    if document.get("animation", {}).get("tracks") and not base_layout:
        raise ValueError("Animation is not supported; pass --base-layout to render the authored base poses")
    bound, _ = validate_scene(document) if instances else ({}, {})
    scene = gfx.Scene()
    scene.add(gfx.Background(None, gfx.BackgroundMaterial("#202833")))
    # Room is an envelope, not authored wall geometry. Show a floor and wire bounds.
    width, depth, height = room
    floor = gfx.Geometry(
        positions=np.array([[-width/2, 0, -depth/2], [-width/2, 0, depth/2],
                            [width/2, 0, depth/2], [width/2, 0, -depth/2]], dtype=np.float32),
        indices=np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32),
    )
    scene.add(gfx.Mesh(floor, gfx.MeshPhongMaterial(color="#55616b", side="both")))
    corners = np.array([[x, y, z] for y in (0, height) for z in (-depth/2, depth/2)
                        for x in (-width/2, width/2)], dtype=np.float32)
    edges = [(a, b) for a in range(8) for b in range(a+1, 8) if (a ^ b) in (1, 2, 4)]
    scene.add(gfx.Line(gfx.Geometry(positions=np.array([corners[i] for edge in edges for i in edge])),
                       gfx.LineSegmentMaterial(color="#8999aa", thickness=1)))
    geometry_cache: dict[tuple[int, str], tuple[gfx.Geometry, gfx.MeshPhongMaterial]] = {}
    for instance in instances:
        if not instance["visible"]:
            continue
        asset = bound[instance["id"]]
        group = gfx.Group(name=instance["id"])
        group.local.matrix = np.asarray(pose_matrix(instance["position"], instance["rotation"]))
        for part in asset["parts"]:
            key = (id(asset), part["id"])
            if key not in geometry_cache:
                geometry = gfx.Geometry(positions=np.asarray(part["vertices"], dtype=np.float32).reshape(-1, 3),
                                        indices=np.asarray(part["indices"], dtype=np.uint32).reshape(-1, 3))
                # OI stores linear RGB; pygfx's public color values use sRGB.
                linear = np.asarray(part.get("color", [0.7, 0.8, 0.75]))
                srgb = np.where(linear <= 0.0031308, 12.92 * linear, 1.055 * linear ** (1/2.4) - 0.055)
                material = gfx.MeshPhongMaterial(color=tuple(srgb), side="both", flat_shading=True)
                geometry_cache[key] = geometry, material
            geometry, material = geometry_cache[key]
            group.add(gfx.Mesh(geometry, material, name=part["id"]))
        scene.add(group)
    scene.add(gfx.AmbientLight(intensity=0.65))
    light = gfx.DirectionalLight(intensity=2)
    light.local.position = (width, height * 2, depth)
    scene.add(light)
    return scene


def render_scene(document: dict[str, Any], *, width: int = 960, height: int = 720,
                 azimuth: float = 35, elevation: float = 30, base_layout: bool = False) -> np.ndarray:
    """Render a fitted perspective view into an RGBA array using native wgpu."""
    if not (64 <= width <= 4096 and 64 <= height <= 4096):
        raise ValueError("Image dimensions must be between 64 and 4096")
    if not math.isfinite(azimuth) or not math.isfinite(elevation) or not 1 <= elevation <= 89:
        raise ValueError("Azimuth must be finite; elevation must be between 1 and 89 degrees")
    scene = build_scene(document, base_layout=base_layout)
    camera = gfx.PerspectiveCamera(50, width / height)
    az, el = math.radians(azimuth), math.radians(elevation)
    camera.show_object(scene, view_dir=(-math.sin(az)*math.cos(el), -math.sin(el), -math.cos(az)*math.cos(el)), up=(0, 1, 0), scale=1.15)
    canvas = RenderCanvas(size=(width, height), pixel_ratio=1)
    try:
        renderer = gfx.WgpuRenderer(canvas)
        canvas.request_draw(lambda: renderer.render(scene, camera))
        return np.asarray(canvas.draw()).copy()
    finally:
        canvas.close()


def main() -> int:
    """Render a portable manifest to PNG and record input/output byte identities."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--azimuth", type=float, default=35)
    parser.add_argument("--elevation", type=float, default=30)
    parser.add_argument("--base-layout", action="store_true")
    args = parser.parse_args()
    try:
        if args.output.suffix.lower() != ".png":
            raise ValueError("Output must have a .png extension")
        if args.scene.resolve() in (args.output.resolve(), args.output.with_suffix('.render.json').resolve()):
            raise ValueError("Output must not overwrite the source scene")
        if args.scene.stat().st_size > MAX_BYTES:
            raise ValueError("Input exceeds the 75 MiB portable scene limit")
        raw = args.scene.read_bytes()
        document = json.loads(raw)
        pixels = render_scene(document, width=args.width, height=args.height, azimuth=args.azimuth,
                              elevation=args.elevation, base_layout=args.base_layout)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        iio.imwrite(args.output, pixels)
        import wgpu
        report = {"backend": "pygfx/wgpu-native", "adapter": dict(wgpu.get_default_device().adapter.info),
                  "input_sha256": digest(raw), "output_sha256": digest(args.output.read_bytes()),
                  "width": args.width, "height": args.height, "azimuth": args.azimuth, "elevation": args.elevation,
                  "base_layout": args.base_layout, "animation_sampled": False,
                  "environment": "presentation floor and wire room envelope; no inferred walls"}
        args.output.with_suffix(".render.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        return 0
    except (ValueError, OSError, TypeError, KeyError, RuntimeError) as error:
        parser.exit(2, f"Render failed: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
