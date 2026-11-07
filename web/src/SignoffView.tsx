import { useEffect, useState } from 'react';
import { listSignoff, type SignoffItem } from './api';
import EmptyState from './EmptyState';
import ErrorMessage from './ErrorMessage';
import { ToDoArt } from './illustrations';
import { utc } from './SignaturesPanel';
import StatusBadge from './StatusBadge';
import type { Tab } from './tabs';

// SignoffView lists the finished runs whose next signing step the user can take, oldest first
// (SPEC-008-R05). It is the Sign-offs section of the To-do view (SPEC-025-R12). Each row opens
// the run, where the Sign button is.
export default function SignoffView({ open }: { open: (t: Tab) => void }) {
  const [items, setItems] = useState<SignoffItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // load fetches one page: no cursor replaces the list, a cursor appends to it.
  function load(cursor?: string) {
    setLoading(true);
    setError(null);
    listSignoff(cursor)
      .then((p) => {
        setItems((xs) => (cursor && xs ? [...xs, ...p.items] : p.items));
        setNext(p.next_cursor);
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  }

  useEffect(() => load(), []);

  return (
    <section aria-label="Sign-offs">
      <p className="muted">Finished runs waiting for your signature, oldest first.</p>
      <ErrorMessage error={error} action="load your sign-offs" />
      {items === null && !error && <p className="muted">Loading runs…</p>}
      {items !== null && items.length === 0 && (
        <EmptyState icon={<ToDoArt />} text="Nothing is waiting for your signature. Runs appear here when they finish and your signing step is next." />
      )}
      {items !== null && items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Runs awaiting your signature</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Experiment</th>
                <th scope="col">State</th>
                <th scope="col">Your step</th>
                <th scope="col">Finished</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.run_id}>
                  <th scope="row">
                    <button type="button" className="row-link" onClick={() => open({ kind: 'run', id: i.run_id, title: i.label })}>
                      {i.label}
                    </button>
                  </th>
                  <td>{i.experiment_title}</td>
                  <td>
                    <StatusBadge state={i.state} />
                  </td>
                  <td>
                    Step {i.step}: {i.meaning}
                  </td>
                  <td className="mono">
                    <time dateTime={i.finished_at}>{utc(i.finished_at)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <p>
          <button type="button" className="btn" disabled={loading} onClick={() => load(next)}>
            Load more
          </button>
        </p>
      )}
    </section>
  );
}
