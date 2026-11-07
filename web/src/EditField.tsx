import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { ApiError, getSchemaVersion, type SchemaProblem } from './api';
import RecordForm from './RecordForm';
import { useSchemaValidation } from './useSchemaValidation';
import ErrorMessage from './ErrorMessage';

type Props = {
  label: string;
  value: string;
  multiline?: boolean;
  json?: boolean;
  changed: boolean;
  // proposeOnly: the record is signed, so onSave must propose a change set (SPEC-008-R09, R10).
  proposeOnly?: boolean;
  // readOnly: the record is frozen and can't be corrected (aborted, or signed before SPEC-008).
  readOnly?: boolean;
  // canEdit false hides the Edit button: the user lacks the role, and a RoleNotice on the view says so.
  canEdit?: boolean;
  // schemaVersionId: show and edit the JSON value as a form for this schema version (SPEC-009-R09).
  // warnOnly lists its problems as a warning (a planned run's params are only checked at start).
  schemaVersionId?: string;
  warnOnly?: boolean;
  // onSave resolves 'proposed' when it proposed a change set instead of changing the record.
  onSave: (value: string, reason: string) => Promise<void | 'proposed'>;
};

// EditField shows a value with an Edit control. Saving needs a reason. A "changed" button
// opens the bottom panel's Revisions tab. A successful save dispatches labrat:revised, unless it
// only proposed a correction, which links to the review inbox instead.
export default function EditField({ label, value, multiline, json, changed, proposeOnly, readOnly, canEdit = true, schemaVersionId, warnOnly, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [proposed, setProposed] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [saveProblems, setSaveProblems] = useState<SchemaProblem[] | null>(null);
  const source = `edit:${useId()}`;
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  // A failed load falls back to the JSON box, with the message shown.
  useEffect(() => {
    setSchema(null);
    if (!schemaVersionId) return;
    let live = true;
    getSchemaVersion(schemaVersionId)
      .then((v) => {
        if (!live) return;
        if (v.bundled) setSchema(v.bundled as RJSFSchema);
        else setError('Could not load the schema: no bundled form.');
      })
      .catch((err: unknown) => {
        if (live) setError(`Could not load the schema: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      live = false;
    };
  }, [schemaVersionId]);

  const draftValue = parseOrEmpty(draft);
  const hookProblems = useSchemaValidation(
    source,
    editing && schema && schemaVersionId ? { schemaVersionId } : null,
    draftValue,
  );
  const problems = saveProblems ?? hookProblems;

  // Leaving edit mode unmounts the form, so return focus to the Edit button.
  useEffect(() => {
    if (!editing && wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  function startEdit() {
    setDraft(value);
    setReason('');
    setError(null);
    setSaveProblems(null);
    setProposed(false);
    setEditing(true);
  }

  function cancel() {
    setError(null);
    setEditing(false);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft);
      } catch {
        setError('Value must be valid JSON.');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Value must be a JSON object.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const result = await onSave(draft, reason.trim());
      setEditing(false);
      if (proposeOnly || result === 'proposed') setProposed(true);
      else window.dispatchEvent(new CustomEvent('labrat:revised'));
    } catch (err: unknown) {
      setError(err);
      if (err instanceof ApiError && err.problems.length > 0) setSaveProblems(err.problems);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="edit-field">
        {schema ? (
          <RecordForm schema={schema} value={parseOrEmpty(value)} onChange={() => {}} problems={[]} readOnly />
        ) : (
          <span className={json || multiline ? 'edit-value mono' : 'edit-value'}>{value}</span>
        )}
        {schemaVersionId ? <ErrorMessage error={error} action="load the schema" /> : null}
        {!canEdit ? null : readOnly ? (
          <span className="muted"> Read-only: this record is frozen.</span>
        ) : (
          <button type="button" className="btn btn-sm" ref={editButton} aria-label={`Edit ${label}`} onClick={startEdit}>
            Edit
          </button>
        )}
        {proposed && (
          <p role="status">
            Correction proposed. A reviewer can commit it from <a href="#/todo/review">To do</a>.
          </p>
        )}
        {changed && (
          <button
            type="button"
            className="changed"
            aria-label={`${label} changed, show revisions`}
            onClick={() => window.dispatchEvent(new CustomEvent('labrat:show-revisions'))}
          >
            changed
          </button>
        )}
      </div>
    );
  }

  return (
    <>
    {schema && (
      <RecordForm
        schema={schema}
        value={draftValue}
        onChange={(v) => {
          setSaveProblems(null);
          setDraft(JSON.stringify(v));
        }}
        problems={problems}
        warnOnly={warnOnly}
      />
    )}
    <form className="edit-form" onSubmit={save}>
      {proposeOnly && (
        <p className="muted">This record is signed. Your change is proposed as a correction, and a reviewer must commit it.</p>
      )}
      {!schema && (
      <label>
        {label}
        {json || multiline ? (
          <textarea
            className={json ? 'mono' : undefined}
            rows={json ? 8 : 4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            autoFocus
          />
        ) : (
          <input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving} autoFocus />
        )}
      </label>
      )}
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} required />
      </label>
      <ErrorMessage error={error} action="save the change" />
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={saving || reason.trim() === ''}>
          {proposeOnly ? 'Propose correction' : 'Save'}
        </button>
        <button type="button" onClick={cancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
    </>
  );
}

function parseOrEmpty(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
