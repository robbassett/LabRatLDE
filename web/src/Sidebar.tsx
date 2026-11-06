import { Braces, ChevronDown, ChevronRight, FlaskConical, Gauge, House, ListChecks, Plus, Settings, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  listExperiments,
  listInstruments,
  listRuns,
  type ExperimentSummary,
  type Instrument,
  type Page,
  type RunSummary,
} from './api';
import { on, openNew } from './events';
import { hasRole, useMe } from './me';
import { StateDot } from './StatusBadge';
import { SINGLETONS, todoTab, type Tab } from './tabs';

type List<T> = { items: T[]; next: string | null; loading: boolean; error: string | null };

const empty = { items: [], next: null, loading: false, error: null };

// Everything the sidebar has loaded so far, for the command palette and views.
export type Loaded = {
  experiments: ExperimentSummary[];
  runs: Record<string, RunSummary[]>;
  instruments: Instrument[];
};

// load fetches one page into a list: no cursor replaces, a cursor appends.
function load<T>(set: (update: (l: List<T>) => List<T>) => void, fetchPage: (cursor?: string) => Promise<Page<T>>, cursor?: string) {
  set((l) => ({ ...l, loading: true, error: null }));
  fetchPage(cursor)
    .then((p) => set((l) => ({ items: cursor ? [...l.items, ...p.items] : p.items, next: p.next_cursor, loading: false, error: null })))
    .catch((err: unknown) => set((l) => ({ ...l, loading: false, error: err instanceof Error ? err.message : String(err) })));
}

type ItemProps = {
  itemKey: string;
  level: number;
  focusKey: string;
  activeKey: string | null;
  expanded?: boolean; // undefined: a leaf
  onToggle?: () => void;
  onActivate: () => void;
  label: string;
  icon?: LucideIcon;
  trailing?: ReactNode;
  children?: ReactNode;
};

// Item is one tree row. The keyboard model is the WAI-ARIA tree: Up/Down move,
// Right expands or enters, Left collapses or leaves, Enter opens.
function Item({ itemKey, level, focusKey, activeKey, expanded, onToggle, onActivate, label, icon: Icon, trailing, children }: ItemProps) {
  function onKeyDown(e: KeyboardEvent<HTMLLIElement>) {
    if (e.target !== e.currentTarget) return;
    const el = e.currentTarget;
    const items = Array.from(el.closest('[role="tree"]')!.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const i = items.indexOf(el);
    switch (e.key) {
      case 'ArrowDown':
        items[i + 1]?.focus();
        break;
      case 'ArrowUp':
        items[i - 1]?.focus();
        break;
      case 'ArrowRight':
        if (expanded === false) onToggle?.();
        else if (expanded) items[i + 1]?.focus();
        break;
      case 'ArrowLeft':
        if (expanded) onToggle?.();
        else el.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
        break;
      case 'Enter':
        onActivate();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-expanded={expanded}
      aria-current={itemKey === activeKey ? 'page' : undefined}
      tabIndex={itemKey === focusKey ? 0 : -1}
      data-key={itemKey}
      onKeyDown={onKeyDown}
    >
      <div className="tree-row" data-active={itemKey === activeKey} onClick={onActivate}>
        {expanded !== undefined ? (
          <span
            className="tree-twisty"
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : level > 1 ? null : (
          <span className="tree-twisty" aria-hidden="true" />
        )}
        {Icon && <Icon size={18} aria-hidden="true" />}
        <span className="tree-text">{label}</span>
        {trailing}
      </div>
      {children}
    </li>
  );
}

// AddButton is a section's "+": a pointer shortcut. Keyboard users reach the same dialogs from New.
function AddButton({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <button
      type="button"
      className="btn tree-add"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onAdd();
      }}
    >
      <Plus size={14} aria-hidden="true" />
    </button>
  );
}

function Status<T>({ list, level = 2 }: { list: List<T>; level?: number }) {
  const cls = level === 3 ? 'level-3' : undefined;
  return (
    <>
      {list.loading && (
        <li role="none" className={cls}>
          Loading…
        </li>
      )}
      {list.error && (
        <li role="none" className={cls}>
          <span role="alert">Couldn't load: {list.error}</span>
        </li>
      )}
    </>
  );
}

// Sidebar (SPEC-025-R09) is the workspace navigation: sections with icons,
// experiments with their runs and status dots, and Admin for admins only.
export default function Sidebar({
  open,
  onLoaded,
  activeKey,
  todoCount,
}: {
  open: (tab: Tab) => void;
  onLoaded: (l: Loaded) => void;
  activeKey: string | null;
  todoCount: number | null;
}) {
  const me = useMe();
  const canCreate = hasRole(me, 'scientist');
  const isAdmin = hasRole(me, 'admin');
  const [experiments, setExperiments] = useState<List<ExperimentSummary>>(empty);
  const [instruments, setInstruments] = useState<List<Instrument>>(empty);
  const [runs, setRuns] = useState<Record<string, List<RunSummary>>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ experiments: true, instruments: true });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const runIds = useRef<string[]>([]);
  runIds.current = Object.keys(runs);

  const loadRuns = useCallback((id: string, cursor?: string) => {
    load<RunSummary>((u) => setRuns((r) => ({ ...r, [id]: u(r[id] ?? empty) })), (c) => listRuns(id, c), cursor);
  }, []);

  useEffect(() => {
    load(setExperiments, listExperiments);
    load(setInstruments, listInstruments);
  }, []);

  // A create elsewhere asks for a refresh: reload the lists and any expanded runs.
  useEffect(
    () =>
      on('labrat:refresh', () => {
        load(setExperiments, listExperiments);
        load(setInstruments, listInstruments);
        runIds.current.forEach((id) => loadRuns(id));
      }),
    [loadRuns],
  );

  useEffect(() => {
    onLoaded({
      experiments: experiments.items,
      runs: Object.fromEntries(Object.entries(runs).map(([id, l]) => [id, l.items])),
      instruments: instruments.items,
    });
  }, [experiments.items, runs, instruments.items, onLoaded]);

  function toggle(key: string) {
    setExpanded((x) => ({ ...x, [key]: !x[key] }));
  }

  function toggleExperiment(id: string) {
    if (!expanded[id] && !runs[id]) loadRuns(id);
    toggle(id);
  }

  const fk = focusKey ?? 'home:home';
  const props = { focusKey: fk, activeKey };
  const single = (k: keyof typeof SINGLETONS) => SINGLETONS[k]!;

  return (
    <ul role="tree" aria-label="Navigation" className="tree" onFocus={(e) => setFocusKey((e.target as HTMLElement).dataset.key ?? null)}>
      <Item {...props} itemKey="home:home" level={1} icon={House} label="Home" onActivate={() => open(single('home'))} />

      <Item
        {...props}
        itemKey="section:experiments"
        level={1}
        icon={FlaskConical}
        label="Experiments"
        expanded={!!expanded.experiments}
        onToggle={() => toggle('experiments')}
        onActivate={() => toggle('experiments')}
        trailing={canCreate && <AddButton label="New experiment" onAdd={() => openNew('experiment')} />}
      >
        {expanded.experiments && (
          <ul role="group">
            {experiments.items.map((x) => {
              const r = runs[x.id] ?? empty;
              return (
                <Item
                  {...props}
                  key={x.id}
                  itemKey={`experiment:${x.id}`}
                  level={2}
                  expanded={!!expanded[x.id]}
                  onToggle={() => toggleExperiment(x.id)}
                  onActivate={() => open({ kind: 'experiment', id: x.id, title: x.slug })}
                  label={x.slug}
                >
                  {expanded[x.id] && (
                    <ul role="group">
                      {r.items.map((run) => (
                        <Item
                          {...props}
                          key={run.id}
                          itemKey={`run:${run.id}`}
                          level={3}
                          onActivate={() => open({ kind: 'run', id: run.id, title: run.label })}
                          label={run.label}
                          trailing={<StateDot state={run.state} />}
                        />
                      ))}
                      {r.next && <Item {...props} itemKey={`more:r:${x.id}`} level={3} onActivate={() => loadRuns(x.id, r.next!)} label="Load more" />}
                      <Status list={r} level={3} />
                      {!r.loading && !r.error && r.items.length === 0 && (
                        <li role="none" className="level-3">
                          No runs yet
                        </li>
                      )}
                    </ul>
                  )}
                </Item>
              );
            })}
            {experiments.next && (
              <Item {...props} itemKey="more:e" level={2} onActivate={() => load(setExperiments, listExperiments, experiments.next!)} label="Load more" />
            )}
            <Status list={experiments} />
            {!experiments.loading && !experiments.error && experiments.items.length === 0 && <li role="none">No experiments yet</li>}
          </ul>
        )}
      </Item>

      <Item
        {...props}
        itemKey="section:instruments"
        level={1}
        icon={Gauge}
        label="Instruments"
        expanded={!!expanded.instruments}
        onToggle={() => toggle('instruments')}
        onActivate={() => toggle('instruments')}
        trailing={canCreate && <AddButton label="Register instrument" onAdd={() => openNew('instrument')} />}
      >
        {expanded.instruments && (
          <ul role="group">
            {instruments.items.map((i) => (
              <Item
                {...props}
                key={i.id}
                itemKey={`instrument:${i.id}`}
                level={2}
                onActivate={() => open({ kind: 'instrument', id: i.id, title: i.name })}
                label={i.name}
              />
            ))}
            {instruments.next && (
              <Item {...props} itemKey="more:i" level={2} onActivate={() => load(setInstruments, listInstruments, instruments.next!)} label="Load more" />
            )}
            <Status list={instruments} />
            {!instruments.loading && !instruments.error && instruments.items.length === 0 && <li role="none">No instruments registered</li>}
          </ul>
        )}
      </Item>

      <Item {...props} itemKey="schemas:schemas" level={1} icon={Braces} label="Schemas" onActivate={() => open(single('schemas'))} />
      <Item
        {...props}
        itemKey="todo:todo"
        level={1}
        icon={ListChecks}
        label="To do"
        onActivate={() => open(todoTab('review'))}
        trailing={
          todoCount !== null && (
            <span className="count" data-zero={todoCount === 0} aria-label={`${todoCount} waiting`}>
              {todoCount}
            </span>
          )
        }
      />
      <Item {...props} itemKey="audit:audit" level={1} icon={ShieldCheck} label="Audit trail" onActivate={() => open(single('audit'))} />

      {isAdmin && (
        <Item
          {...props}
          itemKey="section:admin"
          level={1}
          icon={Settings}
          label="Admin"
          expanded={!!expanded.admin}
          onToggle={() => toggle('admin')}
          onActivate={() => toggle('admin')}
        >
          {expanded.admin && (
            <ul role="group">
              <Item {...props} itemKey="principals:principals" level={2} label={single('principals').title} onActivate={() => open(single('principals'))} />
              <Item {...props} itemKey="delegations:delegations" level={2} label={single('delegations').title} onActivate={() => open(single('delegations'))} />
            </ul>
          )}
        </Item>
      )}
    </ul>
  );
}
