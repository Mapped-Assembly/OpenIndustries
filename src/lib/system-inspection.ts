import Ajv from 'ajv';
import manifestSchema from './schemas/forma-binding-manifest-v1.json';
import { digestBytes, type Asset } from './scene';
import type { Workspace } from './workspace';

export type BindingStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'stale' | 'unsupported' | 'not_applicable';
export type SemanticBinding = {
  binding_id: string;
  semantic: { domain: string; artifact_id: string; revision: number; sha256: string; entity_id: string; occurrence_path: string[]; label?: string | null };
  selector?: string | null; role: string; resolution: BindingStatus; fidelity: string; source: string; assumptions: string[];
};
/** Read-only projection of OpenForma's independently owned BindingManifest 1.0. */
export type BindingManifest = {
  schema_version: '1.0'; product_id: string;
  geometry: { artifact_id: string; revision: number; sha256: string; format: string; producer: string; producer_version: string; frame: string; units: string };
  entities: { entity_id: string; selector: string; kind: string; fidelity: string; source: string; verified_from_artifact: boolean }[];
  bindings: SemanticBinding[];
  requirements: { requirement_id: string }[];
  evidence: Record<string, string>;
};
/** Explicit bridge to one scene occurrence; names and array positions are never identifiers. */
export type InspectionTarget = {
  bindingId: string; instanceId: string; assetId: string; sourceDigest: string;
  meshSha256: string; partId?: string;
};
export type InspectionAnnotation = {
  bindingId: string; function?: string;
  properties?: { name: string; value: string | number | boolean; unit?: string; source: string }[];
  connections?: { relationship: string; bindingId: string; source: string }[];
};
export type InspectionSystem = {
  id: string; manifest: BindingManifest; targets: InspectionTarget[]; annotations?: InspectionAnnotation[];
};
export type SystemInspection = { format: 'oi.system-inspection'; version: 1; systems: InspectionSystem[] };
export type InspectionResult = {
  systemId: string; binding: SemanticBinding; status: BindingStatus; message: string;
  targets: { instance: number; part: number }[];
};

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const validateManifest = ajv.compile(manifestSchema);
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items: unknown, maxItems = 1000) => ({ type: 'array', maxItems, items });
const validateInspection = ajv.compile(object({
  format: { const: 'oi.system-inspection' }, version: { const: 1 },
  systems: array(object({
    id: text, manifest: { type: 'object' },
    targets: array(object({ bindingId: text, instanceId: text, assetId: text, sourceDigest: text, meshSha256: hash, partId: text }, ['bindingId', 'instanceId', 'assetId', 'sourceDigest', 'meshSha256'])),
    annotations: array(object({
      bindingId: text, function: text,
      properties: array(object({ name: text, value: { type: ['string', 'number', 'boolean'], maxLength: 2048 }, unit: text, source: text }, ['name', 'value', 'source']), 100),
      connections: array(object({ relationship: text, bindingId: text, source: text }), 100),
    }, ['bindingId'])),
  }, ['id', 'manifest', 'targets']), 50),
}));

/** Validate a bounded sidecar without repairing, dropping, or guessing any mappings. */
export function readSystemInspection(value: unknown): SystemInspection {
  if (JSON.stringify(value)?.length > 4 * 1024 * 1024) throw new Error('System inspection exceeds 4 MiB.');
  const copy = structuredClone(value);
  if (!validateInspection(copy)) throw new Error(`Invalid system inspection: ${ajv.errorsText(validateInspection.errors)}`);
  const inspection = copy as SystemInspection;
  const unique = (ids: string[], label: string): void => {
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} in system inspection.`);
  };
  unique(inspection.systems.map(s => s.id), 'system ID');
  let count = 0;
  for (const system of inspection.systems) {
    if (!validateManifest(system.manifest)) throw new Error(`Invalid OpenForma binding manifest: ${ajv.errorsText(validateManifest.errors)}`);
    const m = system.manifest;
    // Pydantic default_factory values are optional in JSON Schema, without a JSON default.
    m.bindings ??= []; m.entities ??= []; m.requirements ??= []; m.evidence ??= {};
    for (const binding of m.bindings) binding.assumptions ??= [];
    count += m.bindings.length + m.entities.length + m.requirements.length + system.targets.length;
    if (count > 5000) throw new Error('System inspection exceeds 5,000 records.');
    unique(m.bindings.map(b => b.binding_id), 'binding ID');
    unique(m.entities.map(e => e.entity_id), 'geometry entity ID');
    unique(m.requirements.map(r => r.requirement_id), 'requirement ID');
    unique((system.annotations ?? []).map(a => a.bindingId), 'annotation');
    unique(system.targets.map(t => JSON.stringify([t.bindingId, t.instanceId, t.partId ?? null])), 'scene target');
    const ids = new Set(m.bindings.map(b => b.binding_id));
    for (const b of m.bindings) {
      if ((b.resolution === 'resolved' && !b.selector) || (b.resolution === 'not_applicable' && b.selector != null)) throw new Error('Invalid declared binding resolution.');
    }
    for (const t of system.targets) if (!ids.has(t.bindingId)) throw new Error('Scene target references an unknown binding.');
    for (const a of system.annotations ?? []) {
      if (!ids.has(a.bindingId) || a.connections?.some(c => !ids.has(c.bindingId))) throw new Error('Annotation references an unknown binding.');
    }
  }
  return inspection;
}

/** Hash only revision-local geometry, never labels or world placement. Matches Python fixture generator. */
export async function meshFingerprint(asset: Asset): Promise<string> {
  const mesh = asset.parts.map(p => ({ id: p.id, vertices: p.vertices, indices: p.indices }));
  return digestBytes(new TextEncoder().encode(JSON.stringify(mesh)).buffer);
}

/** Resolve supplied bindings against current geometry, keeping source diagnostics and occurrence identity. */
export async function inspectSystem(workspace: Workspace): Promise<InspectionResult[]> {
  if (!workspace.inspection) return [];
  const inspection = readSystemInspection(workspace.inspection);
  const fingerprints = new Map<Asset, Promise<string>>();
  const fingerprint = (asset: Asset): Promise<string> => {
    if (!fingerprints.has(asset)) fingerprints.set(asset, meshFingerprint(asset));
    return fingerprints.get(asset)!;
  };
  const results: InspectionResult[] = [];
  for (const system of inspection.systems) for (const binding of system.manifest.bindings) {
    const result: InspectionResult = { systemId: system.id, binding, status: binding.resolution, message: `Binding declared ${binding.resolution}.`, targets: [] };
    const fail = (status: BindingStatus, message: string): void => { result.status = status; result.message = message; result.targets = []; };
    results.push(result);
    if (binding.resolution !== 'resolved') continue;
    const entities = system.manifest.entities.filter(e => e.selector === binding.selector);
    if (entities.length !== 1) { fail(entities.length ? 'ambiguous' : 'unresolved', 'Selector must identify exactly one entity in the pinned geometry catalog.'); continue; }
    const entity = entities[0];
    if (!['body', 'mesh_group', 'assembly'].includes(entity.kind) || !['physical_body', 'envelope'].includes(binding.role)) {
      fail('unsupported', 'This inspector supports body, mesh-group and assembly selection; exact faces, ports and contacts require a CAD adapter.'); continue;
    }
    if (!entity.verified_from_artifact && system.manifest.geometry.format !== 'synthetic') {
      fail('unsupported', 'The source manifest does not report artifact-verified geometry.'); continue;
    }
    const targets = system.targets.filter(t => t.bindingId === binding.binding_id);
    if (!targets.length) { fail('unresolved', 'No explicit scene occurrence mapping supplied.'); continue; }
    for (const target of targets) {
      const instance = workspace.items.findIndex(i => i.id === target.instanceId);
      const item = workspace.items[instance];
      if (!item || item.missing) { fail('unresolved', 'The mapped instance or its original geometry is missing.'); break; }
      if (item.asset.id !== target.assetId || item.asset.source.digest !== target.sourceDigest || await fingerprint(item.asset) !== target.meshSha256) {
        fail('stale', 'The instance now refers to different source or mesh content. Re-export its binding map.'); break;
      }
      const geometry = system.manifest.geometry;
      const actualDigest = ['scene', 'synthetic'].includes(geometry.format) ? await fingerprint(item.asset)
        : geometry.format === 'step' ? (item.asset.source.kind === 'step' ? item.asset.source.digest : item.asset.cadSource?.sha256) : undefined;
      if (!actualDigest) { fail('unsupported', 'This source format has no verified artifact handoff to the inspector.'); break; }
      if (geometry.sha256 !== actualDigest) { fail('stale', 'Binding manifest geometry digest does not match the imported artifact.'); break; }
      const part = target.partId === undefined ? -1 : item.asset.parts.findIndex(p => p.id === target.partId);
      if (target.partId !== undefined && part < 0) { fail('unresolved', 'Mapped scene part is missing; no name-based substitution was made.'); break; }
      if (!item.visible) { fail('unresolved', 'Mapped instance is hidden. Show it before locating its geometry.'); break; }
      result.targets.push({ instance, part });
      result.message = 'Supplied body mapping matches the pinned source and displayed mesh. Domain properties and physical performance are not independently validated.';
    }
  }
  return results;
}
