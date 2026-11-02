import { BoxGeometry } from 'three';
import { finalizeAsset, type Asset, type Vec3 } from './scene';
import { emptyWorkspace, type Workspace } from './workspace';
import {
  canonicalSpaceJSON, parseSpaceIR, resolveMetricPoint,
  type SpaceIR, type Boundary, type Point2, type Finding,
} from '../../packages/space-ir/src/index';

export type SpaceCompileDiagnostic = { code: string; entity_id: string; message: string };
export type CompiledSpace = {
  workspace: Workspace;
  source_sha256: string;
  bindings: { instance_id: string; entity_id: string; source_revision: string }[];
  diagnostics: SpaceCompileDiagnostic[];
};

export class SpaceCompilationError extends Error {
  constructor(readonly code: string, readonly findings: Finding[] | SpaceCompileDiagnostic[] = []) {
    super(code + (findings.length ? ': ' + findings.map(f => 'message' in f ? f.message : '').join('; ') : ''));
    this.name = 'SpaceCompilationError';
  }
}
async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function meterPoint(space: SpaceIR, frameId: string, p: Point2): Point2 | null {
  const frame = space.frames.find(f => f.id === frameId);
  return frame ? resolveMetricPoint(frame, p) : null;
}
function lerp(a: Point2, b: Point2, t: number): Point2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/** Construct one truthful, bounded wall segment with an explicit source binding. */
function wallAsset(boundary: Boundary, segment: number, length: number, height: number, thick: number, digest: string, space: SpaceIR): Asset {
  const id = `spaceir:${space.id}:${boundary.id}:${segment}`;
  const box = new BoxGeometry(length, height, thick);
  const partId = id + '/geometry';
  try {
    return finalizeAsset({
      id, name: `${boundary.kind} ${boundary.id} / ${segment}`,
      source: { kind: 'generated', generator: 'oi-fixture', filename: `space-ir:${space.id}@${space.revision}`, digest },
      parts: [{
        id: partId, name: 'SpaceIR generated planning geometry',
        vertices: Array.from(box.attributes.position.array),
        indices: Array.from(box.index!.array),
        color: [.48, .66, .64],
        metadata: {
          representation: 'SpaceIR boundary (not compliance-validated)',
          spaceir_document: space.id, spaceir_revision: space.revision,
          spaceir_entity: boundary.id, spaceir_schema: space.schema_version,
          source_sha256: digest,
        },
      }],
      hierarchy: { id: id + '/root', name: boundary.id, partIds: [partId], children: [] },
      warnings: ['Spatial planning geometry derived from SpaceIR. Not surveyed or code-certified.'],
    });
  } finally { box.dispose(); }
}

/**
 * Explicit one-way, deterministic SpaceIR -> native OI Workspace compiler.
 * The source document is never mutated and the result is edited/serialized through
 * existing OI scene APIs. No renderer or second scene store is introduced.
 */
export async function compileSpaceIR(input: unknown): Promise<CompiledSpace> {
  let space: SpaceIR;
  try { space = parseSpaceIR(input); }
  catch (error) { throw new SpaceCompilationError('INVALID_SPACE_IR', [{
    code: 'INVALID_SPACE_IR', entity_id: 'document', message: String(error),
  }]); }
  if (!space.site) throw new SpaceCompilationError('UNSCALED_SITE', [{
    code: 'UNSCALED_SITE', entity_id: space.id, message: 'Metric site dimensions required; pixel-only drawings cannot be compiled.' }]);
  const origin = meterPoint(space, space.site.frame_id, [0, 0]);
  if (!origin) throw new SpaceCompilationError('UNSCALED_SITE', [{
    code: 'UNSCALED_SITE', entity_id: space.id, message: 'Site frame must be calibrated to meters.' }]);
  const { width_m, depth_m, height_m } = space.site;
  const room: Vec3 = [width_m, depth_m, height_m];
  const source_sha256 = await sha256(canonicalSpaceJSON(space));
  const workspace: Workspace = { ...emptyWorkspace(), room, items: [] };
  const diagnostics: SpaceCompileDiagnostic[] = [];
  const bindings: CompiledSpace['bindings'] = [];
  const inside = (p: Point2): boolean =>
    Math.abs(p[0] - origin[0]) <= width_m / 2 + .00001 &&
    Math.abs(p[1] - origin[1]) <= depth_m / 2 + .00001;
  for (const boundary of space.boundaries) {
    if (!boundary.path) {
      diagnostics.push({ code: 'UNKNOWN_BOUNDARY_GEOMETRY', entity_id: boundary.id, message: 'No boundary path; omitted rather than inventing geometry.' });
      continue;
    }
    if (!boundary.thickness_m || !boundary.height_m) {
      diagnostics.push({ code: 'UNKNOWN_BOUNDARY_DIMENSIONS', entity_id: boundary.id, message: 'Wall thickness/height unknown; geometry not generated.' });
      continue;
    }
    if (boundary.kind === 'floor' || boundary.kind === 'other') {
      diagnostics.push({ code: 'UNSUPPORTED_BOUNDARY_KIND', entity_id: boundary.id, message: 'Only explicit walls and partitions compile to 3D geometry in v0.1.' });
      continue;
    }
    const a = meterPoint(space, boundary.frame_id, boundary.path[0]);
    const b = meterPoint(space, boundary.frame_id, boundary.path[1]);
    if (!a || !b) {
      diagnostics.push({ code: 'UNSCALED_BOUNDARY', entity_id: boundary.id, message: 'No metric frame calibration for boundary.' });
      continue;
    }
    if (!inside(a) || !inside(b) || boundary.height_m > height_m) {
      throw new SpaceCompilationError('OUTSIDE_SITE', [{
        code: 'OUTSIDE_SITE', entity_id: boundary.id,
        message: 'Boundary exceeds declared metric site bounds or height. No placement was produced.',
      }]);
    }
    const spans = space.portals.filter(p => p.boundary_id === boundary.id)
      .map(p => ({ id: p.id, lo: p.span[0], hi: p.span[1] }))
      .sort((x, y) => x.lo - y.lo);
    for (let i = 1; i < spans.length; i++) if (spans[i].lo < spans[i - 1].hi)
      throw new SpaceCompilationError('OVERLAPPING_PORTALS', [{
        code: 'OVERLAPPING_PORTALS', entity_id: boundary.id, message: 'Overlapping portal openings require review.',
      }]);
    let previous = 0;
    const segments: [number, number][] = [];
    for (const span of spans) {
      if (span.lo > previous) segments.push([previous, span.lo]);
      previous = span.hi;
    }
    if (previous < 1) segments.push([previous, 1]);
    if (spans.length) diagnostics.push({
      code: 'OPENING_ONLY', entity_id: boundary.id,
      message: 'Openings are modeled as full-height gaps. Door leaves, lintels and glazing are not generated.',
    });
    for (const [index, [t0, t1]] of segments.entries()) {
      const start = lerp(a, b, t0), end = lerp(a, b, t1);
      const dx = end[0] - start[0], dz = end[1] - start[1];
      const length = Math.hypot(dx, dz);
      if (length <= 1e-6) continue;
      const assetDigest = await sha256(canonicalSpaceJSON({
        document: space.id, revision: space.revision, boundary: boundary.id,
        segment: index, start, end, height: boundary.height_m, thickness: boundary.thickness_m,
      }));
      const asset = wallAsset(boundary, index, length, boundary.height_m, boundary.thickness_m, assetDigest, space);
      const instanceId = asset.id + '/instance';
      workspace.items.push({
        id: instanceId, name: asset.name, asset, visible: true,
        position: [(start[0] + end[0]) / 2 - origin[0], 0, (start[1] + end[1]) / 2 - origin[1]],
        rotation: [0, -Math.atan2(dz, dx) * 180 / Math.PI, 0],
      });
      bindings.push({ instance_id: instanceId, entity_id: boundary.id, source_revision: space.revision });
    }
  }
  for (const region of space.regions) if (!region.polygon)
    diagnostics.push({ code: 'UNKNOWN_REGION_GEOMETRY', entity_id: region.id, message: 'Region topology retained in source; no metric geometry.' });
  for (const occupancy of space.occupancies)
    diagnostics.push({ code: 'UNCOMPILED_OCCUPANCY', entity_id: occupancy.id, message: 'External equipment placements require explicit asset resolution.' });
  for (const unknown of space.unresolved)
    diagnostics.push({ code: 'UNRESOLVED_SOURCE', entity_id: unknown, message: 'Unresolved source assertion retained as diagnostic.' });
  return { workspace, source_sha256, bindings, diagnostics };
}
