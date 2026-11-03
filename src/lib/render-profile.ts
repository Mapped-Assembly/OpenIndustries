/** View/backend shader and rasterization configuration; never scene semantics. */
export type RenderProfile = 'lite' | 'detailed';

/** Restrict externally supplied render profiles rather than silently degrading. */
export function parseRenderProfile(input: unknown): RenderProfile {
  if (input === 'lite' || input === 'detailed') return input;
  throw new Error('Unsupported render profile. Use lite or detailed.');
}

/** Bound display pixel density without changing scene geometry or camera pose. */
export function pixelRatioForProfile(profile: RenderProfile, deviceRatio: number): number {
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return 1;
  return Math.min(deviceRatio, profile === 'lite' ? 1 : 2);
}

/** CPU-side frame instrumentation. This does not pretend to measure GPU execution. */
export type LiteRenderMetrics = {
  profile: RenderProfile;
  frameCount: number;
  lastCpuFrameMs: number;
  maxCpuFrameMs: number;
  drawCalls: number;
  renderedTriangles: number;
  gpuGeometries: number;
  gpuTextures: number;
};
