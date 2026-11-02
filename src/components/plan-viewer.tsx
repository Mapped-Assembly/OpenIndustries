import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { Workspace } from '../lib/workspace';
import { projectWorkspacePlan, snapPlan, type PlanPoint } from '../lib/plan-projection';
import './plan-viewer.css';

type PlanProps = {
  workspace: Workspace;
  selected: number;
  time: number | null;
  readOnly: boolean;
  onSelect: (index: number) => void;
  onMove: (index: number, x: number, z: number) => void;
  onRotate: (index: number, degrees: number) => void;
};
type View = { x: number; z: number; span: number };
type Gesture = {
  index: number | null;
  start: PlanPoint;
  last: PlanPoint;
  startClient: PlanPoint;
  original: View;
  moved: boolean;
};
const polyline = (points: readonly PlanPoint[]): string => points.map(point => point[0] + ',' + point[1]).join(' ');

function defaultView(room: Workspace['room'], ratio: number): View {
  return { x: 0, z: 0, span: Math.max(room[0] * 1.18, room[1] * 1.18 * ratio, 2) };
}

/** A native metric SVG plan of the active workspace; it creates no second scene model. */
export function PlanViewer({ workspace, selected, time, readOnly, onSelect, onMove, onRotate }: PlanProps) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pointer = useRef<Gesture | null>(null);
  const gridId = useId().replace(/:/g, '-');
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [view, setView] = useState<View>(() => defaultView(workspace.room, 900 / 600));
  const [grid, setGrid] = useState(true), [labels, setLabels] = useState(true);
  const [preview, setPreview] = useState<{ index: number; dx: number; dz: number } | null>(null);
  const projection = useMemo(() => projectWorkspacePlan(workspace, time), [workspace, time]);
  const ratio = size.width / Math.max(1, size.height);
  const height = view.span / ratio;
  const left = view.x - view.span / 2, top = view.z - height / 2;
  const gridStep = view.span > 60 ? 5 : view.span > 25 ? 2 : 1;
  const scaleLength = Math.max(1, Math.ceil(view.span / 16));
  useEffect(() => {
    if (!host.current) return;
    const resize = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    });
    resize.observe(host.current);
    return () => resize.disconnect();
  }, []);
  const roomDimensions = workspace.room[0] + ':' + workspace.room[1];
  useEffect(() => {
    setView(defaultView(workspace.room, size.width / Math.max(1, size.height)));
  // Reset only after a deliberate room-dimension change, not an item edit.
  }, [roomDimensions]);
  const screenPoint = (event: { clientX: number; clientY: number }): PlanPoint | null => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [point.x, point.y];
  };
  function start(event: PointerEvent<SVGElement>, index: number | null) {
    if (event.button !== 0) return;
    const point = screenPoint(event);
    if (!point) return;
    pointer.current = { index, start: point, last: point, startClient: [event.clientX, event.clientY], original: view, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const gesture = pointer.current;
    if (!gesture) return;
    const point = screenPoint(event);
    const startPoint = screenPoint({ clientX: gesture.startClient[0], clientY: gesture.startClient[1] });
    if (!point || !startPoint) return;
    const dx = point[0] - startPoint[0], dz = point[1] - startPoint[1];
    gesture.last = [gesture.start[0] + dx, gesture.start[1] + dz];
    if (Math.hypot(event.clientX - gesture.startClient[0], event.clientY - gesture.startClient[1]) > 4) gesture.moved = true;
    if (gesture.index !== null && !readOnly) {
      setPreview({ index: gesture.index, dx, dz });
    } else if (gesture.index === null) {
      setView(old => ({ ...old, x: gesture.original.x - dx, z: gesture.original.z - dz }));
    }
  }
  function stop(event: PointerEvent<SVGSVGElement>) {
    const gesture = pointer.current;
    if (!gesture) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPreview(null);
    if (event.type === 'pointercancel') return;
    if (gesture.index === null || gesture.index < 0) return;
    onSelect(gesture.index);
    if (gesture.moved && !readOnly) {
      const item = workspace.items[gesture.index];
      if (item) onMove(gesture.index,
        snapPlan(item.position[0] + gesture.last[0] - gesture.start[0]),
        snapPlan(item.position[2] + gesture.last[1] - gesture.start[1]));
    }
  }
  function zoom(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const anchor = screenPoint(event);
    if (!anchor) return;
    const factor = event.deltaY < 0 ? 0.88 : 1.12;
    const nextSpan = Math.max(0.4, Math.min(1000, view.span * factor));
    const f = nextSpan / view.span;
    setView(old => ({ span: nextSpan, x: anchor[0] + (old.x - anchor[0]) * f,
      z: anchor[1] + (old.z - anchor[1]) * f }));
  }
  function downloadSVG() {
    if (!svg.current) return;
    const source = new XMLSerializer().serializeToString(svg.current);
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'openindustries-plan.svg';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="viewport oi-plan" ref={host} aria-label="Interactive 2D floor plan">
    <div className="oi-plan-tools" role="toolbar" aria-label="Plan controls">
      <button onClick={() => setView(defaultView(workspace.room, ratio))}>Fit</button>
      <button onClick={() => setView(v => ({ ...v, span: Math.max(.4, v.span * .8) }))} aria-label="Zoom in">+</button>
      <button onClick={() => setView(v => ({ ...v, span: Math.min(1000, v.span * 1.25) }))} aria-label="Zoom out">−</button>
      <button aria-pressed={grid} onClick={() => setGrid(v => !v)}>Grid</button>
      <button aria-pressed={labels} onClick={() => setLabels(v => !v)}>Labels</button>
      <button onClick={downloadSVG}>Export SVG</button>
      <button disabled={readOnly || selected < 0} aria-label="Rotate selected object left" onClick={() => onRotate(selected, -5)}>↶ 5°</button>
      <button disabled={readOnly || selected < 0} aria-label="Rotate selected object right" onClick={() => onRotate(selected, 5)}>↷ 5°</button>
    </div>
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" className="oi-plan-svg" viewBox={left + ' ' + top + ' ' + view.span + ' ' + height}
      aria-label="Metric X Z plan, origin at room center" role="img" onWheel={zoom}
      onPointerDown={event => start(event, null)} onPointerMove={move}
      onPointerUp={stop} onPointerCancel={stop}>
      <title>OpenIndustries 2D Plan — world X is horizontal, Z is vertical; units are meters</title>
      <defs>
        <pattern id={gridId} x="0" y="0" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
          <path d={'M ' + gridStep + ' 0 L 0 0 0 ' + gridStep} stroke="#52675b" strokeWidth={0.012} fill="none"/>
        </pattern>
      </defs>
      <rect x={left} y={top} width={view.span} height={height} fill="#192322"/>
      <rect x={-workspace.room[0] / 2} y={-workspace.room[1] / 2}
        width={workspace.room[0]} height={workspace.room[1]} fill="#293a32" stroke="#a3bea7" strokeWidth={0.045}/>
      {grid && <rect x={-workspace.room[0] / 2} y={-workspace.room[1] / 2}
        width={workspace.room[0]} height={workspace.room[1]} fill={'url(#' + gridId + ')'}/>}
      {[...projection.footprints].sort((a,b) => {
        const area = (p: typeof a) => { const xs = p.points.map(q => q[0]), zs = p.points.map(q => q[1]); return (Math.max(...xs)-Math.min(...xs))*(Math.max(...zs)-Math.min(...zs)); };
        return area(b) - area(a) || a.instanceIndex - b.instanceIndex;
      }).map(footprint => {
        const isSelected = footprint.instanceIndex === selected;
        const shift = preview?.index === footprint.instanceIndex ? preview : null;
        const centerX = footprint.points.reduce((sum, p) => sum + p[0], 0) / footprint.points.length;
        const centerZ = footprint.points.reduce((sum, p) => sum + p[1], 0) / footprint.points.length;
        return <g key={footprint.instanceId} data-instance-id={footprint.instanceId}
          transform={shift ? 'translate(' + shift.dx + ' ' + shift.dz + ')' : undefined}
          onPointerDown={event => { event.stopPropagation(); start(event, footprint.instanceIndex); }}
          className={'oi-plan-object' + (isSelected ? ' selected' : '') + (footprint.missing ? ' missing' : '')}
          style={{ cursor: readOnly ? 'pointer' : 'grab' }}>
          <title>{footprint.name + ' — ' + footprint.instanceId + (footprint.missing ? ' (missing geometry)' : ' (conservative footprint)')}</title>
          <polygon points={polyline(footprint.points)}
            strokeWidth={isSelected ? .07 : .035}
            fill={footprint.missing ? '#735a43' : isSelected ? '#a1cb73' : '#568f86'}
            stroke={isSelected ? '#eaffbf' : '#c1d9ce'} fillOpacity={footprint.missing ? .6 : .76}/>
          {labels && <text x={centerX} y={centerZ} fontSize={Math.max(.13, Math.min(.25, view.span / 46))}
            textAnchor="middle" fill="#fff" stroke="#142019" strokeWidth=".04" paintOrder="stroke" pointerEvents="none">{footprint.name.slice(0, 26)}</text>}
        </g>;
      })}
      <g pointerEvents="none" transform={'translate(' + (left + view.span * .04) + ' ' + (top + height * .92) + ')'}>
        <line x1={0} y1={0} x2={scaleLength} y2={0} stroke="#dcebcf" strokeWidth=".05"/>
        <line x1={0} y1={-.09} x2={0} y2={.09} stroke="#dcebcf" strokeWidth=".04"/>
        <line x1={scaleLength} y1={-.09} x2={scaleLength} y2={.09} stroke="#dcebcf" strokeWidth=".04"/>
        <text x={scaleLength / 2} y={-.17} fill="#e9f4e1" textAnchor="middle" fontSize=".18">{scaleLength} m</text>
      </g>
    </svg>
    <div className="oi-plan-legend" role="status">
      {projection.visibleCount} visible / {workspace.items.length} instances · {workspace.room[0]} × {workspace.room[1]} m · X →, Z ↓
      <span>Conservative geometry envelopes, not architectural walls, doorways or certified clearances.</span>
      <span>{readOnly ? 'Read-only view · ' : 'Drag equipment to move (0.1 m snap) · '}Drag empty space to pan · Scroll to zoom.</span>
    </div>
  </div>;
}
