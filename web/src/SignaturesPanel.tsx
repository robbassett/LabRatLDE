import { useEffect, useRef, useState } from 'react';
import { type Me, type RunDetail, type Signature } from './api';
import { loadMe } from './me';
import { takePendingSign, type PendingSign } from './auth';
import SignDialog from './SignDialog';

// utc renders a timestamp as "YYYY-MM-DD HH:mm UTC".
export function utc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// SignaturesPanel shows each signature of a run, oldest first, then the policy steps still awaiting one
// (SPEC-008-R12). An invalidated signature is struck through and says why, so colour isn't the only cue.
export default function SignaturesPanel({ run, onSigned }: { run: RunDetail; onSigned: () => void }) {
  const awaiting = run.signing_policy.filter((p) => !run.signatures.some((s) => s.valid && s.step === p.step));
  const [me, setMe] = useState<Me | null>(null);
  const [signing, setSigning] = useState<{ step: number; meaning: string; resume: PendingSign | null } | null>(null);
  const signButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wasSigning = useRef(false);
  const refocus = useRef(false);

  useEffect(() => {
    let live = true;
    loadMe()
      .then((m) => live && setMe(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Back from the re-authentication redirect: reopen the dialog, which signs what was confirmed.
  useEffect(() => {
    const pending = takePendingSign(run.id);
    if (pending) setSigning({ step: pending.step, meaning: pending.meaning, resume: pending });
  }, [run.id]);

  // Closing the dialog returns focus to the Sign button, or to the heading when the button has gone.
  useEffect(() => {
    if (!signing && wasSigning.current) (signButton.current ?? heading.current)?.focus();
    wasSigning.current = signing !== null;
  }, [signing]);

  // After a signature the run reloads and the Sign button may go with it, which would drop focus to the page.
  useEffect(() => {
    if (refocus.current) heading.current?.focus();
    refocus.current = false;
  }, [run]);

  // The Sign button shows when the next step is one the user's role covers and they haven't validly signed.
  const next = awaiting[0];
  const canSign =
    me !== null &&
    next !== undefined &&
    me.kind === 'human' &&
    (run.state === 'completed' || run.state === 'failed') &&
    me.roles.some((g) => g.role === next.role && !g.revoked_at) &&
    !run.signatures.some((s) => s.valid && s.signer === me.handle);

  return (
    <section aria-labelledby="signatures-heading">
      <h2 id="signatures-heading" tabIndex={-1} ref={heading} style={{ marginBottom: 'var(--space-3)' }}>
        Signatures
      </h2>
      <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Signatures and the policy steps awaiting one</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Signer</th>
            <th scope="col">Meaning</th>
            <th scope="col">Signed at</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {run.signatures.map((s) => (
            <SignatureRow key={s.id} sig={s} />
          ))}
          {awaiting.map((p) => (
            <tr key={`awaiting-${p.step}`}>
              <td>{p.step}</td>
              <td className="muted">Awaiting</td>
              <td>{p.meaning}</td>
              <td />
              <td className="muted">Awaiting a {p.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {canSign && (
        <p>
          <button
            type="button"
            id="sign-next"
            className="btn btn-primary"
            ref={signButton}
            onClick={() => setSigning({ step: next.step, meaning: next.meaning, resume: null })}
          >
            Sign as {next.meaning}
          </button>
        </p>
      )}
      {signing && (
        <SignDialog
          run={run}
          step={signing.step}
          meaning={signing.meaning}
          resume={signing.resume}
          onClose={() => setSigning(null)}
          onSigned={() => {
            refocus.current = true;
            setSigning(null);
            onSigned();
          }}
        />
      )}
    </section>
  );
}

function SignatureRow({ sig }: { sig: Signature }) {
  return (
    <tr className={sig.valid ? undefined : 'invalidated'}>
      <td>{sig.step}</td>
      <td>{sig.valid ? sig.printed_name : <s>{sig.printed_name}</s>}</td>
      <td>{sig.meaning}</td>
      <td>
        <time dateTime={sig.signed_at}>{utc(sig.signed_at)}</time>
      </td>
      <td>
        {sig.valid ? (
          <span className="badge tone-ok">Valid</span>
        ) : (
          <span>
            Invalidated by change request <a href="#/todo/review">{sig.invalidated_by_change_set?.slice(0, 8)}</a>:{' '}
            {sig.invalidated_reason}
          </span>
        )}
        {sig.comment && <span className="muted"> · {sig.comment}</span>}
      </td>
    </tr>
  );
}
