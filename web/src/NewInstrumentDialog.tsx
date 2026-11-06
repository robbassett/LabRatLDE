import { useState, type FormEvent } from 'react';
import { createInstrument, type Instrument } from './api';
import ErrorMessage from './ErrorMessage';
import { refreshSidebar } from './events';
import Field from './Field';
import type { Tab } from './tabs';
import { toast } from './Toasts';
import { ComboBox, Dialog } from './ui';

// NewInstrumentDialog (SPEC-025-R27): a name and a kind. Kinds already in use
// are suggested; any text is allowed.
export default function NewInstrumentDialog({
  isOpen,
  onClose,
  open,
  instruments,
}: {
  isOpen: boolean;
  onClose: () => void;
  open: (t: Tab) => void;
  instruments: Instrument[];
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const kinds = [...new Set(instruments.map((i) => i.kind))].sort().map((k) => ({ id: k, name: k }));

  function close() {
    setName('');
    setKind('');
    setError(null);
    onClose();
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const inst = await createInstrument({ name: name.trim(), kind: kind.trim() });
      toast(`Instrument "${inst.name}" registered`);
      refreshSidebar();
      open({ kind: 'instrument', id: inst.id, title: inst.name });
      close();
    } catch (err: unknown) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Register instrument" isOpen={isOpen} onClose={close}>
      <form onSubmit={submit}>
        <p className="muted" style={{ marginTop: 0 }}>
          Register an instrument once; its readings can then be sent to any running run.
        </p>
        <Field label="Name" hint="As labelled in the lab, e.g. HPLC-1.">
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus disabled={saving} />
        </Field>
        <ComboBox
          label="Kind"
          hint="The type of instrument, e.g. hplc or plate-reader. Pick one in use or type a new one."
          items={kinds}
          inputValue={kind}
          onInputChange={setKind}
          allowsCustomValue
          isRequired
        />
        <ErrorMessage error={error} action="register the instrument" />
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim() || !kind.trim()}>
            {saving ? 'Registering…' : 'Register instrument'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
