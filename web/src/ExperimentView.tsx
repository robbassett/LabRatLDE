import MarkdownIt from 'markdown-it';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  blame,
  editExperimentTitle,
  getExperiment,
  getMe,
  getProtocolVersion,
  listProtocolVersions,
  setSigningPolicy,
  type Experiment,
  type Me,
  type PolicyStep,
  type ProtocolVersion,
  type Role,
} from './api';
import { lineDiff, type DiffLine } from './diff';
import EditField from './EditField';
import NewRunForm from './NewRunForm';
import { tabKey, type Tab } from './tabs';

// HTML is disabled, so rendered output cannot contain author-supplied markup.
const md = new MarkdownIt({ html: false, linkify: false });

type Props = { id: string; open: (t: Tab) => void; rename: (key: string, title: string) => void };

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; exp: Experiment; versions: ProtocolVersion[]; changed: boolean };

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// Drops a leading YAML frontmatter block; the metadata table already shows it.
function stripFrontmatter(text: string): string {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/.exec(t);
  return m ? t.slice(m[0].length) : t;
}

// The v1 meanings and the roles a step may require (SPEC-008 design section 2).
const MEANINGS = ['author', 'review', 'approval', 'verification'];
const POLICY_ROLES: Role[] = ['scientist', 'reviewer', 'qa'];

// Who may change a signing policy depends on the tenant's GxP mode (SPEC-008-R15). The database decides;
// this only decides whether to show the control.
function canEditPolicy(me: Me): boolean {
  const allowed: Role[] = me.tenant_gxp ? ['qa', 'admin'] : ['reviewer', 'qa', 'admin'];
  return me.roles.some((g) => !g.revoked_at && allowed.includes(g.role));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// PolicySection shows the signing steps. Users the tenant's mode allows get a form to change them,
// which needs a reason and sends the steps renumbered from 1.
function PolicySection({ exp, onSaved }: { exp: Experiment; onSaved: () => Promise<void> }) {
  const [me, setMe] = useState<Me | null>(null);
  const [editing, setEditing] = useState(false);
  const [steps, setSteps] = useState<PolicyStep[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    let live = true;
    getMe()
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
      window.dispatchEvent(new CustomEvent('labrat:revised'));
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="policy-heading">
      <h2 id="policy-heading">Signing policy</h2>
      <p className="muted">Runs copy this policy when they are created. Changing it does not affect existing runs.</p>
      <table className="data">
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
          <button type="button" ref={editButton} onClick={startEdit}>
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
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" disabled={saving || reason.trim() === ''}>
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

type Diff = { status: 'idle' } | { status: 'error'; message: string } | { status: 'done'; lines: DiffLine[] };

export default function ExperimentView({ id, open, rename }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<Diff>({ status: 'idle' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    Promise.all([getExperiment(id), listProtocolVersions(id), blame('experiment', id)])
      .then(([exp, versions, b]) => {
        if (!live) return;
        setState({ status: 'ready', exp, versions, changed: b.fields.some((f) => f.rev > 1) });
        const sorted = [...versions].sort((p, q) => p.version - q.version);
        const cur = sorted.find((v) => v.id === exp.protocol_version_id) ?? sorted[sorted.length - 1];
        const prev = [...sorted].reverse().find((v) => cur && v.version < cur.version) ?? cur;
        setFrom(prev?.id ?? '');
        setTo(cur?.id ?? '');
        setDiff({ status: 'idle' });
        rename(tabKey({ kind: 'experiment', id }), exp.slug);
      })
      .catch((err: unknown) => {
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [id, rename]);

  if (state.status === 'loading') return <p className="muted">Loading experiment…</p>;
  if (state.status === 'error') return <p role="alert" className="error">{state.message}</p>;

  const { exp, versions, changed } = state;
  const current =
    versions.find((v) => v.id === exp.protocol_version_id) ??
    versions.reduce<ProtocolVersion | undefined>((a, v) => (!a || v.version > a.version ? v : a), undefined);
  const meta =
    exp.protocol_meta && typeof exp.protocol_meta === 'object' && !Array.isArray(exp.protocol_meta)
      ? Object.entries(exp.protocol_meta as Record<string, unknown>)
      : [];

  // reload fetches the experiment again after an edit, and whether any field has been revised.
  async function reload() {
    const [next, b] = await Promise.all([getExperiment(id), blame('experiment', id)]);
    setState((s) => (s.status === 'ready' ? { ...s, exp: next, changed: b.fields.some((f) => f.rev > 1) } : s));
  }

  const compare = () => {
    Promise.all([getProtocolVersion(from), getProtocolVersion(to)])
      .then(([a, b]) => setDiff({ status: 'done', lines: lineDiff(a.protocol_md ?? '', b.protocol_md ?? '') }))
      .catch((err: unknown) =>
        setDiff({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  };

  return (
    <article className="view">
      <div className="view-title">
        <EditField
          label="Title"
          value={exp.title}
          changed={changed}
          onSave={async (value, reason) => {
            await editExperimentTitle(id, value, reason);
            await reload();
          }}
        />
      </div>
      <p className="muted">
        <span className="mono">{exp.slug}</span>
      </p>
      <p>
        Version {exp.protocol_version} <span className="mono hash">{exp.protocol_sha256}</span>
      </p>
      {current && (
        <p>
          <button
            type="button"
            onClick={() => open({ kind: 'lineage', id: current.node_id, title: `${exp.slug} v${current.version}` })}
          >
            Open lineage
          </button>
        </p>
      )}

      <NewRunForm exp={exp} open={open} />

      <h2>Protocol</h2>
      <div className="protocol" dangerouslySetInnerHTML={{ __html: md.render(stripFrontmatter(exp.protocol_md)) }} />

      <h2>Metadata</h2>
      {meta.length === 0 ? (
        <p className="muted">No metadata.</p>
      ) : (
        <table className="data">
          <caption className="sr-only">Protocol metadata</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {meta.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td className="mono">{show(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <PolicySection exp={exp} onSaved={reload} />

      <h2>Versions</h2>
      <table className="data">
        <caption className="sr-only">Protocol versions</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Hash</th>
            <th scope="col">Created by</th>
            <th scope="col">Created at</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id}>
              <td>{v.version}</td>
              <td className="mono">{v.sha256.slice(0, 12)}</td>
              <td>{v.created_by}</td>
              <td>{v.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Compare versions</h2>
      {versions.length < 2 ? (
        <p className="muted">Needs two versions</p>
      ) : (
        <div className="diff-controls">
          <label>
            From version
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            To version
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={compare}>
            Compare
          </button>
        </div>
      )}
      {diff.status === 'error' && (
        <p role="alert" className="error">
          {diff.message}
        </p>
      )}
      {diff.status === 'done' &&
        (diff.lines.every((l) => l.op === ' ') ? (
          <p>No differences</p>
        ) : (
          <pre className="diff" aria-label="Protocol diff">
            {diff.lines.map((l, i) => (
              <span key={i} className={l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : undefined}>
                {l.op + ' ' + l.line}
              </span>
            ))}
          </pre>
        ))}
    </article>
  );
}
