import { canonicalJSON } from '../src/lib/workspace.ts';
import type { SavedScene, SceneBackend } from './scene-backend.ts';
import { SceneToolError } from './mcp-scene-contract.mjs';

/** Allowlisted net changes between immutable snapshots; never expose geometry or field values. */
export function conflictDetails(id: string, expected: number, head: SavedScene, before: SavedScene | null) {
  const changed_instances: { instance_id: string; change: string; fields: string[] }[] = [];
  const scene_fields: string[] = [];
  if (before) {
    const left = new Map(before.document.instances.map(item => [item.id, item]));
    const right = new Map(head.document.instances.map(item => [item.id, item]));
    for (const instance_id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const a = left.get(instance_id), b = right.get(instance_id);
      const fields = !a || !b ? ['presence'] : ['name', 'asset', 'position', 'rotation', 'visible'].filter(field => {
        if (field === 'asset') return a.assetId !== b.assetId || a.cloudVersionId !== b.cloudVersionId;
        const key = field as 'name' | 'position' | 'rotation' | 'visible';
        return canonicalJSON(a[key]) !== canonicalJSON(b[key]);
      });
      if (fields.length) changed_instances.push({ instance_id, change: !a ? 'added' : !b ? 'removed' : 'updated', fields });
    }
    if (before.name !== head.name) scene_fields.push('name');
    for (const key of ['room', 'assets', 'animation'] as const) {
      if (canonicalJSON(before.document[key]) !== canonicalJSON(head.document[key])) scene_fields.push(key);
    }
    if (canonicalJSON(before.document.instances.map(item => item.id)) !== canonicalJSON(head.document.instances.map(item => item.id))) scene_fields.push('instance_order');
  }
  return { scene_id: id, expected_revision: expected, actual_revision: head.revision, current_revision: head.revision,
    applied: false, base_available: !!before, changed_instances, scene_fields, retry: 'refresh_and_reapply' };
}

/** Report a specific rejected head, even if another writer advances it while details are read. */
export async function sceneConflict(backend: SceneBackend, id: string, expected: number, head: SavedScene): Promise<SceneToolError> {
  let before: SavedScene | null = null;
  if (expected > 0) {
    try { before = await backend.read(id, expected); }
    catch (error) { if (!(error instanceof SceneToolError) || error.code !== 'SCENE_UNAVAILABLE') throw error; }
  }
  return new SceneToolError('CONFLICT', 'Scene has changed. Read the current revision, review changed fields, and reapply your edit with a new request_id.', conflictDetails(id, expected, head, before));
}
