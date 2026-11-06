import { useEffect, useId, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { ApiError, createNode, getSchemaVersion, listSchemas, type NodeKind, type SchemaProblem, type SchemaSummary } from './api';
import RecordForm from './RecordForm';
import type { Tab } from './tabs';
import { useSchemaValidation } from './useSchemaValidation';

const NODE_KINDS: NodeKind[] = ['sample', 'reagent', 'protocol', 'run', 'instrument', 'dataset', 'analysis'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// NewNodeView creates a lineage node, from a schema's form when one is chosen, otherwise from a JSON box
// (SPEC-009-R09). It then opens the node's lineage.
export default function NewNodeView({ open }: { open: (t: Tab) => void }) {
  const [kind, setKind] = useState<NodeKind>('sample');
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [schemaVersionId, setSchemaVersionId] = useState(''); // '' is "No schema"
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState<unknown>({});
  const [text, setText] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [createProblems, setCreateProblems] = useState<SchemaProblem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const source = `newnode:${useId()}`;

  // The schemas on offer are the kind's published ones.
  useEffect(() => {
    let live = true;
    setSchemas([]);
    setSchemaVersionId('');
    listSchemas(kind)
      .then((p) => live && setSchemas(p.items.filter((s) => s.latest_published)))
      .catch((err: unknown) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [kind]);

  useEffect(() => {
    setSchema(null);
    setValue({});
    setCreateProblems(null);
    if (!schemaVersionId) return;
    let live = true;
    getSchemaVersion(schemaVersionId)
      .then((v) => {
        if (!live) return;
        if (v.bundled) setSchema(v.bundled as RJSFSchema);
        else setError('Could not load the schema: no bundled form.');
      })
      .catch((err: unknown) => live && setError(`Could not load the schema: ${errorMessage(err)}`));
    return () => {
      live = false;
    };
  }, [schemaVersionId]);

  const hookProblems = useSchemaValidation(source, schema && schemaVersionId ? { schemaVersionId } : null, value);
  const problems = createProblems ?? hookProblems;

  async function create() {
    let attrs: Record<string, unknown>;
    if (schemaVersionId) {
      attrs = value as Record<string, unknown>;
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('Attributes must be a JSON object.');
          return;
        }
        attrs = parsed as Record<string, unknown>;
      } catch {
        setError('Attributes must be valid JSON.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const node = await createNode({ kind, label: label.trim(), attrs, schema_version_id: schemaVersionId || undefined });
      open({ kind: 'lineage', id: node.id, title: node.label });
    } catch (err: unknown) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.problems.length > 0) setCreateProblems(err.problems);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="view">
      <h1>New record</h1>
      {/* Not a <form>: RecordForm renders its own, and forms do not nest. */}
      <div className="edit-form" role="group" aria-label="New record">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as NodeKind)} disabled={saving}>
            {NODE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Schema
          <select value={schemaVersionId} onChange={(e) => setSchemaVersionId(e.target.value)} disabled={saving}>
            <option value="">No schema</option>
            {schemas.map((s) => (
              <option key={s.id} value={s.latest_published!.id}>
                {s.namespace}/{s.name}@{s.latest_published!.major}.{s.latest_published!.minor}
              </option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} required />
        </label>
        {!schemaVersionId && (
          <label>
            Attributes (JSON)
            <textarea className="mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} disabled={saving} />
          </label>
        )}
        {schemaVersionId && schema && (
          <RecordForm
            schema={schema}
            value={value}
            onChange={(v) => {
              setCreateProblems(null);
              setValue(v);
            }}
            problems={problems}
          />
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={create} disabled={saving || label.trim() === '' || problems.length > 0 || (schemaVersionId !== '' && !schema)}>
            Create
          </button>
        </div>
      </div>
    </article>
  );
}
