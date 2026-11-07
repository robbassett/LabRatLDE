import { GitBranch } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  blame,
  editRunParams,
  getExperiment,
  getRun,
  proposeChangeSet,
  type Experiment,
  type Instrument,
  type RunDetail,
  type SchemaProblem,
} from './api';
import EditField from './EditField';
import ErrorMessage from './ErrorMessage';
import { refreshSidebar } from './events';
import { TERM } from './glossary';
import { hasRole, useMe } from './me';
import Notes from './Notes';
import RecordDetails from './RecordDetails';
import RunData from './RunData';
import RunInputs from './RunInputs';
import RunLifecycle from './RunLifecycle';
import SignaturesPanel, { utc } from './SignaturesPanel';
import type { Tab } from './tabs';

type Props = { id: string; title: string; open: (t: Tab) => void; rename: (key: string, title: string) => void; instruments: Instrument[] };

type Loaded = { run: RunDetail; exp: Experiment | null; changed: boolean };

type State = { status: 'loading' } | { status: 'error'; error: unknown } | ({ status: 'ready' } & Loaded);

// loadRun fetches what the view shows, plus whether any field has been revised.
async function loadRun(id: string): Promise<Loaded> {
  const [run, b] = await Promise.all([getRun(id), blame('run', id)]);
  const exp = await getExperiment(run.experiment_id).catch(() => null);
  return { run, exp, changed: b.fields.some((f) => f.rev > 1) };
}

function publishProblems(id: string, problems: SchemaProblem[]) {
  window.dispatchEvent(new CustomEvent('labrat:problems', { detail: { source: `run:${id}`, problems } }));
}

// RunView (SPEC-025 design §3.6): where the run is in its life and what to do
// next, then parameters, inputs, data, signatures and notes. Identifiers and
// digests sit in Record details.
export default function RunView({ id, title, open, instruments }: Props) {
  const me = useMe();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [startError, setStartError] = useState<ApiError | null>(null);

  const reload = useCallback(() => {
    loadRun(id)
      .then((d) => setState({ status: 'ready', ...d }))
      .catch((error: unknown) => setState({ status: 'error', error }));
  }, [id]);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadRun(id)
      .then((d) => live && setState({ status: 'ready', ...d }))
      .catch((error: unknown) => live && setState({ status: 'error', error }));
    return () => {
      live = false;
    };
  }, [id]);

  if (state.status === 'loading') return <p className="muted">Loading run…</p>;
  if (state.status === 'error') return <ErrorMessage error={state.error} action="load the run" />;

  const { run, exp, changed } = state;
  // A run with a valid signature changes only through a reviewed correction (SPEC-008-R09, R10).
  // An aborted run, or a signed one with no signature rows (signed before SPEC-008), can't be corrected.
  const proposeOnly = run.signatures.some((s) => s.valid);
  const readOnly = !proposeOnly && (run.state === 'aborted' || run.state === 'signed');

  function changedState() {
    reload();
    refreshSidebar();
  }

  return (
    <article className="view">
      <div className="view-head">
        <div>
          <h1>{/^run [0-9a-f]{8}$/.test(title) ? 'Run' : title}</h1>
          <p className="subtitle">
            {exp ? (
              <button type="button" className="row-link" onClick={() => open({ kind: 'experiment', id: exp.id, title: exp.slug })}>
                {exp.slug}
              </button>
            ) : (
              'experiment'
            )}{' '}
            · protocol v{run.protocol_version}
            {run.started_at && <> · started {utc(run.started_at)}</>}
            {run.finished_at && <> · finished {utc(run.finished_at)}</>}
          </p>
        </div>
        <button type="button" className="btn" onClick={() => open({ kind: 'lineage', id: run.node_id, title: 'run' })}>
          <GitBranch size={16} aria-hidden="true" /> Open lineage
        </button>
      </div>

      <RunLifecycle
        run={run}
        me={me}
        onChanged={changedState}
        onStartProblems={(err) => {
          const problems = err instanceof ApiError ? err.problems : [];
          setStartError(err instanceof ApiError ? err : null);
          publishProblems(id, problems);
        }}
      />
      {startError && startError.problems.length > 0 && (
        <div className="error-message" role="alert">
          <span />
          <p>
            <strong>Couldn't start the run.</strong> The parameters don't match the protocol's schema.
          </p>
          <ul style={{ margin: 0 }}>
            {startError.problems.map((p, i) => (
              <li key={i}>
                {p.pointer !== '' && <code>{p.pointer}</code>} {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="run-grid">
        <section className="card" aria-labelledby="params-heading">
          <div className="card-head">
            <h2 id="params-heading">Parameters</h2>
          </div>
          <EditField
            label="Parameters"
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
                await proposeChangeSet(`Correct parameters of run ${id.slice(0, 8)}`, reason, [{ op: 'update_run_params', run_id: id, params }]);
                return 'proposed';
              }
              await editRunParams(id, params, reason);
              reload();
            }}
          />
        </section>
        <RunInputs run={run} canEdit={hasRole(me, 'scientist')} open={open} onChanged={reload} />
      </div>

      <RunData run={run} instruments={instruments} onChanged={reload} />

      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <SignaturesPanel run={run} onSigned={changedState} />
      </div>

      <section className="card" aria-labelledby="notes-heading">
        <h2 id="notes-heading" style={{ marginBottom: 'var(--space-3)' }}>
          Notes
        </h2>
        <Notes nodeId={run.node_id} proposeOnly={proposeOnly} readOnly={readOnly} />
      </section>

      <RecordDetails
        rows={[
          { label: 'Run ID', value: run.id },
          { label: 'Item ID (lineage)', value: run.node_id, term: 'lineage node id' },
          { label: 'Experiment ID', value: run.experiment_id },
          { label: 'Protocol version ID', value: run.protocol_version_id },
          { label: 'Protocol fingerprint (SHA-256)', value: run.protocol_sha256, term: 'protocol_sha256' },
          { label: 'Parameter schema version', value: run.params_schema_version_id },
          ...run.datasets.map((d) => ({ label: `Dataset "${d.label}" SHA-256`, value: d.sha256 })),
          { label: 'Created by', value: `${run.created_by} · ${utc(run.created_at)}` },
        ]}
      >
        <p className="muted" style={{ padding: '0 var(--space-3) var(--space-3)', margin: 0 }}>
          The {TERM.manifestDigest} that signers confirm is shown in the sign dialog. The full history is in the panel below (History).
        </p>
      </RecordDetails>
    </article>
  );
}

