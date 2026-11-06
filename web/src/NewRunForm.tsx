import { useEffect, useId, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { createRun, getProtocolVersion, getSchemaVersion, type Experiment } from './api';
import RecordForm from './RecordForm';
import type { Tab } from './tabs';
import { useSchemaValidation } from './useSchemaValidation';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// NewRunForm creates a run of the experiment's current protocol version and opens it (SPEC-009-R09).
// Params are checked when the run starts, so problems warn here and never block the create.
export default function NewRunForm({ exp, open }: { exp: Experiment; open: (t: Tab) => void }) {
  const [paramsSchemaId, setParamsSchemaId] = useState<string | null>(null);
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [label, setLabel] = useState('');
  const [inputs, setInputs] = useState('');
  const [value, setValue] = useState<unknown>({});
  const [text, setText] = useState('{}');
  const [error, setError] = useState<string | null>(null);
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
        } else setError('Could not load the params schema: no bundled form.');
      })
      .catch((err: unknown) => live && setError(`Could not load the params schema: ${errorMessage(err)}`));
    return () => {
      live = false;
    };
  }, [exp.protocol_version_id]);

  const problems = useSchemaValidation(source, schema && paramsSchemaId ? { schemaVersionId: paramsSchemaId } : null, value);

  async function create() {
    let params: Record<string, unknown>;
    if (schema) {
      params = value as Record<string, unknown>;
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('Params must be a JSON object.');
          return;
        }
        params = parsed as Record<string, unknown>;
      } catch {
        setError('Params must be valid JSON.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const run = await createRun({
        experiment_id: exp.id,
        label: label.trim() || undefined,
        inputs: inputs.split('\n').map((l) => l.trim()).filter((l) => l !== ''),
        params,
      });
      open({ kind: 'run', id: run.id, title: label.trim() || 'run' });
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="new-run-heading">
      <h2 id="new-run-heading">New run</h2>
      {/* Not a <form>: RecordForm renders its own, and forms do not nest. */}
      <div className="edit-form" role="group" aria-label="New run">
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} />
        </label>
        <label>
          Inputs (one node id per line)
          <textarea className="mono" rows={3} value={inputs} onChange={(e) => setInputs(e.target.value)} disabled={saving} />
        </label>
        {!schema && (
          <label>
            Params (JSON)
            <textarea className="mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} disabled={saving} />
          </label>
        )}
        {schema && <RecordForm schema={schema} value={value} onChange={setValue} problems={problems} warnOnly />}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={create} disabled={saving}>
            Create run
          </button>
        </div>
      </div>
    </section>
  );
}
