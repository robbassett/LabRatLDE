import { Check, ListChecks, LogOut, Monitor, Moon, PanelLeft, Plus, Search, Sun, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Text } from 'react-aria-components';
import { openNew, openPalette, type NewKind } from './events';
import LabRatMark from './LabRatMark';
import { hasRole, useMe } from './me';
import { SINGLETONS, todoTab, type Tab } from './tabs';
import { setTheme, storedTheme, type ThemeChoice } from './theme';
import { IconButton, Menu, MenuItem, MenuSeparator } from './ui';

function initials(handle: string): string {
  const parts = handle.split(/[\s._@-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

const THEMES: { id: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'system', label: 'System', Icon: Monitor },
];

// TopBar (SPEC-025-R08, R31): the mark and wordmark, search, New, To do with
// its count, and the user menu with theme and sign-out.
export default function TopBar({
  handle,
  todoCount,
  open,
  onSignOut,
  onOpenDrawer,
}: {
  handle: string;
  todoCount: number | null;
  open: (t: Tab) => void;
  onSignOut: () => void;
  onOpenDrawer: () => void;
}) {
  const me = useMe();
  const [theme, setThemeState] = useState<ThemeChoice>(storedTheme);
  const canCreate = hasRole(me, 'scientist');
  const n = todoCount ?? 0;

  function onUser(key: string | number) {
    const k = String(key);
    if (k === 'me') open(SINGLETONS.me!);
    else if (k === 'signout') onSignOut();
    else if (k.startsWith('theme:')) {
      const choice = k.slice(6) as ThemeChoice;
      setTheme(choice);
      setThemeState(choice);
    }
  }

  return (
    <header className="topbar">
      <IconButton label="Open navigation" className="btn btn-ghost btn-icon drawer-toggle" onPress={onOpenDrawer}>
        <PanelLeft size={18} aria-hidden="true" />
      </IconButton>
      <a className="brand" href="#/home" aria-label="LabRat home">
        <LabRatMark size={24} />
        <span className="brand-word">LabRat</span>
      </a>
      <button type="button" className="btn search-button" onClick={openPalette} aria-keyshortcuts="Control+K">
        <Search size={16} aria-hidden="true" />
        <span className="search-label">Search or jump to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <Menu
        className="btn btn-primary"
        icon={<Plus size={16} aria-hidden="true" />}
        label={<span className="hide-narrow">New</span>}
        ariaLabel="New"
        onAction={(k) => openNew(String(k) as NewKind)}
      >
        <MenuItem id="experiment" isDisabled={!canCreate} textValue="New experiment">
          <Text slot="label">New experiment</Text>
          {!canCreate && (
            <Text slot="description" className="menu-hint">
              Needs the scientist role
            </Text>
          )}
        </MenuItem>
        <MenuItem id="run" isDisabled={!canCreate} textValue="New run">
          <Text slot="label">New run</Text>
          {!canCreate && (
            <Text slot="description" className="menu-hint">
              Needs the scientist role
            </Text>
          )}
        </MenuItem>
        <MenuItem id="record" isDisabled={!canCreate} textValue="New sample or material">
          <Text slot="label">New sample or material</Text>
          {!canCreate && (
            <Text slot="description" className="menu-hint">
              Needs the scientist role
            </Text>
          )}
        </MenuItem>
        <MenuItem id="instrument" isDisabled={!canCreate} textValue="Register instrument">
          <Text slot="label">Register instrument</Text>
          {!canCreate && (
            <Text slot="description" className="menu-hint">
              Needs the scientist role
            </Text>
          )}
        </MenuItem>
      </Menu>
      <button
        type="button"
        className="btn todo-button"
        data-pending={n > 0}
        onClick={() => open(todoTab('review'))}
        aria-label={`To do, ${n} waiting`}
      >
        <ListChecks size={16} aria-hidden="true" />
        <span className="hide-narrow">To do</span>
        <span className="count" data-zero={n === 0} aria-hidden="true">
          {todoCount === null ? '–' : n}
        </span>
      </button>
      <Menu className="btn user-button" ariaLabel={`Account menu for ${handle}`} icon={<span className="avatar">{initials(handle)}</span>} onAction={onUser}>
        <MenuItem id="me" textValue="My account">
          <UserRound size={16} aria-hidden="true" /> My account ({handle})
        </MenuItem>
        <MenuSeparator />
        {THEMES.map(({ id, label, Icon }) => (
          <MenuItem key={id} id={`theme:${id}`} textValue={`Theme: ${label}`}>
            <Icon size={16} aria-hidden="true" /> {label} theme
            {theme === id && <Check size={14} aria-label="selected" style={{ marginLeft: 'auto' }} />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem id="signout" textValue="Sign out">
          <LogOut size={16} aria-hidden="true" /> Sign out
        </MenuItem>
      </Menu>
    </header>
  );
}
