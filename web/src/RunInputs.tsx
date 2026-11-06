import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { createEdge, type LineageNode, type RunDetail } from './api';
import EmptyState from './EmptyState';
import ErrorMessage from './ErrorMessage';
import Field from './Field';
import { KIND_LABEL, RELATION_LABEL } from './glossary';
import { InputsArt } from './illustrations';
import { MATERIAL_KINDS, NewNodeForm } from './NewNodeView';
import type { Tab as WorkspaceTab } from './tabs';
import { toast } from './Toasts';
import { Dialog, Tab, TabList, TabPanel, Tabs } from './ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RunInputs (SPEC-025-R25) lists what the run used and adds more while it can
// still change. Edges point downstream: the input is `from`, the run is `to`.
export default function RunInputs({
  run,
  canEdit,
  open,
  onChanged,
}: {
  run: RunDetail;
  canEdit: boolean;
  open: (t: WorkspaceTab) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [existingId, setExistingId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editable = canEdit && (run.state === 'planned' || run.state === 'running' || run.state === 'paused');

  async function link(from: string, what: string) {
    await createEdge({ from, to: run.node_id, relation: 'used' });
    toast(`${what} added as an input`);
    setAdding(false);
    setExistingId('');
    onChanged();
  }

  async function addNew(node: LineageNode) {
    // The item exists now; a failed link leaves it unlinked, which the error says.
    await link(node.id, `${KIND_LABEL[node.kind]} "${node.label}"`);
  }

  async function addExisting(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const id = existingId.trim();
    if (!UUID.test(id)) {
      setIdError('An item ID looks like 0f8c…-…: 36 characters with hyphens. Copy it from the item’s Record details.');
      return;
    }
    setIdError(null);
    setSaving(true);
    setError(null);
    try {
      await link(id, 'Item');
    } catch (err: unknown) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" aria-labelledby="inputs-heading">
      <div className="card-head">
        <h2 id="inputs-heading">Inputs</h2>
        {editable && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" /> Add input
          </button>
        )}
      </div>
      {run.inputs.length === 0 ? (
        <EmptyState
          compact
          icon={<InputsArt />}
          text={editable ? 'No inputs yet. Add the samples and reagents this run uses, so its lineage is traceable.' : 'This run recorded no inputs.'}
        />
      ) : (
        <ul className="list">
          {run.inputs.map((i) => (
            <li key={i.node_id}>
              <span className="badge tone-primary">{KIND_LABEL[i.kind] ?? i.kind}</span>
              <span className="grow">
                <button type="button" className="row-link" onClick={() => open({ kind: 'lineage', id: i.node_id, title: i.label })}>
                  {i.label}
                </button>{' '}
                <span className="muted">{RELATION_LABEL.used}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog title="Add input" isOpen={adding} onClose={() => setAdding(false)} wide>
        <Tabs>
          <TabList aria-label="Add input">
            <Tab id="new">New item</Tab>
            <Tab id="existing">Existing item</Tab>
          </TabList>
          <TabPanel id="new">
            <NewNodeForm kinds={MATERIAL_KINDS} submitLabel="Create and add" onCreated={addNew} />
          </TabPanel>
          <TabPanel id="existing">
            <form onSubmit={addExisting}>
              <Field label="Item ID" hint="Paste the ID, or scan its barcode into this field." error={idError}>
                <input className="mono" value={existingId} onChange={(e) => setExistingId(e.target.value)} required disabled={saving} />
              </Field>
              <ErrorMessage error={error} action="add the input" />
              <div className="dialog-foot">
                <button type="submit" className="btn btn-primary" disabled={saving || existingId.trim() === ''}>
                  Add input
                </button>
              </div>
            </form>
          </TabPanel>
        </Tabs>
      </Dialog>
    </section>
  );
}
