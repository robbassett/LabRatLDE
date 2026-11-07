import MarkdownIt from 'markdown-it';
import { useEffect, useState } from 'react';
import { createProtocolVersion, getProtocolVersion, type Experiment, type ProtocolVersion } from './api';
import { lineDiff, type DiffLine } from './diff';
import ErrorMessage from './ErrorMessage';
import Field from './Field';
import { toast } from './Toasts';

// HTML is disabled, so rendered output cannot contain author-supplied markup.
export const md = new MarkdownIt({ html: false, linkify: false });

// Drops a leading YAML frontmatter block; the metadata table shows it.
export function stripFrontmatter(text: string): string {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/.exec(t);
  return m ? t.slice(m[0].length) : t;
}

type Diff = { status: 'idle' } | { status: 'error'; error: unknown } | { status: 'done'; lines: DiffLine[] };

// ProtocolEditor (SPEC-025-R22): Markdown beside a live preview; saving makes a
// new protocol version. Below it, the versions and a diff between any two.
export default function ProtocolEditor({
  exp,
  versions,
  canEdit,
  onSaved,
}: {
  exp: Experiment;
  versions: ProtocolVersion[];
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const [text, setText] = useState(exp.protocol_md);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sorted = [...versions].sort((p, q) => p.version - q.version);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<Diff>({ status: 'idle' });
  const dirty = text !== exp.protocol_md;

  // Default to comparing the previous version with the current one.
  useEffect(() => {
    const cur = sorted.find((v) => v.id === exp.protocol_version_id) ?? sorted[sorted.length - 1];
    const prev = [...sorted].reverse().find((v) => cur && v.version < cur.version) ?? cur;
    setFrom(prev?.id ?? '');
    setTo(cur?.id ?? '');
    setDiff({ status: 'idle' });
    // Recompute when the version list changes.
  }, [versions.length, exp.protocol_version_id]);

  useEffect(() => setText(exp.protocol_md), [exp.protocol_md]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const pv = await createProtocolVersion(exp.id, text);
      toast(`Protocol saved as version ${pv.version}`);
      await onSaved();
    } catch (err: unknown) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  function compare() {
    Promise.all([getProtocolVersion(from), getProtocolVersion(to)])
      .then(([a, b]) => setDiff({ status: 'done', lines: lineDiff(a.protocol_md ?? '', b.protocol_md ?? '') }))
      .catch((error: unknown) => setDiff({ status: 'error', error }));
  }

  return (
    <>
      {canEdit ? (
        <section aria-labelledby="protocol-edit-heading" className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="card-head">
            <h2 id="protocol-edit-heading">Edit protocol (current: v{exp.protocol_version})</h2>
          </div>
          <div className="split">
            <Field label="Markdown" hint="Runs already planned keep the version they pinned.">
              <textarea className="mono" rows={18} value={text} onChange={(e) => setText(e.target.value)} disabled={saving} />
            </Field>
            <div>
              <p className="field-label" id="preview-label" style={{ margin: '0 0 var(--space-1)' }}>
                Preview
              </p>
              <div
                className="protocol card"
                aria-labelledby="preview-label"
                role="region"
                style={{ background: 'var(--bg)' }}
                dangerouslySetInnerHTML={{ __html: md.render(stripFrontmatter(text)) }}
              />
            </div>
          </div>
          <ErrorMessage error={error} action="save the protocol" />
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !dirty || !text.trim()}>
              {saving ? 'Saving…' : `Save as version ${exp.protocol_version + 1}`}
            </button>
            {dirty && (
              <button type="button" className="btn" onClick={() => setText(exp.protocol_md)} disabled={saving}>
                Discard changes
              </button>
            )}
          </div>
        </section>
      ) : (
        <p className="muted">You need the scientist role to revise the protocol.</p>
      )}

      <section className="card" aria-labelledby="versions-heading">
        <div className="card-head">
          <h2 id="versions-heading">Versions</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Protocol versions</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Fingerprint</th>
                <th scope="col">Saved by</th>
                <th scope="col">Saved</th>
              </tr>
            </thead>
            <tbody>
              {[...sorted].reverse().map((v) => (
                <tr key={v.id}>
                  <td>
                    v{v.version}
                    {v.id === exp.protocol_version_id && <span className="badge tone-primary" style={{ marginLeft: 'var(--space-2)' }}>Current</span>}
                  </td>
                  <td className="mono" title={v.sha256}>
                    {v.sha256.slice(0, 12)}
                  </td>
                  <td>{v.created_by}</td>
                  <td className="mono">{v.created_at.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ margin: 'var(--space-4) 0 var(--space-2)' }}>Compare versions</h3>
        {versions.length < 2 ? (
          <p className="muted">Save a second version to compare.</p>
        ) : (
          <div className="diff-controls">
            <label>
              From
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {sorted.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              To
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {sorted.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn" onClick={compare}>
              Compare
            </button>
          </div>
        )}
        {diff.status === 'error' && <ErrorMessage error={diff.error} action="compare the versions" />}
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
      </section>
    </>
  );
}
