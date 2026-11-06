import { useCallback, useEffect, useState } from 'react';

export type Kind =
  | 'home'
  | 'todo'
  | 'experiment'
  | 'run'
  | 'instrument'
  | 'lineage'
  | 'audit'
  | 'me'
  | 'principals'
  | 'delegations'
  | 'newnode'
  | 'schemas'
  | 'schema';

// sub selects a section inside a singleton: the To-do view's "review" or "signoff" tab.
export type Tab = { kind: Kind; id: string; title: string; sub?: string };

const KINDS: Kind[] = ['home', 'todo', 'experiment', 'run', 'instrument', 'lineage', 'audit', 'me', 'principals', 'delegations', 'newnode', 'schemas', 'schema'];

// Single-instance tabs: their id is their kind and their title is fixed.
export const SINGLETONS: Partial<Record<Kind, Tab>> = {
  home: { kind: 'home', id: 'home', title: 'Home' },
  todo: { kind: 'todo', id: 'todo', title: 'To do' },
  audit: { kind: 'audit', id: 'audit', title: 'Audit trail' },
  me: { kind: 'me', id: 'me', title: 'My account' },
  principals: { kind: 'principals', id: 'principals', title: 'Users and service accounts' },
  delegations: { kind: 'delegations', id: 'delegations', title: 'Agent delegations' },
  newnode: { kind: 'newnode', id: 'newnode', title: 'New sample or material' },
  schemas: { kind: 'schemas', id: 'schemas', title: 'Schemas' },
};

// Links from before SPEC-025 that now open a section of another tab (SPEC-025-R12).
const LEGACY: Record<string, Tab> = {
  inbox: { ...SINGLETONS.todo!, sub: 'review' },
  signoff: { ...SINGLETONS.todo!, sub: 'signoff' },
};

export function todoTab(sub: 'review' | 'signoff'): Tab {
  return { ...SINGLETONS.todo!, sub };
}

export function tabKey(tab: Pick<Tab, 'kind' | 'id'>): string {
  return `${tab.kind}:${tab.id}`;
}

// fromHash reads "#/<kind>/<id>" (or "#/audit", "#/todo/signoff"). The hash
// carries no title, so the tab gets a placeholder that the view renames once
// it has loaded.
function fromHash(hash: string): Tab | null {
  const m = /^#\/([a-z]+)(?:\/(.+))?$/.exec(hash);
  if (!m) return null;
  if (LEGACY[m[1]]) return LEGACY[m[1]];
  const kind = KINDS.find((k) => k === m[1]);
  if (!kind) return null;
  const single = SINGLETONS[kind];
  if (single) return m[2] ? { ...single, sub: m[2] } : single;
  if (!m[2]) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return { kind, id, title: `${kind} ${id.slice(0, 8)}` };
}

function toHash(tab: Tab): string {
  if (SINGLETONS[tab.kind]) return tab.sub ? `#/${tab.kind}/${tab.sub}` : `#/${tab.kind}`;
  return `#/${tab.kind}/${encodeURIComponent(tab.id)}`;
}

// Home opens when there is no hash (SPEC-025-R13).
function initial(): Tab {
  return fromHash(location.hash) ?? SINGLETONS.home!;
}

export function useTabs() {
  const [tabs, setTabs] = useState<Tab[]>(() => [initial()]);
  const [activeKey, setActiveKey] = useState<string | null>(() => tabKey(initial()));

  // open focuses the tab if it is already open (taking its new section, if
  // any), otherwise appends and activates it.
  const open = useCallback((tab: Tab) => {
    const key = tabKey(tab);
    setTabs((ts) => {
      const i = ts.findIndex((t) => tabKey(t) === key);
      if (i < 0) return [...ts, tab];
      if (tab.sub === undefined || ts[i].sub === tab.sub) return ts;
      return ts.map((t, j) => (j === i ? { ...t, sub: tab.sub } : t));
    });
    setActiveKey(key);
  }, []);

  const close = useCallback(
    (key: string) => {
      const i = tabs.findIndex((t) => tabKey(t) === key);
      if (i < 0) return;
      const rest = tabs.filter((t) => tabKey(t) !== key);
      setTabs(rest);
      if (key === activeKey) {
        const next = rest[Math.min(i, rest.length - 1)];
        setActiveKey(next ? tabKey(next) : null);
      }
    },
    [tabs, activeKey],
  );

  const closeAll = useCallback(() => {
    setTabs([]);
    setActiveKey(null);
  }, []);

  const rename = useCallback((key: string, title: string) => {
    setTabs((ts) => ts.map((t) => (tabKey(t) === key && t.title !== title ? { ...t, title } : t)));
  }, []);

  // setSub records the section a singleton shows, so the hash follows it.
  const setSub = useCallback((key: string, sub: string) => {
    setTabs((ts) => ts.map((t) => (tabKey(t) === key && t.sub !== sub ? { ...t, sub } : t)));
  }, []);

  const active = tabs.find((t) => tabKey(t) === activeKey) ?? null;

  // Active tab -> hash.
  useEffect(() => {
    if (active) {
      const want = toHash(active);
      if (location.hash !== want) location.hash = want;
    } else if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [active]);

  // Hash -> tabs (back/forward, pasted links).
  useEffect(() => {
    const onHash = () => {
      const t = fromHash(location.hash);
      if (t) open(t);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [open]);

  return { tabs, active, open, close, closeAll, rename, setSub };
}
