import type { ReactNode } from 'react';

// Empty-state illustrations (SPEC-025 design §3.0): built only from the mark's
// primitives (circle, quarter-circle, square) in brand teal and the two tints.
// Decorative: the sentence beside them carries the meaning.
const T = 'var(--brand-teal)';
const B = 'var(--brand-blue)';
const A = 'var(--brand-aqua)';

function Art({ children }: { children: ReactNode }) {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true" focusable="false" className="illustration">
      {children}
    </svg>
  );
}

// A quarter-circle with its corner at (x, y), radius r, opening towards (dx, dy) = ±1.
function quarter(x: number, y: number, r: number, dx: 1 | -1, dy: 1 | -1, fill: string) {
  const sweep = dx * dy > 0 ? 1 : 0;
  return <path d={`M${x} ${y}L${x + dx * r} ${y}A${r} ${r} 0 0 ${sweep} ${x} ${y + dy * r}Z`} style={{ fill: fill }} />;
}

// Experiments: a flask read as a circle under a square neck.
export function ExperimentsArt() {
  return (
    <Art>
      <rect x="38" y="12" width="20" height="28" style={{ fill: B }} />
      <circle cx="48" cy="58" r="26" style={{ fill: A }} />
      {quarter(22, 84, 26, 1, -1, T)}
    </Art>
  );
}

// Runs: three stepper nodes, the first one full.
export function RunsArt() {
  return (
    <Art>
      <rect x="12" y="46" width="72" height="4" style={{ fill: B }} />
      <circle cx="18" cy="48" r="10" style={{ fill: T }} />
      <circle cx="48" cy="48" r="10" style={{ fill: A }} />
      <circle cx="78" cy="48" r="10" style={{ fill: B }} />
    </Art>
  );
}

// Inputs: squares flowing into a circle.
export function InputsArt() {
  return (
    <Art>
      <rect x="8" y="18" width="22" height="22" style={{ fill: B }} />
      <rect x="8" y="56" width="22" height="22" style={{ fill: A }} />
      <circle cx="66" cy="48" r="22" style={{ fill: T }} />
      {quarter(30, 48, 14, 1, -1, A)}
    </Art>
  );
}

// Data: a column of readings as quarter-circles stacked on a square.
export function DataArt() {
  return (
    <Art>
      <rect x="14" y="62" width="68" height="20" style={{ fill: A }} />
      {quarter(14, 62, 24, 1, -1, B)}
      {quarter(48, 62, 30, 1, -1, T)}
      <circle cx="74" cy="22" r="8" style={{ fill: B }} />
    </Art>
  );
}

// To-do: a square with a circle ticked off.
export function ToDoArt() {
  return (
    <Art>
      <rect x="14" y="14" width="56" height="68" style={{ fill: B }} />
      <circle cx="68" cy="66" r="18" style={{ fill: T }} />
      {quarter(14, 14, 22, 1, 1, A)}
    </Art>
  );
}

// Search: a lens as a ring over a quarter-circle handle.
export function SearchArt() {
  return (
    <Art>
      {quarter(88, 88, 30, -1, -1, B)}
      <circle cx="40" cy="40" r="28" style={{ fill: T }} />
      <circle cx="40" cy="40" r="17" style={{ fill: A }} />
    </Art>
  );
}
