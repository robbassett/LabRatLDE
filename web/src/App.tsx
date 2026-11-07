import { useCallback, useEffect, useState } from 'react';
import { clearSession, getMe, meta as loadMeta, setAccessToken, setUnauthorizedHandler, storedActor, type Meta } from './api';
import { clearPendingSign, completeSignIn, endSessionUrl, setLatestIdToken, watchIdle } from './auth';
import { forgetMe } from './me';
import SignIn from './SignIn';
import Workspace from './Workspace';

// A signed-in session: who to show in the header, and (in prod) the ID token
// the IdP's sign-out wants.
type Session = { handle: string; idToken?: string };

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // signOut discards the token (or the dev session) and returns to sign-in.
  const signOut = useCallback((why: string | null) => {
    setAccessToken(null);
    setLatestIdToken(undefined);
    clearSession();
    forgetMe();
    setSession(null);
    setMessage(why);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const m = await loadMeta();
      if (!live) return;
      setMeta(m);
      if (m.env === 'dev') {
        const actor = storedActor();
        if (actor) setSession({ handle: actor });
        return;
      }
      if (!m.oidc) return;
      try {
        const tokens = await completeSignIn(m.oidc);
        // Anything but the return from a forced login abandons a pending signature,
        // and only that return's ID token can prove one (SPEC-008-R04).
        if (!tokens?.reauth) clearPendingSign();
        if (!tokens || !live) return;
        setAccessToken(tokens.accessToken);
        setLatestIdToken(tokens.reauth ? tokens.idToken : undefined);
        const me = await getMe();
        if (live) setSession({ handle: me.on_behalf_of ? me.actor : me.handle, idToken: tokens.idToken });
      } catch (err: unknown) {
        clearPendingSign();
        setAccessToken(null);
        if (live) setMessage(err instanceof Error ? err.message : String(err));
      }
    })().catch((err: unknown) => {
      if (live) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => signOut('Your session has ended. Sign in again.'));
  }, [signOut]);

  // R11: an unattended session signs itself out, in dev as in prod.
  const idleSeconds = meta?.idle_timeout_seconds ?? 0;
  useEffect(() => {
    if (!session || idleSeconds <= 0) return;
    const minutes = Math.round(idleSeconds / 60);
    return watchIdle(idleSeconds, () =>
      signOut(`Signed out after ${minutes} minute${minutes === 1 ? '' : 's'} of inactivity.`),
    );
  }, [session, idleSeconds, signOut]);

  if (error)
    return (
      <p role="alert" className="boot">
        LabRat can't be reached: {error}. Check your connection and reload.
      </p>
    );
  if (!meta) return <p className="boot">Loading…</p>;
  if (!session) return <SignIn meta={meta} message={message} onDevSignIn={(handle) => setSession({ handle })} />;

  // In prod, also end the IdP session, so a shared bench computer doesn't
  // sign the next person straight back in.
  function userSignOut() {
    const idToken = session?.idToken;
    signOut(null);
    if (meta?.env === 'prod' && meta.oidc) {
      endSessionUrl(meta.oidc, idToken)
        .then((url) => {
          if (url) location.assign(url);
        })
        .catch(() => {});
    }
  }

  return <Workspace handle={session.handle} onSignOut={userSignOut} />;
}
