import MarkdownIt from 'markdown-it';
import { useEffect, useState, type FormEvent } from 'react';
import { addNote, editNote, listNotes, proposeChangeSet, type Note } from './api';
import ErrorMessage from './ErrorMessage';

// HTML is disabled, so rendered output cannot contain author-supplied markup.
const md = new MarkdownIt({ html: false, linkify: false });

// proposeOnly: the record is signed, so editing a note that predates the seal proposes a correction.
// readOnly: the record is frozen and can't be corrected. Annotations stay editable either way
// (SPEC-008-R09, R10).
type Props = { nodeId: string; proposeOnly?: boolean; readOnly?: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Notes lists a lineage node's notes, oldest first, with forms to add and edit them.
// A successful note edit dispatches labrat:revised, as the field editors do.
export default function Notes({ nodeId, proposeOnly, readOnly }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [addError, setAddError] = useState<unknown>(null);

  const [editId, setEditId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [editReason, setEditReason] = useState('');
  const [editError, setEditError] = useState<unknown>(null);

  const [saving, setSaving] = useState(false);
  // The note whose correction was just proposed.
  const [proposedId, setProposedId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setLoadError(null);
    setEditId(null);
    listNotes(nodeId)
      .then((r) => {
        if (!live) return;
        setNotes(r.items);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(err);
      });
    return () => {
      live = false;
    };
  }, [nodeId]);

  function reload(): Promise<void> {
    return listNotes(nodeId).then((r) => {
      setNotes(r.items);
      setLoaded(true);
    });
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setAddError(null);
    try {
      await addNote(nodeId, draft);
      setDraft('');
      setPreview(false);
      await reload();
    } catch (err: unknown) {
      setAddError(err);
    } finally {
      setSaving(false);
    }
  }

  function startEdit(n: Note) {
    setEditId(n.id);
    setEditBody(n.body);
    setEditReason('');
    setEditError(null);
    setProposedId(null);
  }

  function cancelEdit() {
    setEditId(null);
    setEditError(null);
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>, id: string, propose: boolean) {
    e.preventDefault();
    setSaving(true);
    setEditError(null);
    try {
      if (propose) {
        await proposeChangeSet('Correct a note', editReason.trim(), [{ op: 'edit_note', note_id: id, body: editBody }]);
        setProposedId(id);
      } else {
        await editNote(id, editBody, editReason.trim());
        window.dispatchEvent(new CustomEvent('labrat:revised'));
      }
      setEditId(null);
      await reload();
    } catch (err: unknown) {
      setEditError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="notes">
      <ErrorMessage error={loadError} action="load notes" />
      {!loaded && !loadError && <p className="muted">Loading notes…</p>}
      {loaded && notes.length === 0 && <p className="muted">No notes yet.</p>}

      {notes.length > 0 && (
        <ol className="note-list">
          {notes.map((n) => {
            const propose = !n.annotation && !!proposeOnly && !readOnly;
            const frozen = !n.annotation && !!readOnly;
            return editId === n.id ? (
              <li key={n.id} className="note">
                <form className="edit-form" onSubmit={(e) => saveEdit(e, n.id, propose)}>
                  {propose && (
                    <p className="muted">This record is signed. Your change is proposed as a correction, and a reviewer must commit it.</p>
                  )}
                  <label>
                    Note
                    <textarea
                      rows={4}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      disabled={saving}
                      autoFocus
                    />
                  </label>
                  <label>
                    Reason
                    <input
                      value={editReason}
                      onChange={(e) => setEditReason(e.target.value)}
                      disabled={saving}
                      required
                    />
                  </label>
                  <ErrorMessage error={editError} action="save the note" />
                  <div className="actions">
                    <button type="submit" disabled={saving || editReason.trim() === '' || editBody.trim() === ''}>
                      {propose ? 'Propose correction' : 'Save'}
                    </button>
                    <button type="button" onClick={cancelEdit} disabled={saving}>
                      Cancel
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={n.id} className="note">
                <p className="note-meta muted">
                  <span>{n.created_by}</span> · <time dateTime={n.created_at}>{n.created_at}</time>
                  {n.annotation && <span className="note-tag"> Annotation (added after sealing)</span>}
                  {n.rev > 1 && <span className="note-tag"> edited (rev {n.rev})</span>}
                </p>
                <div className="note-body" dangerouslySetInnerHTML={{ __html: md.render(n.body) }} />
                {frozen ? (
                  <p className="muted">Read-only: this record is frozen.</p>
                ) : (
                  <button type="button" aria-label={`Edit note from ${n.created_by} at ${n.created_at}`} onClick={() => startEdit(n)}>
                    Edit
                  </button>
                )}
                {proposedId === n.id && (
                  <p role="status">
                    Correction proposed. A reviewer can commit it from <a href="#/todo/review">To do</a>.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <form className="edit-form" onSubmit={add}>
        {preview ? (
          <div className="note-preview">
            <span className="note-meta muted">Preview</span>
            {draft.trim() === '' ? (
              <p className="muted">Nothing to preview.</p>
            ) : (
              <div className="note-body" dangerouslySetInnerHTML={{ __html: md.render(draft) }} />
            )}
          </div>
        ) : (
          <label>
            Add note
            <textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving} />
          </label>
        )}
        <ErrorMessage error={addError} action="add the note" />
        <div className="actions">
          <button type="button" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            Preview
          </button>
          <button type="submit" disabled={saving || draft.trim() === ''}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
