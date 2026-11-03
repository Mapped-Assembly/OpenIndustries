import { useEffect, useState } from 'react';
import { inspectSystem, type InspectionResult } from '../lib/system-inspection';
import type { Workspace } from '../lib/workspace';
import './system-inspector.css';

type Props = { selectionVersion: number; workspace: Workspace; selected: number; selectedPart: number; onSelect: (instance: number, part: number) => void };

/** Read-only semantic navigation over the same selection state as the scene viewport. */
export function SystemInspector({ selectionVersion, workspace, selected, selectedPart, onSelect }: Props) {
  const [state, setState] = useState<{ workspace: Workspace; results: InspectionResult[]; error?: string }>();
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void inspectSystem(workspace).then(results => {
      if (!cancelled) setState({ workspace, results });
    }).catch((error: Error) => {
      if (!cancelled) setState({ workspace, results: [], error: error.message });
    });
    return () => { cancelled = true; };
  }, [workspace]);
  // Geometry selection always takes precedence over an earlier semantic selection.
  useEffect(() => { setActive(null); }, [workspace, selected, selectedPart, selectionVersion]);
  if (!workspace.inspection) return <section aria-label="System inspector" className="system-inspector">
    <h3>System inspector</h3><p>No semantic bindings supplied. Geometry remains usable.</p>
    <small>Import an oi.system-inspection JSON sidecar with explicit scene mappings, or an OI project containing one.</small><a href="/examples/system-inspector.oi.json" download>Download example project</a>
  </section>;
  const results = state?.workspace === workspace ? state.results : undefined;
  if (!results) return <section aria-label="System inspector"><h3>System inspector</h3><p role="status">Checking source and geometry bindings…</p></section>;
  if (state?.error) return <section aria-label="System inspector"><h3>System inspector</h3><p role="alert">{state.error}</p></section>;
  const key = (row: InspectionResult): string => JSON.stringify([row.systemId, row.binding.binding_id]);
  const associated = (row: InspectionResult): boolean => {
    const system = workspace.inspection!.systems.find(s => s.id === row.systemId)!;
    const item = workspace.items[selected];
    return !!item && system.targets.some(t => t.bindingId === row.binding.binding_id && t.instanceId === item.id
      && (selectedPart < 0 || t.partId === undefined || t.partId === item.asset.parts[selectedPart]?.id));
  };
  const selectedRows = results.filter(associated);
  const current = results.find(r => key(r) === active) ?? selectedRows[0];
  const system = current && workspace.inspection.systems.find(s => s.id === current.systemId)!;
  const annotation = system?.annotations?.find(a => a.bindingId === current?.binding.binding_id);
  return <section aria-label="System inspector" className="system-inspector">
    <h3>System inspector</h3>
    <p>{workspace.items[selected] ? `${selectedRows.length} semantic association(s) for this selection.` : 'Select a system component to inspect or locate it.'}</p>
    <div className="system-binding-list" aria-label="Semantic components">
      {results.map(row => <button key={key(row)} aria-pressed={current === row} onClick={() => setActive(key(row))}>
        <strong>{row.binding.semantic.label ?? row.binding.semantic.entity_id}</strong>
        <small>{row.binding.semantic.domain} · {row.status}{associated(row) ? ' · selected geometry' : ''}</small>
      </button>)}
    </div>
    {current && system && <article aria-label="Binding details" data-binding-status={current.status}>
      <h4>{current.binding.semantic.label ?? current.binding.semantic.entity_id}</h4>
      <p className="notice"><b>{current.status.toUpperCase()}</b> — {current.message}</p>
      {current.targets.map(target => <button className="locate-binding" key={`${target.instance}:${target.part}`} onClick={() => onSelect(target.instance, target.part)}>
        Locate {workspace.items[target.instance].name}{target.part >= 0 ? ` / ${workspace.items[target.instance].asset.parts[target.part].name}` : ''}
      </button>)}
      <dl className="project-meta">
        <div><dt>Domain</dt><dd>{current.binding.semantic.domain}</dd></div>
        <div><dt>Entity</dt><dd>{current.binding.semantic.entity_id}</dd></div>
        <div><dt>Occurrence</dt><dd>{current.binding.semantic.occurrence_path.join(' / ')}</dd></div>
        <div><dt>Role / fidelity</dt><dd>{current.binding.role} / {current.binding.fidelity}</dd></div>
        <div><dt>Origin</dt><dd>{current.binding.source}</dd></div>
        <div><dt>Domain artifact</dt><dd>{current.binding.semantic.artifact_id} · revision {current.binding.semantic.revision}</dd></div>
        <div><dt>Geometry artifact</dt><dd>{system.manifest.geometry.artifact_id} · revision {system.manifest.geometry.revision}</dd></div>
      </dl>
      {annotation && <div className="system-annotations"><h4>Supplied engineering notes</h4><small>Authored annotations; not live measurements or independently validated domain results.</small>
        {annotation.function && <p>{annotation.function}</p>}
        {!!annotation.properties?.length && <dl className="project-meta">{annotation.properties.map((p, i) => <div key={i}><dt>{p.name}</dt><dd>{String(p.value)} {p.unit}<small>Source: {p.source}</small></dd></div>)}</dl>}
        {!!annotation.connections?.length && <><h4>Declared connections</h4>{annotation.connections.map((c, i) => {
          const other = results.find(r => r.systemId === system.id && r.binding.binding_id === c.bindingId)!;
          return <div key={i}><button onClick={() => setActive(key(other))}>{c.relationship} → {other.binding.semantic.label ?? other.binding.semantic.entity_id}</button><small>Source: {c.source}</small></div>;
        })}</>}
      </div>}
      <details open><summary>Assumptions and evidence</summary>
        {current.binding.assumptions.length ? <ul>{current.binding.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul> : <p>No assumptions supplied.</p>}
        {Object.entries(system.manifest.evidence).map(([name, evidence]) => <p key={name}><b>{name}</b>: {evidence}</p>)}
        <p>{system.manifest.requirements.length} geometric requirement(s) retained; checks are not executed by this inspector.</p>
      </details>
      <details><summary>Pinned source hashes</summary><p>Domain SHA-256: <code>{current.binding.semantic.sha256}</code></p><p>Geometry SHA-256: <code>{system.manifest.geometry.sha256}</code></p><p>Domain references are supplied provenance. Importing this sidecar does not fetch or validate the original domain artifact.</p></details>
    </article>}
  </section>;
}
