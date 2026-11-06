import { Crosshair, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import {
  ApiError,
  blame,
  editNode,
  getLineage,
  proposeChangeSet,
  type BlameEntry,
  type Lineage,
  type LineageDirection,
  type NodeKind,
  type Relation,
} from './api';
import EditField from './EditField';
import ErrorMessage from './ErrorMessage';
import { KIND_LABEL, RELATION_LABEL } from './glossary';
import RecordDetails from './RecordDetails';
import { tabKey, type Tab } from './tabs';
import { toast } from './Toasts';
import { IconButton } from './ui';

cytoscape.use(dagre);

type Props = {
  id: string;
  open: (t: Tab) => void;
  rename: (key: string, title: string) => void;
};

type Fetched = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; lineage: Lineage };

const directions: { value: LineageDirection; label: string }[] = [
  { value: 'upstream', label: 'Where it came from' },
  { value: 'downstream', label: 'What it led to' },
  { value: 'both', label: 'Both' },
];

const kinds: NodeKind[] = ['sample', 'reagent', 'protocol', 'run', 'instrument', 'dataset', 'analysis'];

// One shape per kind, so the graph never relies on colour alone (design §3.8).
const SHAPE: Record<NodeKind, string> = {
  sample: 'ellipse',
  reagent: 'round-diamond',
  protocol: 'round-rectangle',
  run: 'hexagon',
  instrument: 'round-triangle',
  dataset: 'barrel',
  analysis: 'round-pentagon',
};

// LegendShape draws a small version of each node shape for the legend.
function LegendShape({ kind }: { kind: NodeKind }) {
  const fill = { fill: `var(--kind-${kind})` };
  const shape = (() => {
    switch (kind) {
      case 'sample':
        return <circle cx="9" cy="9" r="7" style={fill} />;
      case 'reagent':
        return <path d="M9 1L17 9L9 17L1 9Z" style={fill} />;
      case 'protocol':
        return <rect x="2" y="3" width="14" height="12" rx="2" style={{ ...fill, stroke: 'var(--fg)', strokeDasharray: '2 2' }} />;
      case 'run':
        return <path d="M5 2H13L17 9L13 16H5L1 9Z" style={fill} />;
      case 'instrument':
        return <path d="M9 2L17 16H1Z" style={fill} />;
      case 'dataset':
        return <rect x="2" y="2" width="14" height="14" rx="5" style={fill} />;
      case 'analysis':
        return <path d="M9 1L17 7L14 16H4L1 7Z" style={fill} />;
    }
  })();
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {shape}
    </svg>
  );
}

// graphStyle reads the colours from the current theme's tokens.
function graphStyle(): cytoscape.StylesheetJson {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        color: token('--fg'),
        'font-family': 'Fira Sans, system-ui, sans-serif',
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'ellipsis',
        'text-max-width': '120px',
        'background-color': token('--muted'),
        'border-width': 0,
        'border-color': token('--fg'),
      },
    },
    ...kinds.map((k) => ({
      selector: `node[kind = "${k}"]`,
      style: { 'background-color': token(`--kind-${k}`), shape: SHAPE[k] } as cytoscape.Css.Node,
    })),
    { selector: 'node[kind = "protocol"]', style: { 'border-width': 1, 'border-style': 'dashed', 'border-color': token('--fg') } },
    { selector: 'node.root', style: { 'border-width': 3, 'border-style': 'solid', 'border-color': token('--fg') } },
    { selector: 'node.sel', style: { 'border-width': 4, 'border-color': token('--primary'), 'border-style': 'double' } },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        label: 'data(label)',
        'font-size': 9,
        color: token('--muted'),
        'text-background-color': token('--surface'),
        'text-background-opacity': 1,
        'text-background-padding': '2px',
        'text-rotation': 'autorotate',
        'line-color': token('--border-strong'),
        'target-arrow-color': token('--border-strong'),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
      },
    },
  ] as cytoscape.StylesheetJson;
}

// LineageView (SPEC-025-R29): the provenance graph with a shape per kind, a
// legend, plain-language edge labels and zoom controls, restyled with the theme.
export default function LineageView({ id, open, rename }: Props) {
  const [direction, setDirection] = useState<LineageDirection>('both');
  const [fetched, setFetched] = useState<Fetched>({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  // Blame for the selected node; it drives the "changed" markers in the details panel.
  const [blamed, setBlamed] = useState<{ id: string; fields: BlameEntry[]; error?: unknown } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const lineage = fetched.status === 'ready' ? fetched.lineage : null;

  useEffect(() => {
    let live = true;
    setFetched({ status: 'loading' });
    getLineage(id, direction)
      .then((l) => {
        if (!live) return;
        setFetched({ status: 'ready', lineage: l });
        setSelected(l.root);
        const root = l.nodes.find((n) => n.id === l.root);
        if (root) rename(tabKey({ kind: 'lineage', id }), root.label);
      })
      .catch((error: unknown) => live && setFetched({ status: 'error', error }));
    return () => {
      live = false;
    };
  }, [id, direction, rename]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    blame('lineage_node', selected)
      .then((b) => live && setBlamed({ id: selected, fields: b.fields }))
      .catch((error: unknown) => live && setBlamed({ id: selected, fields: [], error }));
    return () => {
      live = false;
    };
  }, [selected]);

  // Build the graph. The cleanup destroys it, so StrictMode's second run leaves one canvas.
  useEffect(() => {
    if (!lineage || !canvas.current) return;
    const instance = cytoscape({
      container: canvas.current,
      elements: [
        ...lineage.nodes.map((n) => ({ data: { id: n.id, label: n.label, kind: n.kind } })),
        ...(lineage.edges ?? []).map((e, i) => ({
          data: { id: `e${i}`, source: e.from, target: e.to, relation: e.relation, label: RELATION_LABEL[e.relation as Relation] ?? e.relation },
        })),
      ],
      layout: { name: 'dagre', rankDir: 'LR', nodeSep: 40, rankSep: 90 } as cytoscape.LayoutOptions,
      minZoom: 0.1,
      maxZoom: 3,
      style: graphStyle(),
    });
    instance.getElementById(lineage.root).addClass('root');
    instance.on('tap', 'node', (ev) => setSelected(ev.target.id()));
    cy.current = instance;

    // Restyle when the theme changes: the OS preference or the user menu.
    const restyle = () => instance.style(graphStyle());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', restyle);
    window.addEventListener('labrat:theme', restyle);
    return () => {
      mq.removeEventListener('change', restyle);
      window.removeEventListener('labrat:theme', restyle);
      instance.destroy();
      cy.current = null;
    };
  }, [lineage]);

  // Highlight the selected node in the graph.
  useEffect(() => {
    cy.current?.nodes().removeClass('sel');
    if (selected) cy.current?.getElementById(selected).addClass('sel');
  }, [selected, lineage]);

  useEffect(() => {
    if (selected) listbox.current?.querySelector(`[id="opt-${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!lineage) return;
    const i = lineage.nodes.findIndex((n) => n.id === selected);
    if (e.key === 'ArrowDown') setSelected(lineage.nodes[Math.min(i + 1, lineage.nodes.length - 1)].id);
    else if (e.key === 'ArrowUp') setSelected(lineage.nodes[Math.max(i - 1, 0)].id);
    else if (e.key === 'Enter' && i >= 0) recentre(lineage.nodes[i].id, lineage.nodes[i].label);
    else return;
    e.preventDefault();
  }

  function recentre(nodeId: string, label: string) {
    open({ kind: 'lineage', id: nodeId, title: label });
  }

  function zoom(by: number) {
    const c = cy.current;
    if (!c) return;
    c.zoom({ level: c.zoom() * by, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } });
  }

  // saveNode reloads the graph and the node's blame, so the panel and the graph show the saved values.
  // A sealed node refuses a direct edit with 409, so the edit is proposed as a correction instead
  // (SPEC-008-R09, R10).
  async function saveNode(nodeId: string, edit: { label?: string; attrs?: Record<string, unknown> }, reason: string): Promise<void | 'proposed'> {
    try {
      await editNode(nodeId, edit, reason);
    } catch (err: unknown) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      // Only a correction can be proposed: a frozen node (aborted, or signed before signatures) can never commit one.
      if (!err.message.includes('correction')) throw new Error('This record is frozen and cannot be corrected.');
      await proposeChangeSet('Correct a sealed item', reason, [{ op: 'update_node', node_id: nodeId, ...edit }]);
      return 'proposed';
    }
    toast('Saved');
    const [l, b] = await Promise.all([getLineage(id, direction), blame('lineage_node', nodeId)]);
    setFetched({ status: 'ready', lineage: l });
    setBlamed({ id: nodeId, fields: b.fields });
    const root = l.nodes.find((n) => n.id === l.root);
    if (root) rename(tabKey({ kind: 'lineage', id }), root.label);
  }

  const node = lineage?.nodes.find((n) => n.id === selected);
  const revised = blamed && node && blamed.id === node.id ? blamed.fields.filter((f) => f.rev > 1) : [];
  const labelChanged = revised.some((f) => f.path.startsWith('$.label'));
  const attrsChanged = revised.some((f) => f.path.startsWith('$.attrs'));
  const present = new Set(lineage?.nodes.map((n) => n.kind));

  return (
    <div className="lineage">
      <div className="lineage-main">
        <div className="lineage-toolbar">
          <fieldset className="lineage-direction">
            <legend className="sr-only">Direction</legend>
            {directions.map((d) => (
              <label key={d.value}>
                <input type="radio" name={`direction-${id}`} checked={direction === d.value} onChange={() => setDirection(d.value)} /> {d.label}
              </label>
            ))}
          </fieldset>
          <div className="actions" role="group" aria-label="Zoom">
            <IconButton label="Zoom in" onPress={() => zoom(1.25)}>
              <ZoomIn size={16} aria-hidden="true" />
            </IconButton>
            <IconButton label="Zoom out" onPress={() => zoom(0.8)}>
              <ZoomOut size={16} aria-hidden="true" />
            </IconButton>
            <IconButton label="Fit to view" onPress={() => cy.current?.fit(undefined, 30)}>
              <Maximize size={16} aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        {fetched.status === 'error' && <ErrorMessage error={fetched.error} action="load the lineage" />}
        {fetched.status === 'loading' && <p className="muted">Loading lineage…</p>}
        {/* Cytoscape injects a <style> element (blocked by our CSP) unless an element with this id exists.
            .lineage-canvas already sets position: relative, which is all that style would do. */}
        <template id="__________cytoscape_stylesheet" />
        <div className="lineage-canvas" ref={canvas} data-nodes={lineage?.nodes.length ?? 0} aria-hidden="true" />
      </div>
      {lineage && (
        <aside className="lineage-side" aria-label="Lineage details">
          <section className="card" aria-labelledby="legend-heading">
            <h2 id="legend-heading" style={{ marginBottom: 'var(--space-2)' }}>
              Legend
            </h2>
            <ul className="legend">
              {kinds
                .filter((k) => present.has(k))
                .map((k) => (
                  <li key={k}>
                    <LegendShape kind={k} /> {KIND_LABEL[k]}
                  </li>
                ))}
            </ul>
            <p className="muted" style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-sm)' }}>
              Arrows point downstream: from what was used to what used it. A thick border marks where you started.
            </p>
          </section>
          <section aria-labelledby="items-heading">
            <h2 id="items-heading" style={{ marginBottom: 'var(--space-2)' }}>
              Items ({lineage.nodes.length})
            </h2>
            <div
              role="listbox"
              aria-labelledby="items-heading"
              tabIndex={0}
              ref={listbox}
              className="lineage-list"
              aria-activedescendant={selected ? `opt-${selected}` : undefined}
              onKeyDown={onListKeyDown}
            >
              {lineage.nodes.map((n) => (
                <div key={n.id} id={`opt-${n.id}`} role="option" aria-selected={n.id === selected} onClick={() => setSelected(n.id)}>
                  {n.label} <span className="muted">({KIND_LABEL[n.kind] ?? n.kind})</span>
                </div>
              ))}
            </div>
          </section>
          {node && (
            <section className="card" aria-label="Selected item" key={node.id}>
              <p className="muted" style={{ margin: '0 0 var(--space-2)' }}>
                {KIND_LABEL[node.kind] ?? node.kind} · created {node.created_at.slice(0, 16).replace('T', ' ')}
              </p>
              <EditField label="Name" value={node.label} changed={labelChanged} onSave={(value, reason) => saveNode(node.id, { label: value }, reason)} />
              {blamed?.id === node.id && blamed.error !== undefined && <ErrorMessage error={blamed.error} action="load the item's revisions" />}
              <EditField
                label="Details"
                json
                schemaVersionId={node.schema_version_id}
                value={JSON.stringify(node.attrs ?? {}, null, 2)}
                changed={attrsChanged}
                onSave={(value, reason) => saveNode(node.id, { attrs: JSON.parse(value) as Record<string, unknown> }, reason)}
              />
              <div className="actions">
                <button type="button" className="btn" onClick={() => recentre(node.id, node.label)}>
                  <Crosshair size={16} aria-hidden="true" /> Re-centre here
                </button>
              </div>
              <RecordDetails
                rows={[
                  { label: 'Item ID', value: node.id, term: 'lineage node id' },
                  { label: 'Schema version', value: node.schema_version_id },
                ]}
              />
            </section>
          )}
        </aside>
      )}
    </div>
  );
}
