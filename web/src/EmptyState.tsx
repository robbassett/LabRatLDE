import type { ReactNode } from 'react';

// EmptyState says what belongs here and offers the next step (SPEC-025-R15).
export default function EmptyState({
  icon,
  text,
  action,
  compact,
}: {
  icon?: ReactNode;
  text: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'empty compact' : 'empty'}>
      {!compact && icon}
      <p>{text}</p>
      {action}
    </div>
  );
}
