import { Ban, BadgeCheck, CircleCheck, CircleDashed, CirclePause, CirclePlay, CircleX, type LucideIcon } from 'lucide-react';
import type { RunState } from './api';
import { STATE_TONE, STATE_WORD } from './glossary';

const ICON: Record<RunState, LucideIcon> = {
  planned: CircleDashed,
  running: CirclePlay,
  paused: CirclePause,
  completed: CircleCheck,
  failed: CircleX,
  aborted: Ban,
  signed: BadgeCheck,
};

// StatusBadge shows a run state as colour, icon and word together, never colour
// alone (SPEC-025-R06, design §3.4).
export default function StatusBadge({ state }: { state: RunState }) {
  const Icon = ICON[state] ?? CircleDashed;
  return (
    <span className={`badge tone-${STATE_TONE[state] ?? 'muted'}`}>
      <Icon aria-hidden="true" />
      {STATE_WORD[state] ?? state}
    </span>
  );
}

// StateDot is the compact form for the sidebar: a coloured circle whose label carries the word.
export function StateDot({ state }: { state: RunState }) {
  return <span className={`dot tone-${STATE_TONE[state] ?? 'muted'}`} role="img" aria-label={STATE_WORD[state] ?? state} />;
}
