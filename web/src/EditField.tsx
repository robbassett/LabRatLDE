import { useEffect, useRef, useState, type FormEvent } from 'react';

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
  // onSave resolves 'proposed' when it proposed a change set instead of changing the record.
  onSave: (value: string, reason: string) => Promise<void | 'proposed'>;
};

// EditField shows a value with an Edit control. Saving needs a reason. A "changed" button
// opens the bottom panel's Revisions tab. A successful save dispatches labrat:revised, unless it
// only proposed a correction, which links to the review inbox instead.
export default function EditField({ label, value, multiline, json, changed, proposeOnly, readOnly, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [proposed, setProposed] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  // Leaving edit mode unmounts the form, so return focus to the Edit button.
  useEffect(() => {
    if (!editing && wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  function startEdit() {
    setDraft(value);
    setReason('');
    setError(null);
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="edit-field">
        <span className={json || multiline ? 'edit-value mono' : 'edit-value'}>{value}</span>
        {readOnly ? (
          <span className="muted"> Read-only: this record is frozen.</span>
        ) : (
          <button type="button" ref={editButton} aria-label={`Edit ${label}`} onClick={startEdit}>
            Edit
          </button>
        )}
        {proposed && (
          <p role="status">
            Correction proposed. A reviewer can commit it from the <a href="#/inbox">Review inbox</a>.
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
    <form className="edit-form" onSubmit={save}>
      {proposeOnly && (
        <p className="muted">This record is signed. Your change is proposed as a correction, and a reviewer must commit it.</p>
      )}
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
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} required />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || reason.trim() === ''}>
          {proposeOnly ? 'Propose correction' : 'Save'}
        </button>
        <button type="button" onClick={cancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
