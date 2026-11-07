import { useEffect, useState, type FormEvent } from 'react';
import { createSchema, listSchemas, type AppliesTo, type SchemaSummary } from './api';
import type { Tab } from './tabs';
import EmptyState from './EmptyState';
import ErrorMessage from './ErrorMessage';
import { SearchArt } from './illustrations';

const APPLIES_TO: AppliesTo[] = ['sample', 'reagent', 'protocol', 'run', 'instrument', 'dataset', 'analysis', 'run_params'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function schemaTab(namespace: string, name: string): Tab {
  return { kind: 'schema', id: `${namespace}/${name}`, title: `${namespace}/${name}` };
}

// SchemasView lists the registry's schemas by namespace and creates new ones (SPEC-009-R10).
export default function SchemasView({ open }: { open: (t: Tab) => void }) {
  const [items, setItems] = useState<SchemaSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [namespace, setNamespace] = useState('');
  const [name, setName] = useState('');
  const [appliesTo, setAppliesTo] = useState<AppliesTo>('sample');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  function load(cursor?: string) {
    setLoading(true);
    setError(null);
    listSchemas(undefined, cursor)
      .then((p) => {
        setItems((prev) => (cursor ? [...prev, ...p.items] : p.items));
        setNext(p.next_cursor);
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  }

  useEffect(() => load(), []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const s = await createSchema({ namespace: namespace.trim(), name: name.trim(), applies_to: appliesTo });
      open(schemaTab(s.namespace, s.name));
    } catch (err: unknown) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  const namespaces: string[] = [];
  for (const s of items) if (!namespaces.includes(s.namespace)) namespaces.push(s.namespace);

  return (
    <article className="view">
      <div className="view-head">
        <div>
          <h1>Schemas</h1>
          <p className="subtitle">Schemas give records a form and check their details. Published versions are used by new records and runs.</p>
        </div>
      </div>

      <details className="card" style={{ marginBottom: 'var(--space-4)' }} open={!loading && items.length === 0}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>New schema</summary>
      <form className="edit-form" onSubmit={create} style={{ marginTop: 'var(--space-3)' }}>
        <label>
          Namespace
          <input value={namespace} onChange={(e) => setNamespace(e.target.value)} disabled={creating} required />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={creating} required />
        </label>
        <label>
          Applies to
          <select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as AppliesTo)} disabled={creating}>
            {APPLIES_TO.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <ErrorMessage error={createError} action="create the schema" />
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={creating}>
            Create schema
          </button>
        </div>
      </form>
      </details>

      {namespaces.map((ns) => (
        <section key={ns} aria-label={ns}>
          <h2>{ns}</h2>
          <table className="table">
            <caption className="sr-only">Schemas in {ns}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Applies to</th>
                <th scope="col">Latest published</th>
              </tr>
            </thead>
            <tbody>
              {items
                .filter((s) => s.namespace === ns)
                .map((s) => (
                  <tr key={s.id}>
                    <td>
                      <button type="button" className="row-link" onClick={() => open(schemaTab(s.namespace, s.name))}>
                        {s.name}
                      </button>
                    </td>
                    <td>{s.applies_to}</td>
                    <td>{s.latest_published ? `${s.latest_published.major}.${s.latest_published.minor}` : 'none'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
      {loading && <p className="muted">Loading…</p>}
      <ErrorMessage error={error} action="load schemas" />
      {!loading && !error && items.length === 0 && (
        <EmptyState icon={<SearchArt />} text="No schemas yet. Without one, records take free-form JSON details. Create a schema above to give them a form." />
      )}
      {next && !loading && (
        <div className="actions">
          <button type="button" onClick={() => load(next)}>
            Load more
          </button>
        </div>
      )}
    </article>
  );
}
