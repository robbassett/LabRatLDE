import { useState, type FormEvent } from 'react';
import { ApiError, transitionRun, type Me, type RunDetail, type RunState } from './api';
import ErrorMessage from './ErrorMessage';
import Field from './Field';
import { STATE_TONE } from './glossary';
import { hasRole } from './me';
import StatusBadge from './StatusBadge';
import { toast } from './Toasts';
import { Dialog, Menu, MenuItem } from './ui';

type Move = { to: RunState; label: string; done: string; danger?: boolean; reason: string };

const START: Move = { to: 'running', label: 'Start run', done: 'started', reason: 'Started at the bench' };
const COMPLETE: Move = { to: 'completed', label: 'Complete run', done: 'completed', reason: 'Work finished' };
const PAUSE: Move = { to: 'paused', label: 'Pause', done: 'paused', reason: '' };
const RESUME: Move = { to: 'running', label: 'Resume', done: 'resumed', reason: '' };
const FAIL: Move = { to: 'failed', label: 'Mark failed', done: 'marked failed', danger: true, reason: '' };
const ABORT: Move = { to: 'aborted', label: 'Abort', done: 'aborted', danger: true, reason: '' };

// The next action by state, and the rest under More (design §3.6).
const MOVES: Partial<Record<RunState, { primary: Move; more: Move[] }>> = {
  planned: { primary: START, more: [ABORT] },
  running: { primary: COMPLETE, more: [PAUSE, FAIL, ABORT] },
  paused: { primary: RESUME, more: [ABORT] },
};

const IRREVERSIBLE: Partial<Record<RunState, string>> = {
  aborted: "This can't be undone. The run will stay in the record as aborted.",
  failed: "This can't be undone. The run will stay in the record as failed.",
};

// The stepper shows the happy path; an aborted or failed run shows where it stopped.
function steps(state: RunState): { key: string; label: string; done: boolean; current: boolean; tone?: string }[] {
  const order: RunState[] = ['planned', 'running', 'completed', 'signed'];
  const shown = state === 'failed' ? ['planned', 'running', 'failed', 'signed'] : state === 'aborted' ? ['planned', 'aborted'] : order;
  const at = state === 'paused' ? 1 : shown.indexOf(state);
  return shown.map((s, i) => ({
    key: s,
    label: s === 'running' && state === 'paused' ? 'Paused' : s[0].toUpperCase() + s.slice(1),
    done: i < at,
    current: i === at,
    tone: i === at ? STATE_TONE[state] : undefined,
  }));
}

// RunLifecycle (SPEC-025-R23, R24): the stepper and the action bar. Every
// transition asks for a reason; abort and fail say they can't be undone.
export default function RunLifecycle({
  run,
  me,
  onChanged,
  onStartProblems,
}: {
  run: RunDetail;
  me: Me | null;
  onChanged: () => void;
  onStartProblems: (err: unknown) => void;
}) {
  const [move, setMove] = useState<Move | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const moves = MOVES[run.state];
  const canAct = hasRole(me, 'scientist');

  const valid = run.signatures.filter((s) => s.valid).length;
  const total = run.signing_policy.length;
  const next = run.signing_policy.find((p) => !run.signatures.some((s) => s.valid && s.step === p.step));
  const canSign =
    me !== null &&
    next !== undefined &&
    me.kind === 'human' &&
    hasRole(me, next.role) &&
    !run.signatures.some((s) => s.valid && s.signer === me.handle);

  function choose(m: Move) {
    setMove(m);
    setReason(m.reason);
    setError(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!move) return;
    setSaving(true);
    setError(null);
    try {
      await transitionRun(run.id, move.to, reason.trim());
      toast(`Run ${move.done}`);
      if (move.to === 'running') onStartProblems(null);
      setMove(null);
      onChanged();
    } catch (err: unknown) {
      // A refused start lists the parameter problems in the Problems panel (SPEC-009-R13).
      if (move.to === 'running' && err instanceof ApiError && err.problems.length > 0) onStartProblems(err);
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="view-head">
        <ol className="stepper" aria-label="Run progress" style={{ flex: '1 1 24rem', margin: 0 }}>
          {steps(run.state).map((s) => (
            <li
              key={s.key}
              data-done={s.done}
              data-current={s.current}
              className={s.tone ? `tone-${s.tone}` : undefined}
              aria-current={s.current ? 'step' : undefined}
            >
              <span className="node" aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ol>
        <div className="actions">
          <StatusBadge state={run.state} />
          {moves && canAct && (
            <>
              <button type="button" className="btn btn-primary" onClick={() => choose(moves.primary)}>
                {moves.primary.label}
              </button>
              <Menu label="More" ariaLabel="More run actions" onAction={(k) => choose(moves.more.find((m) => m.to === k)!)}>
                {moves.more.map((m) => (
                  <MenuItem key={m.to} id={m.to} danger={m.danger}>
                    {m.label}
                  </MenuItem>
                ))}
              </Menu>
            </>
          )}
          {(run.state === 'completed' || run.state === 'failed') &&
            total > 0 &&
            (canSign ? (
              // The Signatures panel owns signing and its re-authentication (SPEC-008); this presses its button.
              <button type="button" className="btn btn-primary" onClick={() => document.getElementById('sign-next')?.click()}>
                Sign as {next!.meaning}
              </button>
            ) : (
              <span className="muted">
                Waiting for signatures ({valid} of {total})
              </span>
            ))}
        </div>
      </div>

      <Dialog title={move ? `${move.label}?` : ''} isOpen={move !== null} onClose={() => setMove(null)} role={move?.danger ? 'alertdialog' : 'dialog'}>
        {move && (
          <form onSubmit={submit}>
            {IRREVERSIBLE[move.to] && <p className="error">{IRREVERSIBLE[move.to]}</p>}
            <Field label="Reason" hint="Recorded in the audit trail with your name and the time.">
              <input value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus disabled={saving} />
            </Field>
            <ErrorMessage error={error} action={`${move.label.toLowerCase()}`} />
            <div className="dialog-foot">
              <button type="button" className="btn" onClick={() => setMove(null)} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className={move.danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={saving || reason.trim() === ''}>
                {move.label}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
