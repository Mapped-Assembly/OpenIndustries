import { BoxGeometry } from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { finalizeAsset, type Part, type Vec3 } from '../src/lib/scene.ts';
import { meshFingerprint, readSystemInspection } from '../src/lib/system-inspection.ts';
import { emptyWorkspace } from '../src/lib/workspace.ts';
import { oiProjectJSON } from '../src/lib/project-files.ts';

/** Reproducible, explicitly illustrative pump–tank–irrigation scene; no performance predictions. */
export async function inspectorFixture() {
  const specs: { id: string; name: string; size: Vec3; at: Vec3; color: Vec3 }[] = [
    { id: 'tank', name: 'Water tank', size: [1, 1.5, 1], at: [-1.4, .75, 0], color: [.2, .48, .65] },
    { id: 'pump', name: 'Irrigation pump', size: [.6, .5, .5], at: [0, .25, 0], color: [.75, .46, .18] },
    { id: 'bed', name: 'Irrigation bed', size: [1.4, .3, 1.4], at: [1.5, .15, 0], color: [.3, .55, .25] },
  ];
  const parts: Part[] = specs.map(s => {
    const geometry = new BoxGeometry(...s.size); geometry.translate(...s.at);
    const part = { id: s.id, name: s.name, vertices: Array.from(geometry.attributes.position.array), indices: Array.from(geometry.index!.array), color: s.color, metadata: { representation: 'Illustrative envelope, not supplied CAD' } };
    geometry.dispose(); return part;
  });
  const asset = finalizeAsset({ id: 'irrigation-demo', name: 'Irrigation station', parts,
    source: { kind: 'generated', filename: 'irrigation-demo', digest: 'pending', generator: 'oi-fixture' },
    hierarchy: { id: 'root', name: 'Station', partIds: parts.map(p => p.id), children: [] },
    warnings: ['Synthetic body envelopes and illustrative specifications. No measured performance or verified plumbing.'],
  });
  const digest = await meshFingerprint(asset); asset.source.digest = digest;
  const workspace = emptyWorkspace(); workspace.room = [9, 7, 3];
  workspace.items = [{ id: 'station-01', name: asset.name, asset, position: [0, 0, 0], rotation: [0, 0, 0], visible: true }];
  workspace.inspection = readSystemInspection({ format: 'oi.system-inspection', version: 1, systems: [{ id: 'irrigation',
    manifest: { schema_version: '1.0', product_id: 'irrigation-demo',
      geometry: { artifact_id: 'irrigation-mesh', revision: 1, sha256: digest, format: 'synthetic', producer: 'OpenIndustries fixture', producer_version: '1', frame: 'OI Y-up', units: 'm' },
      entities: specs.map(s => ({ entity_id: s.id, selector: s.id, kind: 'body', fidelity: 'envelope', source: 'authored', verified_from_artifact: false })),
      bindings: specs.map(s => ({ binding_id: s.id, semantic: { domain: 'ProcessIR', artifact_id: 'illustrative-irrigation-notes', revision: 1, sha256: 'a'.repeat(64), entity_id: s.id, occurrence_path: ['station-01', s.id], label: s.name },
        selector: s.id, role: 'envelope', resolution: 'resolved', fidelity: 'envelope', source: 'authored', assumptions: ['Synthetic fixture; domain hash is an illustrative reference, not an imported ProcessIR document.'] })),
      evidence: { fixture: 'scripts/system-inspector-fixture.ts; synthetic authored example, 2026-11-03' },
    },
    targets: specs.map(s => ({ bindingId: s.id, instanceId: 'station-01', assetId: asset.id, sourceDigest: digest, meshSha256: digest, partId: s.id })),
    annotations: [
      { bindingId: 'tank', function: 'Stores the modeled irrigation water supply.', properties: [{ name: 'Nominal capacity', value: 100, unit: 'L', source: 'Illustrative design assumption; not derived from envelope volume.' }], connections: [{ relationship: 'Supplies', bindingId: 'pump', source: 'Authored conceptual process topology.' }] },
      { bindingId: 'pump', function: 'Transfers water from the tank to the irrigation bed.', properties: [{ name: 'Electrical demand', value: 20, unit: 'W', source: 'Illustrative input assumption, not a measured device specification.' }], connections: [{ relationship: 'Intake from', bindingId: 'tank', source: 'Authored conceptual process topology.' }, { relationship: 'Discharges to', bindingId: 'bed', source: 'Authored conceptual process topology.' }] },
      { bindingId: 'bed', function: 'Receives irrigation water.', properties: [{ name: 'Required flow', value: 'Unknown', source: 'No irrigation schedule supplied.' }] },
    ],
  }] });
  return workspace;
}

if (process.argv.includes('--write')) {
  await mkdir('public/examples', { recursive: true });
  await writeFile('public/examples/system-inspector.oi.json', oiProjectJSON(await inspectorFixture()) + '\n');
  console.log('Wrote portable synthetic system inspector example.');
}
