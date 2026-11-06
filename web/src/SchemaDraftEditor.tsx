import { useId, useRef, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { ApiError, getSchemaVersion, publishSchemaVersion, updateSchemaVersion, type SchemaProblem, type SchemaVersion } from './api';
import RecordForm from './RecordForm';
import { useSchemaValidation } from './useSchemaValidation';

function parseObject(text: string): RJSFSchema | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RJSFSchema) : null;
  } catch {
    return null;
  }
}

function Failure({ message, problems }: { message: string; problems: SchemaProblem[] }) {
  return (
    <div role="alert" className="error">
      <p>{message}</p>
      {problems.length > 0 && (
        <ul>
          {problems.map((p, i) => (
            <li key={i}>
              {p.pointer !== '' && <code>{p.pointer}</code>} {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// SchemaDraftEditor edits a draft's JSON beside a live form preview. Only the draft's author can change it
// (SPEC-009-R08, R09, R10). The preview is the last saved bundled document until the text parses, then the text.
export default function SchemaDraftEditor({ version, mine, onPublished }: { version: SchemaVersion; mine: boolean; onPublished: () => void }) {
  const [saved, setSaved] = useState(version);
  const [text, setText] = useState(version.body_text);
  const [value, setValue] = useState<unknown>({});
  const [failure, setFailure] = useState<{ message: string; problems: SchemaProblem[] } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const publishButton = useRef<HTMLButtonElement>(null);
  const source = `draft:${useId()}`;
  const problems = useSchemaValidation(source, { bodyText: text }, value);

  const parsed = parseObject(text);
  const preview = parsed ?? (saved.bundled as RJSFSchema | undefined) ?? null;

  function fail(err: unknown) {
    setFailure({
      message: err instanceof Error ? err.message : String(err),
      problems: err instanceof ApiError ? err.problems : [],
    });
  }

  async function save() {
    setBusy(true);
    setFailure(null);
    setNotice('');
    try {
      await updateSchemaVersion(version.id, text);
      setSaved(await getSchemaVersion(version.id));
      setNotice('Saved');
    } catch (err: unknown) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setFailure(null);
    try {
      await publishSchemaVersion(version.id);
      dialog.current?.close();
      onPublished();
    } catch (err: unknown) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const unsaved = text !== saved.body_text;

  return (
    <div className="draft-editor">
      <div>
        <h3>{mine ? 'Draft text' : `Draft by ${version.author} (read-only)`}</h3>
        <textarea className="mono draft-text" aria-label="Schema text (JSON)" rows={20} value={text} readOnly={!mine} onChange={(e) => setText(e.target.value)} />
        {mine && (
          <div className="actions">
            <button type="button" onClick={save} disabled={busy || !unsaved}>
              Save
            </button>
            <button type="button" ref={publishButton} onClick={() => dialog.current?.showModal()} disabled={busy || unsaved}>
              Publish
            </button>
            {unsaved && <span className="muted">Save before publishing.</span>}
            {notice && !unsaved && <span role="status">{notice}</span>}
          </div>
        )}
        {mine && failure && !dialog.current?.open && <Failure message={failure.message} problems={failure.problems} />}
      </div>
      <div>
        <h3>Preview</h3>
        {preview ? <RecordForm schema={preview} value={value} onChange={setValue} problems={problems} /> : <p className="muted">No preview yet.</p>}
      </div>

      <dialog
        ref={dialog}
        className="sign-dialog"
        aria-labelledby={`${source}-title`}
        onClose={() => {
          setFailure(null);
          publishButton.current?.focus();
        }}
      >
        <h2 id={`${source}-title`}>
          Publish {version.major}.{version.minor}?
        </h2>
        <p>Published versions can never change.</p>
        {failure && <Failure message={failure.message} problems={failure.problems} />}
        <div className="actions">
          <button type="button" onClick={publish} disabled={busy}>
            Publish
          </button>
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </div>
  );
}
