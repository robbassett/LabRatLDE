import { useEffect, useId, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { createSchemaVersion, getMe, getSchema, getSchemaVersion, type SchemaDetail, type SchemaVersion } from './api';
import RecordForm from './RecordForm';
import SchemaDraftEditor from './SchemaDraftEditor';
import { tabKey, type Tab } from './tabs';
import { useSchemaValidation } from './useSchemaValidation';

const BLANK_BODY = '{"type":"object","properties":{}}';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Doc = { field: string; type: string; required: boolean; unit: string; description: string };

// fieldDocs reads the top-level properties of a schema's text. A text that does not parse has none.
function fieldDocs(bodyText: string): Doc[] {
  let body: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  try {
    body = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const required = Array.isArray(body?.required) ? body.required : [];
  return Object.entries(body?.properties ?? {}).map(([field, p]) => ({
    field,
    type: Array.isArray(p?.type) ? p.type.join(' | ') : typeof p?.type === 'string' ? p.type : p?.enum ? 'enum' : '',
    required: required.includes(field),
    unit: typeof p?.['x-lde-unit'] === 'string' ? p['x-lde-unit'] : '',
    description: typeof p?.description === 'string' ? p.description : '',
  }));
}

// SamplePanel shows a published version's fields and a sample form that saves nothing (SPEC-009-R10).
function SamplePanel({ version }: { version: SchemaVersion }) {
  const [value, setValue] = useState<unknown>({});
  const source = `schema:${useId()}`;
  const problems = useSchemaValidation(source, { schemaVersionId: version.id }, value);
  const docs = fieldDocs(version.body_text);
  return (
    <>
      <FieldDocs docs={docs} />
      <h3>Sample form</h3>
      <p className="muted">Nothing here is saved.</p>
      {version.bundled && <RecordForm schema={version.bundled as RJSFSchema} value={value} onChange={setValue} problems={problems} />}
    </>
  );
}

export function FieldDocs({ docs }: { docs: Doc[] }) {
  return (
    <>
      <h3>Fields</h3>
      {docs.length === 0 ? (
        <p className="muted">No top-level fields.</p>
      ) : (
        <table className="data">
          <caption className="sr-only">Fields of this version</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Type</th>
              <th scope="col">Required</th>
              <th scope="col">Unit</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.field}>
                <td className="mono">{d.field}</td>
                <td>{d.type}</td>
                <td>{d.required ? 'yes' : 'no'}</td>
                <td>{d.unit}</td>
                <td>{d.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// SchemaView shows one schema's versions, the selected version's fields with a sample form, and (for a draft
// the user wrote) the draft editor (SPEC-009-R08, R09, R10). The tab id is "ns/name".
export default function SchemaView({ id, rename }: { id: string; open: (t: Tab) => void; rename: (key: string, title: string) => void }) {
  const slash = id.lastIndexOf('/');
  const ns = id.slice(0, slash);
  const name = id.slice(slash + 1);
  const [detail, setDetail] = useState<SchemaDetail | null>(null);
  const [meId, setMeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState<SchemaVersion | null>(null);
  const [major, setMajor] = useState('1');
  const [minor, setMinor] = useState('0');
  const [draftText, setDraftText] = useState(BLANK_BODY);
  const [creating, setCreating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((m) => setMeId(m.id))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  // The new draft starts as the next minor of the highest version, with that version's text.
  useEffect(() => {
    let live = true;
    setError(null);
    getSchema(ns, name)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        rename(tabKey({ kind: 'schema', id }), `${ns}/${name}`);
        const latest = d.versions[0];
        setMajor(String(latest ? latest.major : 1));
        setMinor(String(latest ? latest.minor + 1 : 0));
        if (!latest) {
          setDraftText(BLANK_BODY);
          return;
        }
        getSchemaVersion(latest.id)
          .then((v) => live && setDraftText(v.body_text))
          .catch((err: unknown) => live && setError(errorMessage(err)));
      })
      .catch((err: unknown) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [ns, name, reload]);

  useEffect(() => {
    setVersion(null);
    if (!selected) return;
    let live = true;
    getSchemaVersion(selected)
      .then((v) => live && setVersion(v))
      .catch((err: unknown) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [selected, reload]);

  async function newDraft() {
    setCreating(true);
    setDraftError(null);
    try {
      const v = await createSchemaVersion(ns, name, { major: Number(major), minor: Number(minor), body_text: draftText });
      setReload((n) => n + 1);
      setSelected(v.id);
    } catch (err: unknown) {
      setDraftError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <article className="view">
      <h1>
        {ns}/{name}
      </h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!detail && !error && <p className="muted">Loading…</p>}
      {detail && (
        <>
          <p className="muted">Applies to {detail.applies_to}</p>
          <h2>Versions</h2>
          {detail.versions.length === 0 ? (
            <p className="muted">No versions yet.</p>
          ) : (
            <table className="data">
              <caption className="sr-only">Versions of {id}</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Author</th>
                  <th scope="col">Hash</th>
                  <th scope="col">Published</th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <button type="button" aria-pressed={v.id === selected} onClick={() => setSelected(v.id)}>
                        {v.major}.{v.minor}
                      </button>
                    </td>
                    <td>{v.status}</td>
                    <td>{v.author}</td>
                    <td className="mono hash">{v.sha256.slice(0, 12)}</td>
                    <td>{v.published_at ? new Date(v.published_at).toLocaleString() : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {version && (
            <section aria-label={`Version ${version.major}.${version.minor}`}>
              <h2>
                Version {version.major}.{version.minor} ({version.status})
              </h2>
              {version.status === 'published' ? (
                <SamplePanel key={version.id} version={version} />
              ) : (
                <>
                  <FieldDocs docs={fieldDocs(version.body_text)} />
                  <SchemaDraftEditor key={`${version.id}:${reload}`} version={version} mine={meId !== '' && version.author_id === meId} onPublished={() => setReload((n) => n + 1)} />
                </>
              )}
            </section>
          )}

          <h2>New draft</h2>
          <div className="edit-form" role="group" aria-label="New draft">
            <label>
              Major
              <input type="number" min={0} value={major} onChange={(e) => setMajor(e.target.value)} disabled={creating} />
            </label>
            <label>
              Minor
              <input type="number" min={0} value={minor} onChange={(e) => setMinor(e.target.value)} disabled={creating} />
            </label>
            <label>
              Schema text (JSON)
              <textarea className="mono" rows={8} value={draftText} onChange={(e) => setDraftText(e.target.value)} disabled={creating} />
            </label>
            {draftError && (
              <p role="alert" className="error">
                {draftError}
              </p>
            )}
            <div className="actions">
              <button type="button" onClick={newDraft} disabled={creating}>
                Create draft
              </button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}
