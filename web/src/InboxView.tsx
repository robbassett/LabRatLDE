import { useEffect, useRef, useState, type FormEvent } from 'react';
import EmptyState from './EmptyState';
import ErrorMessage from './ErrorMessage';
import { ToDoArt } from './illustrations';
import { loadMe } from './me';
import { toast } from './Toasts';
import {
  ApiError,
  decideChangeSet,
  getChangeSet,
  listChangeSets,
  type ChangeItem,
  type ChangeSetDetail,
  type ChangeSetSource,
  type ChangeSetSummary,
} from './api';

type Decision = 'commit' | 'reject' | 'withdraw';

const GROUPS: { source: ChangeSetSource; heading: string }[] = [
  { source: 'human', heading: 'From people' },
  { source: 'parser', heading: 'From instrument parsers' },
  { source: 'agent', heading: 'From agents' },
];

// CREATING lists the ops that add a record. They show as a one-line summary, not a field table.
const CREATING = new Set<ChangeItem['op']>(['add_node', 'add_edge', 'add_note']);

const DECISION_LABEL: Record<Decision, string> = { commit: 'Commit', reject: 'Reject', withdraw: 'Withdraw' };
const DECIDED: Record<Decision, string> = { commit: 'committed', reject: 'rejected', withdraw: 'withdrawn' };

// allProposed reads every page of proposed change sets, following next_cursor until it is null.
async function allProposed(): Promise<ChangeSetSummary[]> {
  const out: ChangeSetSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await listChangeSets({ state: 'proposed', cursor });
    out.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

// fieldsOf lists the fields an update op sets, with the proposed value of each.
function fieldsOf(item: ChangeItem): { field: string; proposed: unknown }[] {
  switch (item.op) {
    case 'update_node':
      return [
        ...(item.label !== undefined ? [{ field: 'label', proposed: item.label }] : []),
        ...(item.attrs !== undefined ? [{ field: 'attrs', proposed: item.attrs }] : []),
      ];
    case 'update_run_params':
      return [{ field: 'params', proposed: item.params }];
    case 'set_experiment_title':
      return [{ field: 'title', proposed: item.title }];
    case 'edit_note':
      return [{ field: 'body', proposed: item.body }];
    default:
      return [];
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// summaryOf describes a creating op in one line. The item holds ids, not labels, for edges and notes.
function summaryOf(item: ChangeItem): string {
  switch (item.op) {
    case 'add_node':
      return `add ${item.kind} ${item.label}`;
    case 'add_edge':
      return `add edge ${shortId(item.from)} →${item.relation}→ ${shortId(item.to)}`;
    case 'add_note':
      return `add note on ${shortId(item.node_id)}`;
    default:
      return item.op;
  }
}

// show renders a value as JSON. A missing value reads "none".
function show(v: unknown): string {
  return v === undefined ? 'none' : JSON.stringify(v);
}

function ChangeItemView({ item, current }: { item: ChangeItem; current: unknown }) {
  if (CREATING.has(item.op)) return <p>{summaryOf(item)}</p>;
  // current is the record's latest revision value, keyed by field (or null when there is none).
  const cur = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
  return (
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Current</th>
          <th scope="col">Proposed</th>
        </tr>
      </thead>
      <tbody>
        {fieldsOf(item).map(({ field, proposed }) => (
          <tr key={field}>
            <th scope="row">{field}</th>
            <td className="mono inbox-value">{show(cur[field])}</td>
            <td className="mono inbox-value">{show(proposed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// humanOf names the human behind an actor: "dana via bot" acts for dana.
function humanOf(actor: string): string {
  return actor.split(' via ')[0];
}

type CardProps = { summary: ChangeSetSummary; actor: string | null; onDecided: () => void };

// ChangeSetCard shows one proposal. Expanding it loads the items. Commit, Reject and Withdraw each ask for a reason first.
function ChangeSetCard({ summary, actor, onDecided }: CardProps) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ChangeSetDetail | null>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [changedNotice, setChangedNotice] = useState<string | null>(null);

  const panel = `inbox-panel-${summary.id}`;
  const isAuthor = actor !== null && summary.author === actor;
  // A correction can't be committed by its author, or by the human an agent author acts for (SPEC-008-R09).
  const invalidated = detail ? detail.invalidates.reduce((n, r) => n + r.signatures, 0) : 0;
  const hideCommit = detail !== null && detail.invalidates.length > 0 && actor !== null && humanOf(summary.author) === humanOf(actor);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !detail && !detailError) {
      getChangeSet(summary.id)
        .then(setDetail)
        .catch((err: unknown) => setDetailError(err));
    }
  }

  function choose(d: Decision) {
    setDecision(d);
    setReason('');
    setError(null);
    setChangedNotice(null);
  }

  async function decide(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!decision) return;
    setSaving(true);
    setError(null);
    try {
      // The hash is of the items shown, so a commit can't land on items the reviewer never read (SPEC-008-R20).
      await decideChangeSet(summary.id, decision, reason.trim(), decision === 'commit' ? detail?.items_sha256 : undefined);
      // A commit changes records, so the open views should reload their values.
      if (decision === 'commit') window.dispatchEvent(new CustomEvent('labrat:revised'));
      toast(`Change request "${summary.title}" ${DECIDED[decision]}`);
      setDecision(null);
      onDecided();
    } catch (err: unknown) {
      if (decision === 'commit' && err instanceof ApiError && err.status === 409) {
        // The items may have been replaced since they were shown: reload them for the reviewer to read again.
        try {
          const fresh = await getChangeSet(summary.id);
          const stale = fresh.items_sha256 !== detail?.items_sha256;
          setDetail(fresh);
          if (stale) {
            setDecision(null);
            setChangedNotice('The items changed since you opened this change request. Read the reloaded items, then commit again.');
            return;
          }
        } catch {
          // Fall through to the server's message.
        }
      }
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="inbox-card">
      <h3 className="inbox-title">
        <button type="button" aria-expanded={open} aria-controls={panel} onClick={toggle}>
          {summary.title}
        </button>
      </h3>
      <p className="note-meta muted">
        <span>{summary.author}</span> · <time dateTime={summary.created_at}>{summary.created_at}</time> ·{' '}
        {summary.items} {summary.items === 1 ? 'item' : 'items'}
      </p>
      <p className="inbox-reason">{summary.reason}</p>

      {open && (
        <div id={panel} className="inbox-panel">
          <ErrorMessage error={detailError} action="load the change request" />
          {!detail && !detailError && <p className="muted">Loading items…</p>}
          {detail && (
            <ol className="inbox-items">
              {detail.items.map((item, i) => (
                <li key={i} className="inbox-item">
                  <p className="inbox-op">
                    {i + 1}. <span className="mono">{item.op}</span>
                  </p>
                  <ChangeItemView item={item} current={detail.current[i]} />
                </li>
              ))}
            </ol>
          )}

          {detail && detail.invalidates.length > 0 && (
            <p className="error">
              Committing invalidates {invalidated} {invalidated === 1 ? 'signature' : 'signatures'} and returns{' '}
              {detail.invalidates.length === 1 ? 'the run' : `${detail.invalidates.length} runs`} for re-signing.
            </p>
          )}
          {changedNotice && (
            <p role="alert" className="error">
              {changedNotice}
            </p>
          )}

          {decision === null ? (
            <div className="actions">
              {detail && !hideCommit && (
                <button type="button" className="btn btn-primary" aria-label={`Commit ${summary.title}`} onClick={() => choose('commit')}>
                  Commit
                </button>
              )}
              <button type="button" className="btn btn-danger" aria-label={`Reject ${summary.title}`} onClick={() => choose('reject')}>
                Reject
              </button>
              {isAuthor && (
                <button type="button" aria-label={`Withdraw ${summary.title}`} onClick={() => choose('withdraw')}>
                  Withdraw
                </button>
              )}
            </div>
          ) : (
            <form className="edit-form" onSubmit={decide}>
              <label>
                Reason to {decision}
                <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} required autoFocus />
              </label>
              <ErrorMessage error={error} action={`${decision} the change request`} />
              <div className="actions">
                <button type="submit" className={decision === 'commit' ? 'btn btn-primary' : 'btn btn-danger'} disabled={saving || reason.trim() === ''}>
                  Confirm {DECISION_LABEL[decision].toLowerCase()}
                </button>
                <button type="button" onClick={() => setDecision(null)} disabled={saving}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

// InboxView lists proposed change requests, grouped by who proposed them. It is the Review
// changes section of the To-do view (SPEC-007 §3, SPEC-025-R12).
export default function InboxView() {
  // items is null until the first load completes.
  const [items, setItems] = useState<ChangeSetSummary[] | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const heading = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let live = true;
    allProposed()
      .then((xs) => live && setItems(xs))
      .catch((err: unknown) => live && setError(err));
    loadMe()
      .then((me) => live && setActor(me.actor))
      .catch((err: unknown) => live && setError(err));
    return () => {
      live = false;
    };
  }, []);

  function reload() {
    allProposed()
      .then((xs) => {
        setItems(xs);
        setError(null);
      })
      .catch((err: unknown) => setError(err));
  }

  // After a decision the list reloads, and focus moves to the intro so it is not lost with the card.
  function decided() {
    reload();
    heading.current?.focus();
  }

  return (
    <section aria-label="Review changes" className="inbox">
      <p ref={heading} tabIndex={-1} className="muted">
        Proposed changes to records, waiting for a decision. Open one to see each change beside the current value.
      </p>
      <ErrorMessage error={error} action="load change requests" />
      {items === null && !error && <p className="muted">Loading change requests…</p>}
      {items !== null && items.length === 0 && <EmptyState icon={<ToDoArt />} text="No change requests are waiting. Proposed corrections and agent edits appear here." />}

      {items !== null &&
        items.length > 0 &&
        GROUPS.map(({ source, heading: title }) => {
          const group = items.filter((s) => s.source === source);
          if (group.length === 0) return null;
          return (
            <section key={source} aria-labelledby={`inbox-${source}`}>
              <h2 id={`inbox-${source}`}>{title}</h2>
              <ul className="inbox-list">
                {group.map((s) => (
                  <ChangeSetCard key={s.id} summary={s} actor={actor} onDecided={decided} />
                ))}
              </ul>
            </section>
          );
        })}
    </section>
  );
}
