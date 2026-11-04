import { useEffect, useState } from 'react';
import { listSignoff, type SignoffItem } from './api';
import { utc } from './SignaturesPanel';
import type { Tab } from './tabs';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// SignoffView lists the finished runs whose next signing step the user can take, oldest first
// (SPEC-008-R05). It is a singleton tab. Each row opens the run, where the Sign button is.
export default function SignoffView({ open }: { open: (t: Tab) => void }) {
  const [items, setItems] = useState<SignoffItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // load fetches one page: no cursor replaces the list, a cursor appends to it.
  function load(cursor?: string) {
    setLoading(true);
    setError(null);
    listSignoff(cursor)
      .then((p) => {
        setItems((xs) => (cursor && xs ? [...xs, ...p.items] : p.items));
        setNext(p.next_cursor);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => load(), []);

  return (
    <article className="view">
      <h1>Sign-off inbox</h1>
      <p className="muted">Finished runs waiting for your signature, oldest first.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {items === null && !error && <p className="muted">Loading runs…</p>}
      {items !== null && items.length === 0 && <p className="muted">Nothing is waiting for your signature.</p>}
      {items !== null && items.length > 0 && (
        <table className="data">
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
                  <button type="button" onClick={() => open({ kind: 'run', id: i.run_id, title: i.label })}>
                    {i.label}
                  </button>
                </th>
                <td>{i.experiment_title}</td>
                <td>{i.state}</td>
                <td>
                  Step {i.step}: {i.meaning}
                </td>
                <td>
                  <time dateTime={i.finished_at}>{utc(i.finished_at)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <p>
          <button type="button" disabled={loading} onClick={() => load(next)}>
            Load more
          </button>
        </p>
      )}
    </article>
  );
}
