import { CircleX } from 'lucide-react';
import { explain } from './errors';

// ErrorMessage shows a failed call next to the control that made it (SPEC-025-R19).
export default function ErrorMessage({ error, action }: { error: unknown; action: string }) {
  if (error === null || error === undefined) return null;
  const e = explain(error, action);
  return (
    <div className="error-message" role="alert">
      <CircleX size={18} aria-hidden="true" />
      <p>
        <strong>{e.title}.</strong> {e.detail}
      </p>
      <p>{e.hint}</p>
      {e.server && <p className="muted mono">{e.server}</p>}
    </div>
  );
}
