/**
 * SpaceIR v0.1: spatial semantics, evidence and partial geometry.
 * This module has no dependencies on OpenIndustries, Three.js, OpenForma or models.
 */
export const SPACE_IR_SCHEMA = 'mapped-assembly.space-ir' as const;
export const SPACE_IR_VERSION = '0.1.0' as const;
export type Point2 = [number, number];
/** Affine map [x,z] -> [a*x+c*z+tx, b*x+d*z+tz], in meters. */
export type Affine2 = [number, number, number, number, number, number];
export type Frame = { id: string; units: 'm' | 'px'; axes: 'XZ' | 'image_xy'; to_world?: Affine2 };
export type SourceEvidence = {
  id: string; source_id: string; digest_sha256: string; status: 'observed' | 'inferred' | 'confirmed';
  locator?: { page?: number; polygon?: Point2[]; frame_id?: string };
  captured_at?: string;
};
export type Region = {
  id: string; kind: 'room' | 'zone' | 'outdoor' | 'volume';
  label?: string; parent_id?: string; frame_id: string; polygon: Point2[] | null;
  evidence_ids?: string[];
};
export type Boundary = {
  id: string; kind: 'wall' | 'partition' | 'floor' | 'other';
  region_ids: string[]; frame_id: string; path: [Point2, Point2] | null;
  thickness_m?: number | null; height_m?: number | null; evidence_ids?: string[];
};
export type Portal = {
  id: string; kind: 'door' | 'passage' | 'window' | 'gate';
  boundary_id: string; connects: string[]; span: [number, number];
  traversable: boolean; evidence_ids?: string[];
};
export type SpatialRelation = {
  id: string; kind: 'contains' | 'adjacent' | 'connected' | 'overlaps';
  from: string; to: string; via_portal_id?: string; evidence_ids?: string[];
};
export type Occupancy = {
  id: string; region_id: string; frame_id: string; polygon: Point2[] | null;
  external_ref?: { domain: string; provider: string; artifact_id: string; entity_id: string; revision: string };
  evidence_ids?: string[];
};
export type SpatialConstraint = {
  id: string; kind: 'clearance' | 'access'; region_id: string;
  minimum_m: number | null; authority: string; evidence_ids?: string[];
};
export type SpaceIR = {
  schema_id: typeof SPACE_IR_SCHEMA; schema_version: typeof SPACE_IR_VERSION;
  id: string; revision: string;
  /** Scene room bounds are a metric planning envelope, never inferred from image pixels. */
  site: { frame_id: string; width_m: number; depth_m: number; height_m: number } | null;
  frames: Frame[]; regions: Region[]; boundaries: Boundary[]; portals: Portal[];
  spatial_relations: SpatialRelation[]; occupancies: Occupancy[]; constraints: SpatialConstraint[];
  evidence: SourceEvidence[]; unresolved: string[];
};
export type Finding = { code: string; path: string; message: string; severity: 'error' | 'unresolved' };
export type Validation = { valid: boolean; findings: Finding[] };

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 512;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const point = (v: unknown): v is Point2 =>
  Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e7);
function orientation(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function between(a: Point2, b: Point2, c: Point2): boolean {
  return Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
}
/** Detect touching as well as proper intersections of nonadjacent polygon edges. */
function intersects(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (o1 === 0 && between(a, b, c)) || (o2 === 0 && between(a, b, d)) ||
    (o3 === 0 && between(c, d, a)) || (o4 === 0 && between(c, d, b));
}
/** Polygons are implicitly closed; do not duplicate the first vertex at the end. */
export function polygonValid(value: unknown): value is Point2[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 10000 || !value.every(point)) return false;
  const ps = value as Point2[];
  const twiceArea = ps.reduce((sum, p, i) => sum + p[0] * ps[(i + 1) % ps.length][1] -
    p[1] * ps[(i + 1) % ps.length][0], 0);
  if (Math.abs(twiceArea) < 1e-9) return false;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i], b = ps[(i + 1) % ps.length];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    for (let j = i + 1; j < ps.length; j++) {
      if (j === i + 1 || (i === 0 && j === ps.length - 1)) continue;
      if (intersects(a, b, ps[j], ps[(j + 1) % ps.length])) return false;
    }
  }
  return true;
}
function validAffine(v: unknown): v is Affine2 {
  return Array.isArray(v) && v.length === 6 &&
    v.every(n => typeof n === 'number' && Number.isFinite(n)) &&
    Math.abs(v[0] * v[3] - v[1] * v[2]) > 1e-12;
}

/** An uncalibrated pixel frame explicitly has no metric transform. */
export function resolveMetricPoint(frame: Frame, p: Point2): Point2 | null {
  if (!point(p)) return null;
  if (frame.id === 'world' && frame.units === 'm' && frame.axes === 'XZ') return [...p];
  if (!frame.to_world || !validAffine(frame.to_world)) return null;
  const [a, b, c, d, tx, tz] = frame.to_world;
  return [a * p[0] + c * p[1] + tx, b * p[0] + d * p[1] + tz];
}

/** Canonical stable JSON for diffs, artifact fingerprints and regression fixtures. */
export function canonicalSpaceJSON(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) :
    record(v) ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => [k, normalize(v[k])])) : v;
  return JSON.stringify(normalize(value));
}

/** Pure boundary, topology, frame and provenance validation. Unknown metrics do not invalidate topology. */
export function validateSpaceIR(value: unknown): Validation {
  const findings: Finding[] = [];
  const report = (code: string, path: string, message: string, severity: Finding['severity'] = 'error') =>
    findings.push({ code, path, message, severity });
  if (!record(value)) return { valid: false, findings: [{ code: 'DOCUMENT', path: '$', message: 'SpaceIR must be an object.', severity: 'error' }] };
  if (value.schema_id !== SPACE_IR_SCHEMA || value.schema_version !== SPACE_IR_VERSION)
    report('SCHEMA', '$', 'Unsupported SpaceIR schema or version.');
  if (!nonempty(value.id) || !nonempty(value.revision)) report('IDENTITY', '$', 'Stable id and revision are required.');
  const arrays = ['frames', 'regions', 'boundaries', 'portals', 'spatial_relations', 'occupancies', 'constraints', 'evidence', 'unresolved'] as const;
  for (const key of arrays) if (!Array.isArray(value[key]) || (value[key] as unknown[]).length > 10000)
    report('COLLECTION', key, 'Collection required and limited to 10000 entries.');
  if (findings.some(f => f.code === 'COLLECTION')) return { valid: false, findings };
  const doc = value as unknown as SpaceIR;
  const idMap = new Map<string, string>();
  const ids = new Map<string, Set<string>>();
  for (const key of arrays.filter(k => k !== 'unresolved')) {
    const seen = new Set<string>(); ids.set(key, seen);
    for (const [i, item] of (doc[key] as unknown[]).entries()) {
      const path = key + '[' + i + ']';
      if (!record(item) || !nonempty(item.id)) { report('ID', path, 'An entity must have a stable id.'); continue; }
      if (seen.has(item.id)) report('DUPLICATE_ID', path, 'Duplicate entity ID in ' + key + '.');
      if (idMap.has(item.id)) report('DUPLICATE_ID', path, 'Entity ID already used by ' + idMap.get(item.id) + '.');
      seen.add(item.id); idMap.set(item.id, key);
    }
  }
  const has = (collection: string, id: unknown) => typeof id === 'string' && !!ids.get(collection)?.has(id);
  const requireRef = (collection: string, id: unknown, path: string) => {
    if (!has(collection, id)) report('DANGLING_REFERENCE', path, 'Unknown ' + collection + ' reference.');
  };
  const frames = new Map<string, Frame>();
  for (const [i, frame] of doc.frames.entries()) {
    if (!record(frame)) { report('FRAME', 'frames[' + i + ']', 'Invalid frame.'); continue; }
    if (!['m', 'px'].includes(frame.units) || !['XZ', 'image_xy'].includes(frame.axes) ||
      (frame.id === 'world' && (frame.units !== 'm' || frame.axes !== 'XZ' || frame.to_world !== undefined)))
      report('FRAME', 'frames[' + i + ']', 'Unit/axis mismatch.');
    if (frame.to_world !== undefined && !validAffine(frame.to_world))
      report('TRANSFORM', 'frames[' + i + ']', 'Transform must be finite and invertible.');
    if (typeof frame.id === 'string') frames.set(frame.id, frame as Frame);
  }
  if (doc.site !== null) {
    const site = doc.site;
    if (!record(site) || !positive(site.width_m) || !positive(site.depth_m) || !positive(site.height_m) ||
      site.width_m < 1 || site.depth_m < 1 || site.height_m < 1 || site.width_m > 100 || site.depth_m > 100 || site.height_m > 100) {
      report('SITE', 'site', 'A supported metric site requires dimensions between 1 and 100 m.');
    } else {
      requireRef('frames', site.frame_id, 'site.frame_id');
      const frame = frames.get(site.frame_id as string);
      if (frame && !resolveMetricPoint(frame, [0, 0])) report('UNSCALED', 'site', 'Site frame has no metric calibration.');
    }
  } else report('UNSCALED', 'site', 'Site dimensions are unknown.', 'unresolved');
  function geometry(v: { frame_id: string; polygon?: Point2[] | null }, path: string) {
    requireRef('frames', v.frame_id, path + '.frame_id');
    if (v.polygon === null) report('UNKNOWN_GEOMETRY', path + '.polygon', 'Geometry not supplied.', 'unresolved');
    else if (!polygonValid(v.polygon)) report('POLYGON', path + '.polygon', 'Invalid or self-intersecting polygon.');
  }
  for (const [i, region] of doc.regions.entries()) {
    const path = 'regions[' + i + ']';
    if (!record(region)) { report('REGION', path, 'Invalid region.'); continue; }
    if (!['room','zone','outdoor','volume'].includes(region.kind)) report('REGION_KIND', path, 'Unknown region kind.');
    geometry(region, path);
    if (region.parent_id !== undefined) requireRef('regions', region.parent_id, path + '.parent_id');
  }
  const parents = new Map(doc.regions.filter(r => record(r) && typeof r.id === 'string')
    .map(r => [r.id, r.parent_id]));
  for (const [id] of parents) {
    const path = new Set<string>(); let current: string | undefined = id;
    while (current) {
      if (path.has(current)) { report('PARENT_CYCLE', 'regions.' + id, 'Region parent graph contains a cycle.'); break; }
      path.add(current); current = parents.get(current);
    }
  }
  const boundaries = new Map<string, Boundary>();
  for (const [i, boundary] of doc.boundaries.entries()) {
    const path = 'boundaries[' + i + ']';
    if (!record(boundary)) { report('BOUNDARY', path, 'Invalid boundary.'); continue; }
    if (!['wall','partition','floor','other'].includes(boundary.kind)) report('BOUNDARY_KIND', path, 'Unknown boundary type.');
    requireRef('frames', boundary.frame_id, path + '.frame_id');
    if (!Array.isArray(boundary.region_ids) || boundary.region_ids.length < 1 || boundary.region_ids.length > 2 ||
      new Set(boundary.region_ids).size !== boundary.region_ids.length)
      report('BOUNDARY_REGIONS', path, 'Boundary must reference one or two distinct regions.');
    else for (const id of boundary.region_ids) requireRef('regions', id, path + '.region_ids');
    if (boundary.path === null) report('UNKNOWN_GEOMETRY', path + '.path', 'Boundary path unknown.', 'unresolved');
    else if (!Array.isArray(boundary.path) || boundary.path.length !== 2 || !boundary.path.every(point) ||
      (boundary.path[0][0] === boundary.path[1][0] && boundary.path[0][1] === boundary.path[1][1]))
      report('BOUNDARY_PATH', path, 'Boundary needs two distinct finite points.');
    for (const k of ['height_m','thickness_m'] as const) if (boundary[k] !== undefined && boundary[k] !== null && !positive(boundary[k]))
      report('BOUNDARY_DIMENSION', path + '.' + k, 'Dimension must be positive or unknown.');
    if (typeof boundary.id === 'string') boundaries.set(boundary.id, boundary as Boundary);
  }
  const portals = new Map<string, Portal>();
  for (const [i, portal] of doc.portals.entries()) {
    const path = 'portals[' + i + ']';
    if (!record(portal)) { report('PORTAL', path, 'Invalid portal.'); continue; }
    if (!['door','passage','window','gate'].includes(portal.kind) ||
      typeof portal.traversable !== 'boolean' || (portal.kind === 'window' && portal.traversable))
      report('PORTAL_SEMANTICS', path, 'Invalid portal type/traversal semantics.');
    requireRef('boundaries', portal.boundary_id, path + '.boundary_id');
    if (!Array.isArray(portal.span) || portal.span.length !== 2 ||
      !portal.span.every(x => typeof x === 'number' && Number.isFinite(x)) ||
      !(0 <= portal.span[0] && portal.span[0] < portal.span[1] && portal.span[1] <= 1))
      report('PORTAL_SPAN', path, 'Span must be increasing within [0,1].');
    const b = boundaries.get(portal.boundary_id);
    if (!Array.isArray(portal.connects) || portal.connects.length < 1 || portal.connects.length > 2 ||
      new Set(portal.connects).size !== portal.connects.length ||
      (b && portal.connects.some((id: string) => !b.region_ids.includes(id))))
      report('PORTAL_REGIONS', path, 'Portal regions must be distinct regions on the parent boundary.');
    else for (const id of portal.connects) requireRef('regions', id, path + '.connects');
    if (typeof portal.id === 'string') portals.set(portal.id, portal as Portal);
  }
  for (const [i, relation] of doc.spatial_relations.entries()) {
    const path = 'spatial_relations[' + i + ']';
    if (!record(relation)) { report('RELATION', path, 'Invalid relation.'); continue; }
    if (!['contains','adjacent','connected','overlaps'].includes(relation.kind)) report('RELATION_KIND', path, 'Unknown relation kind.');
    requireRef('regions', relation.from, path + '.from');
    requireRef('regions', relation.to, path + '.to');
    if (relation.from === relation.to) report('RELATION_SELF', path, 'Self relation not allowed.');
    if (relation.kind === 'connected') {
      requireRef('portals', relation.via_portal_id, path + '.via_portal_id');
      const p = portals.get(relation.via_portal_id as string);
      if (p && (!p.traversable || !p.connects.includes(relation.from) || !p.connects.includes(relation.to)))
        report('NOT_TRAVERSABLE', path, 'Connection requires a traversable portal between both regions.');
    } else if (relation.via_portal_id !== undefined) report('RELATION_PORTAL', path, 'Only connected spatial_relations use via_portal_id.');
  }
  for (const [i, occupancy] of doc.occupancies.entries()) {
    const path = 'occupancies[' + i + ']';
    if (!record(occupancy)) { report('OCCUPANCY', path, 'Invalid occupancy.'); continue; }
    requireRef('regions', occupancy.region_id, path + '.region_id');
    geometry(occupancy, path);
    if (occupancy.external_ref !== undefined &&
      (!record(occupancy.external_ref) || !['domain','provider','artifact_id','entity_id','revision'].every(k => nonempty(occupancy.external_ref![k as keyof typeof occupancy.external_ref]))))
      report('EXTERNAL_REF', path, 'External artifact reference must be fully qualified.');
  }
  for (const [i, constraint] of doc.constraints.entries()) {
    const path = 'constraints[' + i + ']';
    if (!record(constraint)) { report('CONSTRAINT', path, 'Invalid constraint.'); continue; }
    requireRef('regions', constraint.region_id, path + '.region_id');
    if (!['clearance','access'].includes(constraint.kind) || !nonempty(constraint.authority) ||
      (constraint.minimum_m !== null && !positive(constraint.minimum_m)))
      report('CONSTRAINT', path, 'Constraint needs source authority and a positive or unknown metric value.');
  }
  for (const [i, ev] of doc.evidence.entries()) {
    if (!record(ev) || !nonempty(ev.source_id) || !/^[0-9a-f]{64}$/i.test(String(ev.digest_sha256)) ||
      !['observed','inferred','confirmed'].includes(ev.status))
      report('EVIDENCE', 'evidence[' + i + ']', 'Evidence requires source ID, SHA-256 and status.');
    if (ev?.locator !== undefined && (!record(ev.locator) ||
      (ev.locator.frame_id !== undefined && !has('frames', ev.locator.frame_id)) ||
      (ev.locator.page !== undefined && (!Number.isInteger(ev.locator.page) || ev.locator.page < 1)) ||
      (ev.locator.polygon !== undefined && !polygonValid(ev.locator.polygon))))
      report('EVIDENCE_LOCATOR', 'evidence[' + i + ']', 'Invalid source locator.');
  }
  for (const key of ['regions','boundaries','portals','spatial_relations','occupancies','constraints'] as const)
    for (const [i, item] of doc[key].entries()) if (record(item) && item.evidence_ids !== undefined) {
      if (!Array.isArray(item.evidence_ids)) report('EVIDENCE_REF', key + '[' + i + ']', 'Evidence IDs must be an array.');
      else for (const id of item.evidence_ids) requireRef('evidence', id, key + '[' + i + '].evidence_ids');
    }
  if (!doc.unresolved.every(nonempty)) report('UNKNOWN', 'unresolved', 'Unknown identifiers must be nonempty strings.');
  for (const [id, frame] of frames) if (id !== 'world' && frame.units === 'px' && !frame.to_world)
    report('UNSCALED', 'frames.' + id, 'Pixel frame has no metric calibration.', 'unresolved');
  return { valid: findings.every(f => f.severity !== 'error'), findings };
}

export function parseSpaceIR(value: unknown): SpaceIR {
  const validation = validateSpaceIR(value);
  if (!validation.valid) throw new Error(validation.findings.filter(f => f.severity === 'error')
    .map(f => f.code + '@' + f.path).join('; '));
  return value as SpaceIR;
}
/** Traverse only explicit, verified traversable portal connections; never infer from adjacency. */
export function accessibleRegions(space: SpaceIR, start: string): string[] {
  if (!space.regions.some(r => r.id === start)) return [];
  const seen = new Set([start]), queue = [start];
  for (const current of queue) for (const portal of space.portals) {
    if (!portal.traversable || !portal.connects.includes(current)) continue;
    for (const other of portal.connects) if (!seen.has(other)) { seen.add(other); queue.push(other); }
  }
  return [...seen];
}
/** Minimal externally discoverable provider metadata, no runtime dependency on OpenForma. */
export const SPACE_IR_PROVIDER = Object.freeze({
  domain: 'space', provider: 'openindustries', provider_version: '0.1.0',
  schema_id: SPACE_IR_SCHEMA, schema_versions: [SPACE_IR_VERSION],
  capabilities: ['validate', 'serialize', 'resolve_geometry', 'compile_scene'],
  required_context: ['spatial_observations'],
});
