import { useEffect, useId, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { ApiError, createNode, getSchemaVersion, listSchemas, type LineageNode, type NodeKind, type SchemaProblem, type SchemaSummary } from './api';
import ErrorMessage from './ErrorMessage';
import Field from './Field';
import { KIND_LABEL } from './glossary';
import RecordForm from './RecordForm';
import type { Tab } from './tabs';
import { toast } from './Toasts';
import { useSchemaValidation } from './useSchemaValidation';

const NODE_KINDS: NodeKind[] = ['sample', 'reagent', 'protocol', 'run', 'instrument', 'dataset', 'analysis'];

// Kinds a scientist records by hand; runs, instruments and datasets have their own flows.
export const MATERIAL_KINDS: NodeKind[] = ['sample', 'reagent', 'analysis'];

// NewNodeForm creates a lineage item, from a schema's form when one is chosen, otherwise from a
// JSON box (SPEC-009-R09). The run view's Add input reuses it (SPEC-025-R25).
export function NewNodeForm({
  kinds = NODE_KINDS,
  submitLabel = 'Create',
  onCreated,
}: {
  kinds?: NodeKind[];
  submitLabel?: string;
  onCreated: (node: LineageNode) => void | Promise<void>;
}) {
  const [kind, setKind] = useState<NodeKind>(kinds[0]);
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [schemaVersionId, setSchemaVersionId] = useState(''); // '' is "No schema"
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState<unknown>({});
  const [text, setText] = useState('{}');
  const [error, setError] = useState<unknown>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [createProblems, setCreateProblems] = useState<SchemaProblem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const source = `newnode:${useId()}`;

  // The schemas on offer are the kind's published ones.
  useEffect(() => {
    let live = true;
    setSchemas([]);
    setSchemaVersionId('');
    listSchemas(kind)
      .then((p) => {
        if (!live) return;
        const published = p.items.filter((s) => s.latest_published);
        setSchemas(published);
        // One published schema for the kind: use it, as most labs will have.
        if (published.length === 1) setSchemaVersionId(published[0].latest_published!.id);
      })
      .catch((err: unknown) => live && setError(err));
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
        else setJsonError('This schema has no form to show. Pick another, or no schema.');
      })
      .catch((err: unknown) => live && setError(err));
    return () => {
      live = false;
    };
  }, [schemaVersionId]);

  const hookProblems = useSchemaValidation(source, schema && schemaVersionId ? { schemaVersionId } : null, value);
  const problems = createProblems ?? hookProblems;

  async function create() {
    let attrs: Record<string, unknown>;
    setJsonError(null);
    if (schemaVersionId) {
      attrs = value as Record<string, unknown>;
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setJsonError('Details must be a JSON object, like {"lot": "R-2291"}.');
          return;
        }
        attrs = parsed as Record<string, unknown>;
      } catch {
        setJsonError('Details must be valid JSON, like {"lot": "R-2291"}.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const node = await createNode({ kind, label: label.trim(), attrs, schema_version_id: schemaVersionId || undefined });
      await onCreated(node);
    } catch (err: unknown) {
      setError(err);
      if (err instanceof ApiError && err.problems.length > 0) setCreateProblems(err.problems);
    } finally {
      setSaving(false);
    }
  }

  return (
    // Not a <form>: RecordForm renders its own, and forms do not nest.
    <div role="group" aria-label="New item">
      <Field label="Kind">
        <select value={kind} onChange={(e) => setKind(e.target.value as NodeKind)} disabled={saving}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Schema" hint="A schema gives the details a form and checks them. Ask your schema steward to publish one for this kind.">
        <select value={schemaVersionId} onChange={(e) => setSchemaVersionId(e.target.value)} disabled={saving}>
          <option value="">No schema</option>
          {schemas.map((s) => (
            <option key={s.id} value={s.latest_published!.id}>
              {s.namespace}/{s.name} v{s.latest_published!.major}.{s.latest_published!.minor}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name" hint="What people call it at the bench, e.g. a lot or tube label.">
        <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} required />
      </Field>
      {!schemaVersionId && (
        <Field label="Details (JSON)" hint='Optional. For example {"lot": "R-2291", "supplier": "Acme"}.' error={jsonError}>
          <textarea className="mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={saving} />
        </Field>
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
      {schemaVersionId && jsonError && <p className="field-error">{jsonError}</p>}
      <ErrorMessage error={error} action={`create the ${KIND_LABEL[kind].toLowerCase()}`} />
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={create}
          disabled={saving || label.trim() === '' || problems.length > 0 || (schemaVersionId !== '' && !schema)}
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

// NewNodeView is the "New sample or material" tab: create an item, then open its lineage.
export default function NewNodeView({ open }: { open: (t: Tab) => void }) {
  return (
    <article className="view">
      <div className="view-head">
        <div>
          <h1>New sample or material</h1>
          <p className="subtitle">Record a sample, reagent or other material so runs can use it and its lineage is traced.</p>
        </div>
      </div>
      <div className="card" style={{ maxWidth: '40rem' }}>
        <NewNodeForm
          kinds={[...MATERIAL_KINDS, 'protocol', 'dataset']}
          onCreated={(node) => {
            toast(`${KIND_LABEL[node.kind]} "${node.label}" created`);
            open({ kind: 'lineage', id: node.id, title: node.label });
          }}
        />
      </div>
    </article>
  );
}
