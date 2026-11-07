// Window events that connect parts of the shell without threading props
// through every view, in the style of labrat:problems.

export type NewKind = 'experiment' | 'run' | 'instrument' | 'record';

// openNew asks the workspace to open a create dialog (top-bar New menu, sidebar "+", Home).
// For a run, experimentId preselects the experiment.
export function openNew(kind: NewKind, experimentId?: string) {
  window.dispatchEvent(new CustomEvent('labrat:new', { detail: { kind, experimentId } }));
}

// refreshSidebar reloads the sidebar's lists after a create.
export function refreshSidebar() {
  window.dispatchEvent(new Event('labrat:refresh'));
}

export function openPalette() {
  window.dispatchEvent(new Event('labrat:palette'));
}

export function on<T = undefined>(name: string, fn: (detail: T) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<T>).detail);
  window.addEventListener(name, h);
  return () => window.removeEventListener(name, h);
}
