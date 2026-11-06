import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import AuditView from './AuditView';
import BottomPanel from './BottomPanel';
import CommandPalette, { type PaletteItem } from './CommandPalette';
import DelegationsView from './DelegationsView';
import { on, openNew, type NewKind } from './events';
import ExperimentView from './ExperimentView';
import HomeView from './HomeView';
import InstrumentView from './InstrumentView';
import LineageView from './LineageView';
import MeView from './MeView';
import NewExperimentDialog from './NewExperimentDialog';
import NewInstrumentDialog from './NewInstrumentDialog';
import NewNodeView from './NewNodeView';
import NewRunDialog from './NewRunDialog';
import PrincipalsView from './PrincipalsView';
import RunView from './RunView';
import SchemasView from './SchemasView';
import SchemaView from './SchemaView';
import Sidebar, { type Loaded } from './Sidebar';
import { SINGLETONS, tabKey, todoTab, useTabs, type Tab } from './tabs';
import Toasts from './Toasts';
import ToDoView from './ToDoView';
import { useToDo, type ToDo } from './todo';
import TopBar from './TopBar';
import type { Instrument } from './api';
import { Drawer } from './ui';

// Every view takes the same props: its tab id, plus open and rename from useTabs.
type ViewProps = { id: string; open: (t: Tab) => void; rename: (key: string, title: string) => void };

type ContentProps = {
  tab: Tab;
  instruments: Instrument[];
  verifyOnOpen: number;
  todo: ToDo | null;
  handle: string;
  setSub: (key: string, sub: string) => void;
} & Pick<ViewProps, 'open' | 'rename'>;

// TabContent is the one place that maps a tab kind to its view.
function TabContent({ tab, instruments, verifyOnOpen, todo, handle, setSub, open, rename }: ContentProps) {
  const props: ViewProps = { id: tab.id, open, rename };
  switch (tab.kind) {
    case 'home':
      return <HomeView open={open} todo={todo} handle={handle} />;
    case 'todo':
      return <ToDoView sub={tab.sub} onSub={(s) => setSub(tabKey(tab), s)} todo={todo} open={open} />;
    case 'experiment':
      return <ExperimentView {...props} />;
    case 'run':
      return <RunView {...props} title={tab.title} instruments={instruments} />;
    case 'instrument':
      return <InstrumentView {...props} instruments={instruments} />;
    case 'lineage':
      return <LineageView {...props} />;
    case 'audit':
      return <AuditView id={tab.id} verifyOnOpen={verifyOnOpen} />;
    case 'me':
      return <MeView />;
    case 'principals':
      return <PrincipalsView />;
    case 'delegations':
      return <DelegationsView />;
    case 'newnode':
      return <NewNodeView open={open} />;
    case 'schemas':
      return <SchemasView open={open} />;
    case 'schema':
      return <SchemaView {...props} />;
  }
}

function tabLabel(t: Tab): string {
  if (SINGLETONS[t.kind]) return t.title;
  return `${t.kind[0].toUpperCase()}${t.kind.slice(1)}: ${t.title}`;
}

export default function Workspace({ handle, onSignOut }: { handle: string; onSignOut: () => void }) {
  const { tabs, active, open, close, closeAll, rename, setSub } = useTabs();
  // Read by the views, dialogs and the command palette.
  const [loaded, setLoadedState] = useState<Loaded>({ experiments: [], runs: {}, instruments: [] });
  const setLoaded = useCallback((l: Loaded) => setLoadedState(l), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: NewKind; experimentId?: string } | null>(null);
  const [verifyCount, setVerifyCount] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const { todo } = useToDo();
  const todoCount = todo ? todo.signoffs.length + todo.reviews.length : null;
  const tablist = useRef<HTMLDivElement>(null);
  const activeKey = active ? tabKey(active) : null;

  // The roving tab stop follows the active tab.
  useEffect(() => setFocusKey(activeKey), [activeKey]);

  // Ctrl+K (Cmd+K on macOS) opens the command palette; while open it stays one dialog.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    const offPalette = on('labrat:palette', () => setPaletteOpen(true));
    return () => {
      window.removeEventListener('keydown', onKey);
      offPalette();
    };
  }, []);

  // Create dialogs open from anywhere: the New menu, the sidebar's "+", Home.
  useEffect(
    () =>
      on<{ kind: NewKind; experimentId?: string }>('labrat:new', (d) => {
        setDrawerOpen(false);
        if (d.kind === 'record') open(SINGLETONS.newnode!);
        else setDialog(d);
      }),
    [open],
  );

  // Opening something from the drawer closes it.
  const openTab = useCallback(
    (t: Tab) => {
      setDrawerOpen(false);
      open(t);
    },
    [open],
  );

  const auditTab = SINGLETONS.audit!;
  const paletteItems: PaletteItem[] = [
    { id: 'cmd:home', title: 'Home', hint: 'Go to', run: () => open(SINGLETONS.home!) },
    { id: 'cmd:todo', title: 'To do: review changes', hint: 'Go to', run: () => open(todoTab('review')) },
    { id: 'cmd:signoff', title: 'To do: sign-offs', hint: 'Go to', run: () => open(todoTab('signoff')) },
    { id: 'cmd:new-experiment', title: 'New experiment', hint: 'Create', run: () => openNew('experiment') },
    { id: 'cmd:new-run', title: 'New run', hint: 'Create', run: () => openNew('run') },
    { id: 'cmd:newnode', title: 'New sample or material', hint: 'Create', run: () => open(SINGLETONS.newnode!) },
    { id: 'cmd:new-instrument', title: 'Register instrument', hint: 'Create', run: () => openNew('instrument') },
    ...loaded.experiments.map((x) => ({ id: `experiment:${x.id}`, title: x.slug, hint: 'Experiment', run: () => open({ kind: 'experiment', id: x.id, title: x.slug }) })),
    ...Object.values(loaded.runs).flatMap((rs) => rs.map((r) => ({ id: `run:${r.id}`, title: r.label, hint: 'Run', run: () => open({ kind: 'run', id: r.id, title: r.label }) }))),
    ...loaded.instruments.map((i) => ({ id: `instrument:${i.id}`, title: i.name, hint: 'Instrument', run: () => open({ kind: 'instrument', id: i.id, title: i.name }) })),
    { id: 'cmd:schemas', title: 'Schemas', hint: 'Go to', run: () => open(SINGLETONS.schemas!) },
    { id: 'cmd:audit', title: 'Open audit trail', hint: 'Go to', run: () => open(auditTab) },
    {
      id: 'cmd:verify',
      title: 'Verify audit chain',
      hint: 'Command',
      run: () => {
        open(auditTab);
        setVerifyCount((n) => n + 1);
      },
    },
    { id: 'cmd:me', title: 'My account', hint: 'Go to', run: () => open(SINGLETONS.me!) },
    { id: 'cmd:principals', title: 'Users and service accounts', hint: 'Admin', run: () => open(SINGLETONS.principals!) },
    { id: 'cmd:delegations', title: 'Agent delegations', hint: 'Admin', run: () => open(SINGLETONS.delegations!) },
    { id: 'cmd:close-all', title: 'Close all tabs', hint: 'Command', run: closeAll },
    { id: 'cmd:sign-out', title: 'Sign out', hint: 'Command', run: onSignOut },
  ];

  function closeTab(key: string) {
    close(key);
    // Closing removes the focused element: put focus back on the tab strip.
    requestAnimationFrame(() => tablist.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus());
  }

  function onWorkspaceKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey && e.key.toLowerCase() === 'w' && activeKey) {
      e.preventDefault();
      closeTab(activeKey);
    }
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, tab: Tab) {
    const els = Array.from(tablist.current!.querySelectorAll<HTMLElement>('[role="tab"]'));
    const i = els.indexOf(e.currentTarget);
    if (e.key === 'ArrowRight') els[(i + 1) % els.length].focus();
    else if (e.key === 'ArrowLeft') els[(i + els.length - 1) % els.length].focus();
    else if (e.key === 'Enter') open(tab);
    else if (e.key === 'Delete') closeTab(tabKey(tab));
    else return;
    e.preventDefault();
  }

  const rovingKey = tabs.some((t) => tabKey(t) === focusKey) ? focusKey : activeKey;
  const sidebar = <Sidebar open={openTab} onLoaded={setLoaded} activeKey={activeKey} todoCount={todoCount} />;

  return (
    <>
      <TopBar handle={handle} todoCount={todoCount} open={open} onSignOut={onSignOut} onOpenDrawer={() => setDrawerOpen(true)} />
      <div className="workspace" onKeyDown={onWorkspaceKeyDown}>
        <nav className="sidebar" aria-label="Navigation">
          {sidebar}
        </nav>
        <Drawer label="Navigation" isOpen={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <nav aria-label="Navigation">{drawerOpen && sidebar}</nav>
        </Drawer>
        <main className="main">
          <div role="tablist" aria-label="Open items" className="tabstrip" ref={tablist}>
            {tabs.map((t) => {
              const key = tabKey(t);
              return (
                <div key={key} role="presentation" className="tab" data-active={key === activeKey}>
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${key}`}
                    aria-selected={key === activeKey}
                    aria-controls="tabpanel"
                    tabIndex={key === rovingKey ? 0 : -1}
                    onClick={() => open(t)}
                    onKeyDown={(e) => onTabKeyDown(e, t)}
                    onFocus={() => setFocusKey(key)}
                  >
                    {tabLabel(t)}
                  </button>
                  <button type="button" className="tab-close" aria-label={`Close ${t.title}`} tabIndex={key === activeKey ? 0 : -1} onClick={() => closeTab(key)}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          {active ? (
            <div role="tabpanel" id="tabpanel" aria-labelledby={`tab-${tabKey(active)}`} className="tabpanel">
              <TabContent
                tab={active}
                instruments={loaded.instruments}
                verifyOnOpen={verifyCount}
                todo={todo}
                handle={handle}
                setSub={setSub}
                open={open}
                rename={rename}
              />
            </div>
          ) : (
            <div className="tabpanel">
              <p className="muted">
                Nothing is open.{' '}
                <button type="button" className="btn btn-link" onClick={() => open(SINGLETONS.home!)}>
                  Go to Home
                </button>
              </p>
            </div>
          )}
        </main>
        <BottomPanel active={active} />
      </div>
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      <NewExperimentDialog isOpen={dialog?.kind === 'experiment'} onClose={() => setDialog(null)} open={open} />
      <NewInstrumentDialog isOpen={dialog?.kind === 'instrument'} onClose={() => setDialog(null)} open={open} instruments={loaded.instruments} />
      <NewRunDialog
        isOpen={dialog?.kind === 'run'}
        onClose={() => setDialog(null)}
        open={open}
        experiments={loaded.experiments}
        experimentId={dialog?.experimentId}
      />
      <Toasts />
    </>
  );
}
