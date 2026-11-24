"""Native pygfx live view; renders current authoritative poses without replay."""
from __future__ import annotations

import math
from pathlib import Path
import time
from typing import Any

import numpy as np
import pygfx as gfx
from PIL import Image

from native_mujoco_scene import project_model
from native_physics import Y_FROM_Z
from native_render import build_scene


class LiveViewer:
    """Optional native window/offscreen presentation for a single-owner live host."""

    def __init__(self, runtime: Any, mode: str, fps: float, gif: Path | None = None) -> None:
        """Build visuals once and bind visual groups to current MuJoCo body poses."""
        import json
        start = time.perf_counter()
        self.runtime, self.mode, self.fps, self.gif = runtime, mode, fps, gif
        self.warmed = False
        self.recorded: list[tuple[float, Image.Image]] = []
        view = json.loads((runtime.folder/'render.json').read_text())
        doc, bindings = project_model(runtime.cell.m, set(view['exclude']), view['room'])
        self.scene = build_scene(doc, room_guides=view['roomGuides'])
        groups = {o.name: o for o in self.scene.children}
        self.bindings = [(groups[b['instanceId']], b['body'], b['bodyFromVisual']) for b in bindings]
        if mode == 'window':
            import glfw
            if not glfw.init():
                raise RuntimeError('Native window unavailable: a working desktop display is required; use --view offscreen or headless')
            from rendercanvas.glfw import RenderCanvas, loop
            self.loop = loop
            self.canvas = RenderCanvas(size=(view['width'], view['height']), title='OI live runtime — Space pause, N step, R reset, Escape stop', update_mode='ondemand', max_fps=fps)
            self.canvas.add_event_handler(self.on_key, 'key_down')
            self.canvas.add_event_handler(self.on_close, 'close')
        else:
            from rendercanvas.offscreen import RenderCanvas
            self.canvas = RenderCanvas(size=(view['width'], view['height']), pixel_ratio=1)
        self.renderer = gfx.WgpuRenderer(self.canvas)
        self.camera = gfx.PerspectiveCamera(50, view['width']/view['height'])
        self.update_poses()
        if view['frame'] not in ('all-visible', 'non-world-bodies'):
            raise ValueError('Unknown live framing policy')
        boxes = [obj.get_world_bounding_box() for obj, body, _ in self.bindings if view['frame'] == 'all-visible' or body != 0]
        low, high = np.min([b[0] for b in boxes], axis=0), np.max([b[1] for b in boxes], axis=0)
        sphere = (*((low+high)/2), float(np.linalg.norm(high-low)/2))
        az, el = math.radians(view['azimuth']), math.radians(view['elevation'])
        self.camera.show_object(sphere, view_dir=(-math.sin(az)*math.cos(el), -math.sin(el), -math.cos(az)*math.cos(el)), up=(0, 1, 0), scale=1.5)
        if mode == 'window':
            self.orbit = gfx.OrbitController(self.camera, register_events=self.renderer)
        self.canvas.request_draw(self.paint)
        self.startup_seconds = time.perf_counter()-start

    def update_poses(self) -> None:
        """Apply measured world transforms, including the explicit Z-up/Y-up adapter."""
        with self.runtime.lock:
            positions = self.runtime.cell.d.xpos.copy()
            rotations = self.runtime.cell.d.xmat.copy()
        for obj, body, offset in self.bindings:
            matrix = np.eye(4)
            matrix[:3, :3] = rotations[body].reshape(3, 3); matrix[:3, 3] = positions[body]
            obj.local.matrix = Y_FROM_Z @ matrix @ offset

    def paint(self) -> None:
        """Render the current physics state and count completed render submissions."""
        self.update_poses()
        self.renderer.render(self.scene, self.camera)
        self.runtime.frames.append(time.perf_counter())

    def draw(self) -> None:
        """Submit one live frame; optionally retain a bounded visualization recording."""
        self.canvas.request_draw(self.paint)
        if self.mode == 'window' and not self.warmed:
            self.canvas.force_draw()
            self.warmed = True
        if self.mode == 'offscreen':
            pixels = self.canvas.draw()
            if self.gif and len(self.recorded) < 240:
                # Sample by simulation time so overloaded rendering never invents motion.
                now = float(self.runtime.cell.d.time)
                if not self.recorded or now-self.recorded[-1][0] >= .1:
                    self.recorded.append((now, Image.fromarray(np.asarray(pixels)).convert('RGB')))

    def on_key(self, event: dict[str, Any]) -> None:
        """Route native keyboard input to explicit lifecycle operations."""
        key, runtime = event['key'], self.runtime
        if key == ' ':
            if runtime.state == 'running': runtime.pause()
            elif runtime.state in ('paused', 'ready'): runtime.start()
        elif key.lower() == 'n' and runtime.state in ('ready', 'paused'):
            runtime.step(); self.draw()
        elif key.lower() == 'r':
            runtime.reset(); self.draw()
        elif key == 'Escape':
            runtime.stop(); self.canvas.close()

    def on_close(self, event: dict[str, Any]) -> None:
        """Stop live execution when the native window is closed."""
        if self.runtime.state in ('running', 'paused', 'ready'):
            self.runtime.stop()

    def run(self, max_wall: float) -> None:
        """Schedule physics independently of visual redraws in the native event loop."""
        start = time.perf_counter()
        next_frame = start
        def update() -> None:
            """Pump bounded physics ticks and independently request presentation frames."""
            nonlocal next_frame
            now = time.perf_counter()
            if now-start >= max_wall and self.runtime.state in ('running', 'paused', 'ready'):
                self.runtime.fault('Wall-time execution budget exceeded')
            if now >= next_frame:
                self.draw(); next_frame += max(1, int((now-next_frame)*self.fps)+1)/self.fps
            if self.runtime.state in ('completed', 'fault', 'stopped'):
                self.canvas.close()
                return
            self.loop.call_later(.001, update)
        self.loop.call_later(.001, update)
        self.loop.run()

    def finish(self) -> None:
        """Write captured live-loop frames with simulation-time delays, not synthetic poses."""
        if not self.gif or not self.recorded:
            return
        durations = [max(10, round((b[0]-a[0])*100)*10) for a, b in zip(self.recorded, self.recorded[1:])]
        durations.append(100)
        self.gif.parent.mkdir(parents=True, exist_ok=True)
        self.recorded[0][1].save(self.gif, save_all=True, append_images=[x[1] for x in self.recorded[1:]], duration=durations, loop=0, disposal=2)

    def close(self) -> None:
        """Release the native window/context and recording buffers."""
        self.canvas.close()
        for _, frame in self.recorded:
            frame.close()
