import { useEffect, useState } from 'react';
import { listAuditEvents, verifyAudit, type AuditEvent, type AuditVerify } from './api';
import ErrorMessage from './ErrorMessage';
import RecordDetails from './RecordDetails';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

// verifyOnOpen is a counter: each new non-zero value runs the chain verification (command palette, 3.9).
type Props = { id: string; verifyOnOpen?: number };

type Page = { status: 'loading' } | { status: 'error'; message: unknown } | { status: 'ready'; events: AuditEvent[] };
type Verify = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: unknown } | { status: 'ready'; result: AuditVerify };

const PAGE = 100;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function AuditView({ verifyOnOpen }: Props) {
  const [after, setAfter] = useState(0);
  const [filter, setFilter] = useState<{ type: string; id: string } | null>(null);
  const [type, setType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [page, setPage] = useState<Page>({ status: 'loading' });
  const [verify, setVerify] = useState<Verify>({ status: 'idle' });

  useEffect(() => {
    let live = true;
    setPage({ status: 'loading' });
    listAuditEvents(after, filter?.type, filter?.id)
      .then((events) => live && setPage({ status: 'ready', events }))
      .catch((err: unknown) => live && setPage({ status: 'error', message: err }));
    return () => {
      live = false;
    };
  }, [after, filter]);

  function runVerify() {
    setVerify({ status: 'loading' });
    verifyAudit()
      .then((result) => setVerify({ status: 'ready', result }))
      .catch((err: unknown) => setVerify({ status: 'error', message: err }));
  }

  useEffect(() => {
    if (verifyOnOpen) runVerify();
  }, [verifyOnOpen]);

  function applyFilter() {
    setAfter(0);
    setFilter({ type: type.trim(), id: entityId.trim() });
  }

  function clearFilter() {
    setType('');
    setEntityId('');
    setAfter(0);
    setFilter(null);
  }

  const events = page.status === 'ready' ? page.events : [];
  const canFilter = type.trim() !== '' && entityId.trim() !== '';
  const brokenAt = verify.status === 'ready' ? (verify.result.engine.break?.seq ?? verify.result.database.broken_at) : undefined;

  return (
    <article className="view">
      <div className="view-head">
        <div>
          <h1>Audit trail</h1>
          <p className="subtitle">Every change, by whom, when and why, in a tamper-evident chain.</p>
        </div>
      </div>

      <section className="card" aria-labelledby="verify-heading" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-head">
          <h2 id="verify-heading">Verify the chain</h2>
          <button type="button" className="btn btn-primary" onClick={runVerify} disabled={verify.status === 'loading'}>
            Verify chain
          </button>
        </div>
        <div aria-live="polite">
          {verify.status === 'idle' && <p className="muted" style={{ margin: 0 }}>Checks that no event was altered, removed or reordered.</p>}
          {verify.status === 'loading' && <p className="muted">Verifying…</p>}
          {verify.status === 'ready' && (
            <>
              <p className={verify.result.valid && verify.result.agree ? 'badge tone-ok' : 'badge tone-danger'} style={{ fontSize: 'var(--text-sm)' }}>
                {verify.result.valid && verify.result.agree ? <ShieldCheck size={16} aria-hidden="true" /> : <ShieldAlert size={16} aria-hidden="true" />}
                {verify.result.valid ? `Chain intact: ${verify.result.engine.events} events` : `Chain broken at event ${brokenAt}`}
                {!verify.result.agree && ' · engine and database disagree'}
              </p>
              <RecordDetails
                summary="Chain heads"
                rows={[
                  { label: `Engine head (event ${verify.result.engine.head.seq})`, value: verify.result.engine.head.hash },
                  { label: `Database head (event ${verify.result.database.head_seq})`, value: verify.result.database.head_hash },
                ]}
              />
            </>
          )}
        </div>
        {verify.status === 'error' && <ErrorMessage error={verify.message} action="verify the audit trail" />}
      </section>
      {verify.status === 'error' && <ErrorMessage error={verify.message} action="verify the audit trail" />}

      <h2>Events</h2>
      <form
        className="diff-controls"
        onSubmit={(e) => {
          e.preventDefault();
          if (canFilter) applyFilter();
        }}
      >
        <label>
          Entity type <input type="text" value={type} onChange={(e) => setType(e.target.value)} />
        </label>
        <label>
          Entity id <input type="text" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={!canFilter}>
          Filter
        </button>
        <button type="button" onClick={clearFilter}>
          Clear
        </button>
      </form>

      {page.status === 'loading' && <p className="muted">Loading events…</p>}
      {page.status === 'error' && <ErrorMessage error={page.message} action="load audit events" />}
      {page.status === 'ready' && events.length === 0 && <p className="muted">No events match.</p>}
      {events.length > 0 && (
        <div className="table-wrap">
        <table className="table mono-table">
          <caption className="sr-only">Audit events</caption>
          <thead>
            <tr>
              <th scope="col">Seq</th>
              <th scope="col">Time</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Entity type</th>
              <th scope="col">Entity id</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.seq}>
                <th scope="row" className="num">{ev.seq}</th>
                <td className="mono">{ev.occurred_at.slice(0, 19).replace('T', ' ')}</td>
                <td>{ev.actor}</td>
                <td>{ev.action}</td>
                <td>{ev.entity_type}</td>
                <td className="mono">{ev.entity_id}</td>
                <td>{ev.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <p className="diff-controls">
        <button type="button" disabled={after === 0} onClick={() => setAfter(0)}>
          First page
        </button>
        <button type="button" disabled={events.length < PAGE} onClick={() => setAfter(events[events.length - 1].seq)}>
          Next page
        </button>
      </p>
    </article>
  );
}
