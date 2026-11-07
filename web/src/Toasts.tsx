import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'success' | 'error' | 'info';
type ToastItem = { id: number; message: string; kind: ToastKind };

const EVENT = 'labrat:toast';

// toast confirms an action (SPEC-025-R20). Any component may call it; the one
// <Toasts/> in the workspace shows it.
export function toast(message: string, kind: ToastKind = 'success') {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { message, kind } }));
}

// onToast lets other parts react to a toast, e.g. the To-do count after a decision.
export function onToast(fn: (kind: ToastKind) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<{ kind: ToastKind }>).detail.kind);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

const TONE: Record<ToastKind, string> = { success: 'ok', error: 'danger', info: 'info' };
const ICON = { success: CircleCheck, error: CircleX, info: Info };

function Toast({ t, onClose }: { t: ToastItem; onClose: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const left = useRef(5000);
  const started = useRef(0);

  // Success and info leave after 5 s, paused while hovered or focused; errors stay until closed.
  useEffect(() => {
    if (t.kind === 'error' || paused) return;
    started.current = Date.now();
    const timer = setTimeout(() => onClose(t.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started.current;
    };
  }, [paused, t.id, t.kind, onClose]);

  const Icon = ICON[t.kind];
  return (
    <li
      className={`toast tone-${TONE[t.kind]}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon size={18} aria-hidden="true" />
      <p>{t.message}</p>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" onClick={() => onClose(t.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

export default function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  useEffect(() => {
    const h = (e: Event) => {
      const { message, kind } = (e as CustomEvent<{ message: string; kind: ToastKind }>).detail;
      setItems((xs) => [...xs.slice(-4), { id: next.current++, message, kind }]);
    };
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);

  const close = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  // The live region exists before any toast arrives, so screen readers announce each one.
  return (
    <ul className="toasts" role="status" aria-live="polite" aria-label="Notifications">
      {items.map((t) => (
        <Toast key={t.id} t={t} onClose={close} />
      ))}
    </ul>
  );
}
