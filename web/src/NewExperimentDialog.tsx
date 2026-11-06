import { useState, type FormEvent } from 'react';
import { ApiError, createExperiment } from './api';
import ErrorMessage from './ErrorMessage';
import { refreshSidebar } from './events';
import Field from './Field';
import type { Tab } from './tabs';
import { toast } from './Toasts';
import { Dialog } from './ui';

export const PROTOCOL_TEMPLATE = `## Aim

## Materials

## Method
1.

## Expected results
`;

// slugify: lower case, non-alphanumerics to "-", trimmed, at most 64 characters (design §3.6).
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

// NewExperimentDialog (SPEC-025-R21): title, short name and a protocol, then
// open the new experiment.
export default function NewExperimentDialog({ isOpen, onClose, open }: { isOpen: boolean; onClose: () => void; open: (t: Tab) => void }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [protocol, setProtocol] = useState(PROTOCOL_TEMPLATE);
  const [error, setError] = useState<unknown>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setTitle('');
    setSlug('');
    setSlugEdited(false);
    setProtocol(PROTOCOL_TEMPLATE);
    setError(null);
    setSlugError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const s = slug.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(s)) {
      setSlugError('Use lower-case letters, digits and hyphens, starting with a letter or digit.');
      return;
    }
    setSaving(true);
    setError(null);
    setSlugError(null);
    try {
      const exp = await createExperiment({ slug: s, title: title.trim(), protocol_md: protocol });
      toast(`Experiment "${exp.title}" created`);
      refreshSidebar();
      open({ kind: 'experiment', id: exp.id, title: exp.slug });
      close();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) setSlugError('That short name is taken. Try another.');
      else setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="New experiment" isOpen={isOpen} onClose={close} wide>
      <form onSubmit={submit}>
        <Field label="Title" hint="What the experiment is for, e.g. HPLC purity of batch lots.">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }}
            required
            autoFocus
            disabled={saving}
          />
        </Field>
        <Field label="Short name" hint="Used in links and lists. Lower case, digits and hyphens." error={slugError}>
          <input
            className="mono"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            required
            maxLength={64}
            disabled={saving}
          />
        </Field>
        <Field
          label="Protocol"
          hint="Write the method in Markdown. You can revise it later: each save is a new version, and runs keep the version they were planned with."
        >
          <textarea className="mono" rows={12} value={protocol} onChange={(e) => setProtocol(e.target.value)} required disabled={saving} />
        </Field>
        <ErrorMessage error={error} action="create the experiment" />
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !title.trim() || !slug.trim() || !protocol.trim()}>
            {saving ? 'Creating…' : 'Create experiment'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
