// The user's theme choice (SPEC-025-R02): light, dark, or follow the system.
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'labrat.theme';

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function applyStoredTheme() {
  apply(storedTheme());
}

// setTheme applies and remembers the choice, and tells the lineage graph to restyle.
export function setTheme(choice: ThemeChoice) {
  apply(choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage unavailable: the choice lasts until reload.
  }
  window.dispatchEvent(new Event('labrat:theme'));
}
