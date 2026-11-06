import { useEffect, useState } from 'react';
import {
  ApiError,
  blame,
  editRunParams,
  getRun,
  listAuditEvents,
  proposeChangeSet,
  transitionRun,
  type AuditEvent,
  type RunDetail,
  type SchemaProblem,
} from './api';
import EditField from './EditField';
import Notes from './Notes';
import SignaturesPanel from './SignaturesPanel';
import type { Tab } from './tabs';

// The explorer supplies the tab title (the run label); RunDetail has none, so rename is unused.
type Props = { id: string; open: (t: Tab) => void; rename: (key: string, title: string) => void };

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; run: RunDetail; events: AuditEvent[]; changed: boolean };

// loadRun fetches what the view shows, plus whether any field has been revised.
function loadRun(id: string) {
  return Promise.all([getRun(id), listAuditEvents(0, 'run', id), blame('run', id)]).then(([run, events, b]) => ({
    run,
    events,
    changed: b.fields.some((f) => f.rev > 1),
  }));
}

export default function RunView({ id, open }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [startError, setStartError] = useState<{ message: string; problems: SchemaProblem[] } | null>(null);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadRun(id)
      .then((d) => {
        if (live) setState({ status: 'ready', ...d });
      })
      .catch((err: unknown) => {
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (state.status === 'loading') return <p className="muted">Loading run…</p>;
  if (state.status === 'error') return <p role="alert" className="error">{state.message}</p>;

  const { run, events, changed } = state;
  // A run with a valid signature changes only through a reviewed correction (SPEC-008-R09, R10).
  // An aborted run, or a signed one with no signature rows (signed before SPEC-008), can't be corrected.
  const proposeOnly = run.signatures.some((s) => s.valid);
  const readOnly = !proposeOnly && (run.state === 'aborted' || run.state === 'signed');

  // A refused start (422) lists the params problems here and in the Problems panel (SPEC-009-R13).
  async function start() {
    setStartError(null);
    try {
      await transitionRun(id, 'running', 'Start run');
      setState({ status: 'ready', ...(await loadRun(id)) });
      window.dispatchEvent(new CustomEvent('labrat:problems', { detail: { source: `run:${id}`, problems: [] } }));
    } catch (err: unknown) {
      const problems = err instanceof ApiError ? err.problems : [];
      setStartError({ message: err instanceof Error ? err.message : String(err), problems });
      window.dispatchEvent(new CustomEvent('labrat:problems', { detail: { source: `run:${id}`, problems } }));
    }
  }

  return (
    <article className="view">
      <h1>Run</h1>
      <p>
        State: <strong>{run.state}</strong>
      </p>
      {run.state === 'planned' && (
        <p>
          <button type="button" onClick={start}>
            Start run
          </button>
        </p>
      )}
      {startError && (
        <div role="alert" className="error">
          <p>{startError.message}</p>
          <ul>
            {startError.problems.map((p, i) => (
              <li key={i}>
                {p.pointer !== '' && <code>{p.pointer}</code>} {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>Started: {run.started_at ?? 'not started'}</p>
      <p>Finished: {run.finished_at ?? 'not finished'}</p>
      <p>
        <button type="button" onClick={() => open({ kind: 'lineage', id: run.node_id, title: 'run' })}>
          Open lineage
        </button>
      </p>

      <h2>Protocol</h2>
      <p>
        v{run.protocol_version} <span className="mono hash">{run.protocol_sha256}</span>
      </p>

      <h2>Params</h2>
      <EditField
        label="Params"
        value={JSON.stringify(run.params ?? {}, null, 2)}
        json
        schemaVersionId={run.params_schema_version_id}
        warnOnly={run.state === 'planned'}
        changed={changed}
        proposeOnly={proposeOnly}
        readOnly={readOnly}
        onSave={async (value, reason) => {
          const params = JSON.parse(value) as Record<string, unknown>;
          if (proposeOnly) {
            await proposeChangeSet(`Correct params of run ${id.slice(0, 8)}`, reason, [{ op: 'update_run_params', run_id: id, params }]);
            return 'proposed';
          }
          await editRunParams(id, params, reason);
          setState({ status: 'ready', ...(await loadRun(id)) });
        }}
      />

      <h2>Inputs</h2>
      {run.inputs.length === 0 ? (
        <p className="muted">No inputs</p>
      ) : (
        <table className="data">
          <caption className="sr-only">Run inputs</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          <tbody>
            {run.inputs.map((i) => (
              <tr key={i.node_id}>
                <td>{i.kind}</td>
                <td>{i.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Datasets</h2>
      {run.datasets.length === 0 ? (
        <p className="muted">No datasets</p>
      ) : (
        <table className="data">
          <caption className="sr-only">Generated datasets</caption>
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Readings</th>
              <th scope="col">SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {run.datasets.map((d) => (
              <tr key={d.node_id}>
                <td>{d.label}</td>
                <td>{d.count ?? 'not recorded'}</td>
                <td className="mono hash">{d.sha256 ?? 'not recorded'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>State history</h2>
      {events.length === 0 ? (
        <p className="muted">No events</p>
      ) : (
        <table className="data">
          <caption className="sr-only">Run state history</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.seq}>
                <td>{e.occurred_at}</td>
                <td>{e.actor}</td>
                <td>{e.action}</td>
                <td>{e.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SignaturesPanel
        run={run}
        onSigned={() => {
          loadRun(id)
            .then((d) => setState({ status: 'ready', ...d }))
            .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
        }}
      />

      <section>
        <h2>Notes</h2>
        <Notes nodeId={run.node_id} proposeOnly={proposeOnly} readOnly={readOnly} />
      </section>
    </article>
  );
}
