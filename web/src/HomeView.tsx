import { ArrowRight, PenLine, Plus, Signature } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { listAllRuns, listExperiments, type ExperimentSummary, type RunListItem } from './api';
import EmptyState from './EmptyState';
import ErrorMessage from './ErrorMessage';
import { openNew } from './events';
import { ExperimentsArt, RunsArt, ToDoArt } from './illustrations';
import { hasRole, useMe } from './me';
import RoleNotice from './RoleNotice';
import StatusBadge from './StatusBadge';
import { todoTab, type Tab } from './tabs';
import type { ToDo } from './todo';

type Load<T> = { data: T | null; error: unknown };

function useLoad<T>(fetch: () => Promise<T>): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    fetch()
      .then((data) => live && setState({ data, error: null }))
      .catch((error: unknown) => live && setState({ data: null, error }));
    return () => {
      live = false;
    };
    // Load once per mount; Home remounts when reopened.
  }, []);
  return state;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

type Step = { title: string; text: string; action?: ReactNode };

// GetStarted (SPEC-025-R14) walks a new scientist from nothing to a signed run.
function GetStarted({ canCreate }: { canCreate: boolean }) {
  const needs = 'Available once you have an experiment.';
  const steps: Step[] = [
    {
      title: 'Create an experiment',
      text: 'An experiment holds one method and all the runs of it.',
      action: (
        <button type="button" className="btn btn-primary" onClick={() => openNew('experiment')} disabled={!canCreate}>
          <Plus size={16} aria-hidden="true" /> New experiment
        </button>
      ),
    },
    { title: 'Write the protocol', text: 'Describe the method in the experiment dialog. Each later edit saves a new version.' },
    {
      title: 'Plan a run',
      text: `A run is one execution of the protocol, with its own label and parameters. ${needs}`,
      action: (
        <button type="button" className="btn" disabled>
          Plan a run
        </button>
      ),
    },
    { title: 'Add inputs and start', text: 'Record the samples and reagents the run uses, then start it when you begin at the bench.' },
    { title: 'Send data', text: 'Instruments stream readings to a running run. The run view shows the command to use.' },
    { title: 'Complete and sign', text: 'Complete the run when the work is done. Reviewers then sign it, which locks the record.' },
  ];
  return (
    <section aria-labelledby="get-started">
      <h2 id="get-started" style={{ marginBottom: 'var(--space-3)' }}>
        Get started
      </h2>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.title} data-next={i === 0}>
            <div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
            {s.action ?? <span />}
          </li>
        ))}
      </ol>
    </section>
  );
}

// HomeView (SPEC-025-R13) answers "what should I do next?": what needs the
// user, what is running, and recent experiments. Each card loads on its own.
export default function HomeView({ open, todo, handle }: { open: (t: Tab) => void; todo: ToDo | null; handle: string }) {
  const me = useMe();
  const canCreate = hasRole(me, 'scientist');
  const experiments = useLoad(() => listExperiments());
  const runs = useLoad(() => listAllRuns(['running', 'paused'], undefined, 10));
  const name = me?.display_name?.split(' ')[0] || handle;

  const noExperiments = experiments.data !== null && experiments.data.items.length === 0;

  return (
    <article className="view">
      <div className="greeting">
        <div className="view-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>
              {greeting()}, {name}
            </h1>
            <p className="subtitle">Plan runs, record what they used, and sign off results.</p>
          </div>
          {canCreate && !noExperiments && (
            <button type="button" className="btn btn-primary" onClick={() => openNew('experiment')}>
              <Plus size={16} aria-hidden="true" /> New experiment
            </button>
          )}
        </div>
      </div>

      <RoleNotice what="create experiments, runs, samples or instruments" />
      <ErrorMessage error={experiments.error} action="load experiments" />
      {experiments.data === null && !experiments.error && <p className="muted">Loading…</p>}
      {noExperiments && <GetStarted canCreate={canCreate} />}

      {experiments.data !== null && !noExperiments && (
        <>
          <div className="cards">
            <Card title="Needs you" action={<button type="button" className="btn btn-link" onClick={() => open(todoTab('review'))}>Open To do</button>}>
              {todo === null && <p className="muted">Loading…</p>}
              {todo !== null && todo.signoffs.length + todo.reviews.length === 0 && (
                <EmptyState compact text="Nothing is waiting for you." />
              )}
              {todo !== null && todo.signoffs.length + todo.reviews.length > 0 && (
                <ul className="list">
                  {todo.signoffs.slice(0, 5).map((s) => (
                    <li key={`s:${s.run_id}`}>
                      <Signature size={16} aria-hidden="true" className="muted" />
                      <span className="grow">
                        <button type="button" className="row-link" onClick={() => open({ kind: 'run', id: s.run_id, title: s.label })}>
                          Sign {s.label}
                        </button>{' '}
                        <span className="muted">({s.meaning})</span>
                      </span>
                      <span className="badge tone-accent">To sign</span>
                    </li>
                  ))}
                  {todo.reviews.slice(0, 5).map((c) => (
                    <li key={`c:${c.id}`}>
                      <PenLine size={16} aria-hidden="true" className="muted" />
                      <span className="grow">
                        <button type="button" className="row-link" onClick={() => open(todoTab('review'))}>
                          Review "{c.title}"
                        </button>{' '}
                        <span className="muted">by {c.author}</span>
                      </span>
                      <span className="badge tone-accent">To check</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Runs in progress">
              <ErrorMessage error={runs.error} action="load runs in progress" />
              {runs.data === null && !runs.error && <p className="muted">Loading…</p>}
              {runs.data !== null && runs.data.items.length === 0 && (
                <EmptyState compact icon={<RunsArt />} text="No runs are running or paused." />
              )}
              {runs.data !== null && runs.data.items.length > 0 && (
                <ul className="list">
                  {runs.data.items.map((r: RunListItem) => (
                    <li key={r.id}>
                      <StatusBadge state={r.state} />
                      <span className="grow">
                        <button type="button" className="row-link" onClick={() => open({ kind: 'run', id: r.id, title: r.label })}>
                          {r.label}
                        </button>
                      </span>
                      <span className="muted mono">{r.experiment_slug}</span>
                      <ArrowRight size={14} aria-hidden="true" className="muted" />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card
            title="Recent experiments"
            action={
              canCreate && (
                <button type="button" className="btn" onClick={() => openNew('run')}>
                  <Plus size={16} aria-hidden="true" /> Plan a run
                </button>
              )
            }
          >
            {experiments.data.items.length === 0 ? (
              <EmptyState icon={<ExperimentsArt />} text="No experiments yet." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Experiment</th>
                      <th scope="col">Title</th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {experiments.data.items.slice(0, 10).map((x: ExperimentSummary) => (
                      <tr key={x.id}>
                        <td>
                          <button type="button" className="row-link mono" onClick={() => open({ kind: 'experiment', id: x.id, title: x.slug })}>
                            {x.slug}
                          </button>
                        </td>
                        <td>{x.title}</td>
                        <td className="mono">{x.created_at.slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      {experiments.data !== null && noExperiments && todo !== null && todo.signoffs.length + todo.reviews.length > 0 && (
        <EmptyState icon={<ToDoArt />} text="Some items are waiting for you in To do." action={<button type="button" className="btn" onClick={() => open(todoTab('review'))}>Open To do</button>} />
      )}
    </article>
  );
}
