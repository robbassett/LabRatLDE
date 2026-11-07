import { ApiError } from './api';

export type Explained = { title: string; detail: string; hint: string; server?: string };

// explain turns a failed call into what went wrong and what to do (SPEC-025-R19,
// design §3.7). The API carries no error codes, so the HTTP status picks the
// message and the server's own text follows as detail.
export function explain(err: unknown, action: string): Explained {
  const title = `Couldn't ${action}`;
  // A plain string is a message the UI wrote itself (e.g. "Value must be valid JSON").
  if (typeof err === 'string') return { title, detail: err, hint: '' };
  if (!(err instanceof ApiError)) {
    if (err instanceof TypeError) {
      return { title, detail: "LabRat can't be reached.", hint: 'Check your connection and try again. Nothing was saved.' };
    }
    return { title, detail: 'Something went wrong.', hint: 'Try again.', server: err instanceof Error ? err.message : String(err) };
  }
  const server = err.message && err.message !== String(err.status) ? err.message : undefined;
  const s = err.status;
  const pick = (detail: string, hint: string): Explained => ({ title, detail, hint, server });
  if (s === 400) return pick("Something in the request isn't valid.", 'Check the highlighted fields.');
  if (s === 401) return pick('Your session has ended.', 'Sign in again.');
  if (s === 403) {
    // The database names the roles it wanted: "role denied: needs reviewer or qa".
    const m = /needs ([a-z_]+(?: or [a-z_]+)*)/.exec(err.message);
    if (m) {
      const roles = m[1].replace(/_/g, ' ');
      return { title, detail: `This needs the ${roles} role, and your account doesn't have it.`, hint: 'Ask an admin to grant it in Admin → Users and service accounts.' };
    }
    return pick("You don't have the role this needs.", 'Ask an admin for the role named below.');
  }
  if (s === 404) return pick("That item doesn't exist, or you can't see it.", 'Check the ID, or ask whoever shared it.');
  if (s === 409)
    return pick(
      'The record changed or is locked: it may be signed or already in that state.',
      'Reload to see its current state. To change a signed record, propose a correction.',
    );
  if (s === 413) return pick('The upload is too large.', 'Split it into smaller parts.');
  if (s === 422 && err.problems.length > 0) return pick("The details don't match the schema.", 'Fix the problems listed in the Problems panel.');
  if (s === 422) return pick("It refers to something that doesn't exist here.", "Check the linked item's ID.");
  if (s >= 500) return pick('LabRat hit an internal error.', 'Try again. If it keeps happening, tell your administrator the time it happened.');
  return pick('The request failed.', 'Try again.');
}
