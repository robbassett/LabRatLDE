import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, createSignChallenge, getManifest, meta as loadMeta, signRun, type OIDCSettings, type RunDetail, type RunManifest } from './api';
import { beginReauth, clearPendingSign, reauthToken, type PendingSign } from './auth';
import ErrorMessage from './ErrorMessage';

type Props = {
  run: RunDetail;
  step: number;
  meaning: string;
  // resume is a signature the re-authentication redirect interrupted: it is posted on mount.
  resume: PendingSign | null;
  onClose: () => void;
  onSigned: () => void;
};

// What the signature binds to, as far as the summary shows it (SPEC-008-R02).
type Shown = {
  params: unknown;
  inputs: { node_id: string }[];
  datasets: { node_id: string; count: number | null; sha256: string | null }[];
  notes: { note_id: string }[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function show(v: unknown): string {
  return v === undefined ? 'none' : JSON.stringify(v);
}

// SignDialog asks the signer to review the manifest, confirm, and (in prod) log in again. The hash it
// signs is the one of the manifest on screen when they confirmed; it is never refetched afterwards, or the
// signature would no longer bind to what they saw (SPEC-008-R18).
export default function SignDialog({ run, step, meaning, resume, onClose, onSigned }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resumed = useRef(false);
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [oidc, setOidc] = useState<OIDCSettings | undefined>();
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [comment, setComment] = useState(resume?.comment ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(resume !== null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let live = true;
    loadMeta()
      .then((m) => {
        if (live) {
          setOidc(m.oidc);
          setMetaLoaded(true);
        }
      })
      .catch((err: unknown) => live && setError(errorMessage(err)));
    getManifest(run.id)
      .then((m) => live && setManifest(m))
      .catch((err: unknown) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [run.id]);

  // post signs the hash the signer saw. On a 409 for a changed record it shows the new manifest and asks again.
  async function post(sha256: string, text: string, token?: string) {
    setBusy(true);
    setError(null);
    try {
      await signRun(run.id, { step, meaning, manifest_sha256: sha256, comment: text || undefined, reauth_token: token });
      onSigned();
      return;
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          const fresh = await getManifest(run.id);
          if (fresh.sha256 !== sha256) {
            setManifest(fresh);
            setConfirmed(false);
            setNotice('The record changed since you reviewed it. Review the updated manifest and confirm again.');
            setBusy(false);
            return;
          }
        } catch {
          // Fall through to the server's own message.
        }
      }
      setError(errorMessage(err));
    }
    setBusy(false);
  }

  // Back from the IdP: sign what the user confirmed before the redirect.
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    void post(resume.sha256, resume.comment, reauthToken());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!manifest || !confirmed) return;
    setNotice(null);
    if (!oidc) {
      await post(manifest.sha256, comment.trim());
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { nonce } = await createSignChallenge(run.id, manifest.sha256);
      await beginReauth(oidc, { runId: run.id, step, meaning, comment: comment.trim(), sha256: manifest.sha256 }, nonce);
    } catch (err: unknown) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  // Back from the login page with this page restored as it was: the attempt is
  // abandoned, so nothing is pending and the user can confirm again.
  useEffect(() => {
    const restored = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      clearPendingSign();
      setBusy(false);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  let shown: Shown | null = null;
  if (manifest) {
    try {
      shown = JSON.parse(manifest.manifest) as Shown;
    } catch {
      shown = null;
    }
  }

  return (
    <dialog ref={dialog} className="sign-dialog" aria-labelledby="sign-dialog-title" onClose={onClose}>
      <form onSubmit={confirm}>
        <h2 id="sign-dialog-title">
          Sign run: {meaning} (step {step})
        </h2>

        {notice && <p role="status">{notice}</p>}

        <h3>What you are signing</h3>
        {!manifest ? (
          <p className="muted">Loading the record…</p>
        ) : (
          <>
            <dl className="sign-summary">
              <dt>Protocol</dt>
              <dd>
                v{run.protocol_version} <span className="mono hash">{run.protocol_sha256}</span>
              </dd>
              <dt>Params</dt>
              <dd className="mono">{show(shown?.params)}</dd>
              <dt>Inputs</dt>
              <dd>{shown?.inputs.length ?? 0}</dd>
              <dt>Notes</dt>
              <dd>{shown?.notes.length ?? 0}</dd>
              <dt>Manifest SHA-256</dt>
              <dd className="mono hash">{manifest.sha256}</dd>
            </dl>
            {shown && shown.datasets.length > 0 && (
              <table className="data">
                <caption className="sr-only">Datasets in the manifest</caption>
                <thead>
                  <tr>
                    <th scope="col">Dataset</th>
                    <th scope="col">Readings</th>
                    <th scope="col">SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.datasets.map((d) => (
                    <tr key={d.node_id}>
                      <td className="mono">{d.node_id.slice(0, 8)}</td>
                      <td>{d.count ?? 'not recorded'}</td>
                      <td className="mono hash">{d.sha256 ?? 'not recorded'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>Changes since the previous signature</h3>
            {!manifest.previous ? (
              <p className="muted">No earlier valid signature.</p>
            ) : manifest.changes.length === 0 ? (
              <p className="muted">None since step {manifest.previous.step}.</p>
            ) : (
              <ul className="sign-changes">
                {manifest.changes.map((c) => (
                  <li key={c.path}>
                    <span className="mono">{c.path}</span> {c.kind}
                    {c.kind !== 'added' && <> from <span className="mono">{show(c.from)}</span></>}
                    {c.kind !== 'removed' && <> to <span className="mono">{show(c.to)}</span></>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <label className="sign-field">
          Comment (optional)
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
        </label>

        <label className="sign-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} required />
          By signing I confirm I have reviewed this record, and my signature means: {meaning}
        </label>

        {metaLoaded && (
          <p className="muted">
            {oidc ? 'You will be asked to log in again before the signature is applied.' : 'Dev mode: no re-authentication'}
          </p>
        )}

        <ErrorMessage error={error} action="sign the run" />

        <div className="actions">
          <button type="submit" disabled={busy || !manifest || !metaLoaded}>
            {busy ? 'Signing…' : 'Sign'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
