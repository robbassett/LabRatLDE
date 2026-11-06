import { useEffect, useState, type FormEvent } from 'react';
import { createSchema, listSchemas, type AppliesTo, type SchemaSummary } from './api';
import type { Tab } from './tabs';

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
  const [error, setError] = useState<string | null>(null);
  const [namespace, setNamespace] = useState('');
  const [name, setName] = useState('');
  const [appliesTo, setAppliesTo] = useState<AppliesTo>('sample');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load(cursor?: string) {
    setLoading(true);
    setError(null);
    listSchemas(undefined, cursor)
      .then((p) => {
        setItems((prev) => (cursor ? [...prev, ...p.items] : p.items));
        setNext(p.next_cursor);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
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
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  const namespaces: string[] = [];
  for (const s of items) if (!namespaces.includes(s.namespace)) namespaces.push(s.namespace);

  return (
    <article className="view">
      <h1>Schemas</h1>

      <h2>New schema</h2>
      <form className="edit-form" onSubmit={create}>
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
        {createError && (
          <p role="alert" className="error">
            {createError}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={creating}>
            Create schema
          </button>
        </div>
      </form>

      {namespaces.map((ns) => (
        <section key={ns} aria-label={ns}>
          <h2>{ns}</h2>
          <table className="data">
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
                      <button type="button" onClick={() => open(schemaTab(s.namespace, s.name))}>
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
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loading && !error && items.length === 0 && <p className="muted">No schemas yet.</p>}
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
