import { GitBranch, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  blame,
  editExperimentTitle,
  getExperiment,
  listProtocolVersions,
  listRuns,
  setSigningPolicy,
  type Experiment,
  type Me,
  type PolicyStep,
  type ProtocolVersion,
  type Role,
  type RunSummary,
} from './api';
import EditField from './EditField';
import EmptyState from './EmptyState';
import ErrorMessage from './ErrorMessage';
import { openNew } from './events';
import { STATE_WORD } from './glossary';
import { RunsArt } from './illustrations';
import { hasRole, loadMe, useMe } from './me';
import ProtocolEditor, { md, stripFrontmatter } from './ProtocolEditor';
import RecordDetails from './RecordDetails';
import StatusBadge from './StatusBadge';
import { tabKey, type Tab } from './tabs';
import { toast } from './Toasts';
import { Tab as ViewTab, TabList, TabPanel, Tabs } from './ui';

type Props = { id: string; open: (t: Tab) => void; rename: (key: string, title: string) => void };

type State =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; exp: Experiment; versions: ProtocolVersion[]; runs: RunSummary[]; moreRuns: boolean; changed: boolean };

// The v1 meanings and the roles a step may require (SPEC-008 design section 2).
const MEANINGS = ['author', 'review', 'approval', 'verification'];
const POLICY_ROLES: Role[] = ['scientist', 'reviewer', 'qa'];

// Who may change a signing policy depends on the tenant's GxP mode (SPEC-008-R15). The database decides;
// this only decides whether to show the control.
function canEditPolicy(me: Me): boolean {
  const allowed: Role[] = me.tenant_gxp ? ['qa', 'admin'] : ['reviewer', 'qa', 'admin'];
  return me.roles.some((g) => !g.revoked_at && allowed.includes(g.role));
}

// PolicySection shows the signing steps. Users the tenant's mode allows get a form to change them,
// which needs a reason and sends the steps renumbered from 1.
function PolicySection({ exp, onSaved }: { exp: Experiment; onSaved: () => Promise<void> }) {
  const [me, setMe] = useState<Me | null>(null);
  const [editing, setEditing] = useState(false);
  const [steps, setSteps] = useState<PolicyStep[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    let live = true;
    loadMe()
      .then((m) => live && setMe(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Leaving edit mode unmounts the form, so return focus to the Edit button.
  useEffect(() => {
    if (!editing && wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  function startEdit() {
    setSteps(exp.signing_policy.map((p) => ({ ...p })));
    setReason('');
    setError(null);
    setEditing(true);
  }

  function update(i: number, patch: Partial<PolicyStep>) {
    setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  function move(i: number, by: number) {
    setSteps((xs) => {
      const j = i + by;
      if (j < 0 || j >= xs.length) return xs;
      const out = [...xs];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (steps.length === 0) {
      setError('A signing policy needs at least one step.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setSigningPolicy(exp.id, steps.map((p, i) => ({ ...p, step: i + 1 })), reason.trim());
      await onSaved();
      setEditing(false);
      toast('Signing policy saved');
      window.dispatchEvent(new CustomEvent('labrat:revised'));
    } catch (err: unknown) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="policy-heading">
      <h2 id="policy-heading" style={{ marginTop: 0 }}>Signing policy</h2>
      <p className="muted">Runs copy this policy when they are created. Changing it does not affect existing runs.</p>
      <table className="table" style={{ maxWidth: '32rem' }}>
        <caption className="sr-only">Signing policy steps</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Meaning</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {exp.signing_policy.map((p) => (
            <tr key={p.step}>
              <td>{p.step}</td>
              <td>{p.meaning}</td>
              <td>{p.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!editing && me && canEditPolicy(me) && (
        <p>
          <button type="button" className="btn" ref={editButton} onClick={startEdit}>
            Edit signing policy
          </button>
        </p>
      )}
      {editing && (
        <form className="edit-form" onSubmit={save} aria-label="Edit signing policy">
          {steps.map((p, i) => (
            <fieldset key={i}>
              <legend>Step {i + 1}</legend>
              <label>
                Meaning
                <select value={p.meaning} onChange={(e) => update(i, { meaning: e.target.value })} disabled={saving} autoFocus={i === 0}>
                  {MEANINGS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Role
                <select value={p.role} onChange={(e) => update(i, { role: e.target.value as Role })} disabled={saving}>
                  {POLICY_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button type="button" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)} disabled={saving || i === 0}>
                  Up
                </button>
                <button type="button" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)} disabled={saving || i === steps.length - 1}>
                  Down
                </button>
                <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))} disabled={saving}>
                  Remove
                </button>
              </div>
            </fieldset>
          ))}
          <p>
            <button type="button" onClick={() => setSteps((xs) => [...xs, { step: xs.length + 1, meaning: 'review', role: 'reviewer' }])} disabled={saving}>
              Add step
            </button>
          </p>
          <label>
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} required />
          </label>
          <ErrorMessage error={error} action="save the signing policy" />
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={saving || reason.trim() === ''}>
              Save signing policy
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

async function load(id: string) {
  const [exp, versions, b, runs] = await Promise.all([getExperiment(id), listProtocolVersions(id), blame('experiment', id), listRuns(id)]);
  return { exp, versions, runs: runs.items, moreRuns: runs.next_cursor !== null, changed: b.fields.some((f) => f.rev > 1) };
}

// ExperimentView (SPEC-025-R22): Overview (runs and protocol), Protocol
// (editor, versions, diff) and Settings (signing policy).
export default function ExperimentView({ id, open, rename }: Props) {
  const me = useMe();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [tab, setTab] = useState<string>('overview');

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load(id)
      .then((d) => {
        if (!live) return;
        setState({ status: 'ready', ...d });
        rename(tabKey({ kind: 'experiment', id }), d.exp.slug);
      })
      .catch((error: unknown) => live && setState({ status: 'error', error }));
    return () => {
      live = false;
    };
  }, [id, rename]);

  if (state.status === 'loading') return <p className="muted">Loading experiment…</p>;
  if (state.status === 'error') return <ErrorMessage error={state.error} action="load the experiment" />;

  const { exp, versions, runs, moreRuns, changed } = state;
  const canCreate = hasRole(me, 'scientist');
  const current =
    versions.find((v) => v.id === exp.protocol_version_id) ??
    versions.reduce<ProtocolVersion | undefined>((a, v) => (!a || v.version > a.version ? v : a), undefined);
  const meta =
    exp.protocol_meta && typeof exp.protocol_meta === 'object' && !Array.isArray(exp.protocol_meta)
      ? Object.entries(exp.protocol_meta as Record<string, unknown>)
      : [];
  const counts = runs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.state]: (m[r.state] ?? 0) + 1 }), {});

  // reload fetches everything again after an edit.
  async function reload() {
    const d = await load(id);
    setState({ status: 'ready', ...d });
  }

  return (
    <article className="view">
      <div className="view-head">
        <div style={{ flex: '1 1 24rem', minWidth: 0 }}>
          <div className="view-title">
            <EditField
              label="Title"
              value={exp.title}
              changed={changed}
              onSave={async (value, reason) => {
                await editExperimentTitle(id, value, reason);
                toast('Title saved');
                await reload();
              }}
            />
          </div>
          <p className="subtitle">
            <span className="mono">{exp.slug}</span> · protocol v{exp.protocol_version} · {runs.length}
            {moreRuns ? '+' : ''} {runs.length === 1 ? 'run' : 'runs'}
            {Object.entries(counts).map(([s, n]) => (
              <span key={s}>
                {' '}
                · {n} {STATE_WORD[s as keyof typeof STATE_WORD].toLowerCase()}
              </span>
            ))}
          </p>
        </div>
        <div className="actions">
          {current && (
            <button type="button" className="btn" onClick={() => open({ kind: 'lineage', id: current.node_id, title: `${exp.slug} v${current.version}` })}>
              <GitBranch size={16} aria-hidden="true" /> Open lineage
            </button>
          )}
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => openNew('run', exp.id)}>
              <Plus size={16} aria-hidden="true" /> Plan run
            </button>
          )}
        </div>
      </div>

      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
        <TabList aria-label="Experiment sections">
          <ViewTab id="overview">Overview</ViewTab>
          <ViewTab id="protocol">Protocol</ViewTab>
          <ViewTab id="settings">Settings</ViewTab>
        </TabList>

        <TabPanel id="overview">
          <section className="card" aria-labelledby="runs-heading" style={{ marginBottom: 'var(--space-4)' }}>
            <div className="card-head">
              <h2 id="runs-heading">Runs</h2>
            </div>
            {runs.length === 0 ? (
              <EmptyState
                icon={<RunsArt />}
                text="No runs yet. A run is one execution of this protocol: plan one when you're ready to work at the bench."
                action={
                  canCreate && (
                    <button type="button" className="btn btn-primary" onClick={() => openNew('run', exp.id)}>
                      Plan run
                    </button>
                  )
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Runs of this experiment</caption>
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">State</th>
                      <th scope="col">Signatures</th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...runs].reverse().map((r) => (
                      <tr key={r.id}>
                        <td>
                          <button type="button" className="row-link" onClick={() => open({ kind: 'run', id: r.id, title: r.label })}>
                            {r.label}
                          </button>
                        </td>
                        <td>
                          <StatusBadge state={r.state} />
                        </td>
                        <td className="mono">
                          {r.signatures.filter((s) => s.valid).length} of {r.signing_policy.length}
                        </td>
                        <td className="mono">{r.created_at.slice(0, 16).replace('T', ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {moreRuns && <p className="muted">Showing the first {runs.length} runs. The sidebar loads the rest.</p>}
          </section>

          <section className="card" aria-labelledby="protocol-heading">
            <div className="card-head">
              <h2 id="protocol-heading">Protocol v{exp.protocol_version}</h2>
              <button type="button" className="btn btn-link" onClick={() => setTab('protocol')}>
                Edit protocol
              </button>
            </div>
            <div className="protocol" dangerouslySetInnerHTML={{ __html: md.render(stripFrontmatter(exp.protocol_md)) }} />
            {meta.length > 0 && (
              <>
                <h3 style={{ margin: 'var(--space-4) 0 var(--space-2)' }}>Metadata</h3>
                <table className="data">
                  <caption className="sr-only">Protocol metadata</caption>
                  <tbody>
                    {meta.map(([k, v]) => (
                      <tr key={k}>
                        <th scope="row">{k}</th>
                        <td className="mono">{show(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </TabPanel>

        <TabPanel id="protocol">
          <ProtocolEditor exp={exp} versions={versions} canEdit={canCreate} onSaved={reload} />
        </TabPanel>

        <TabPanel id="settings">
          <div className="card">
            <PolicySection exp={exp} onSaved={reload} />
          </div>
        </TabPanel>
      </Tabs>

      <RecordDetails
        rows={[
          { label: 'Experiment ID', value: exp.id },
          { label: 'Protocol version ID', value: exp.protocol_version_id },
          { label: 'Protocol fingerprint (SHA-256)', value: exp.protocol_sha256, term: 'protocol_sha256' },
          { label: 'Protocol item ID (lineage)', value: current?.node_id, term: 'lineage node id' },
          { label: 'Created by', value: `${exp.created_by} · ${exp.created_at.slice(0, 16).replace('T', ' ')}` },
        ]}
      />
    </article>
  );
}
