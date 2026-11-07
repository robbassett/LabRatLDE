import { useEffect, useId, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { createRun, getProtocolVersion, getSchemaVersion, type Experiment, type Run } from './api';
import ErrorMessage from './ErrorMessage';
import { refreshSidebar } from './events';
import Field from './Field';
import RecordForm from './RecordForm';
import type { Tab } from './tabs';
import { toast } from './Toasts';
import { useSchemaValidation } from './useSchemaValidation';

// NewRunForm plans a run of the experiment's current protocol version and opens it (SPEC-009-R09).
// Parameters are checked when the run starts, so problems warn here and never block the create.
export default function NewRunForm({ exp, open, onCreated }: { exp: Experiment; open: (t: Tab) => void; onCreated?: (run: Run) => void }) {
  const [paramsSchemaId, setParamsSchemaId] = useState<string | null>(null);
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [label, setLabel] = useState('');
  const [inputs, setInputs] = useState('');
  const [value, setValue] = useState<unknown>({});
  const [text, setText] = useState('{}');
  const [error, setError] = useState<unknown>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const source = `newrun:${useId()}`;

  useEffect(() => {
    let live = true;
    setParamsSchemaId(null);
    setSchema(null);
    getProtocolVersion(exp.protocol_version_id)
      .then(async (pv) => {
        const id = pv.params_schema_version_id;
        if (!live || !id) return;
        const v = await getSchemaVersion(id);
        if (!live) return;
        if (v.bundled) {
          setParamsSchemaId(id);
          setSchema(v.bundled as RJSFSchema);
        } else setJsonError("The protocol's parameter schema has no form, so enter parameters as JSON.");
      })
      .catch((err: unknown) => live && setError(err));
    return () => {
      live = false;
    };
  }, [exp.protocol_version_id]);

  const problems = useSchemaValidation(source, schema && paramsSchemaId ? { schemaVersionId: paramsSchemaId } : null, value);

  async function create() {
    let params: Record<string, unknown>;
    setJsonError(null);
    if (schema) {
      params = value as Record<string, unknown>;
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setJsonError('Parameters must be a JSON object, like {"column": "C18"}.');
          return;
        }
        params = parsed as Record<string, unknown>;
      } catch {
        setJsonError('Parameters must be valid JSON, like {"column": "C18"}.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const run = await createRun({
        experiment_id: exp.id,
        label: label.trim() || undefined,
        inputs: inputs
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== ''),
        params,
      });
      const title = label.trim() || 'run';
      toast(`Run "${title}" planned`);
      refreshSidebar();
      onCreated?.(run);
      open({ kind: 'run', id: run.id, title });
    } catch (err: unknown) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    // Not a <form>: RecordForm renders its own, and forms do not nest.
    <div role="group" aria-label={`Plan a run of ${exp.slug}`}>
      <p className="muted">
        Uses protocol v{exp.protocol_version} of {exp.title}. You can add inputs now or from the run once it's planned.
      </p>
      <Field label="Label" hint="How people will find this run, e.g. Batch 7 HPLC.">
        <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} />
      </Field>
      <Field label="Inputs (optional)" hint="IDs of samples or materials this run uses, one per line.">
        <textarea className="mono" rows={2} value={inputs} onChange={(e) => setInputs(e.target.value)} disabled={saving} />
      </Field>
      {!schema && (
        <Field label="Parameters (JSON)" hint="Settings for this run, e.g. column or flow rate." error={jsonError}>
          <textarea className="mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} disabled={saving} />
        </Field>
      )}
      {schema && <RecordForm schema={schema} value={value} onChange={setValue} problems={problems} warnOnly />}
      <ErrorMessage error={error} action="plan the run" />
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={create} disabled={saving}>
          {saving ? 'Planning…' : 'Plan run'}
        </button>
      </div>
    </div>
  );
}
