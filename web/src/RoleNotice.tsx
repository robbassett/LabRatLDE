import { Info } from 'lucide-react';
import type { Role } from './api';
import { hasRole, useMe } from './me';

const ROLE_WORD: Record<Role, string> = {
  scientist: 'scientist',
  reviewer: 'reviewer',
  qa: 'QA',
  admin: 'admin',
  schema_steward: 'schema steward',
};

// RoleNotice says why actions are missing when the user lacks the role they need (SPEC-025-R19):
// the UI hides or disables what the server would refuse, so it must also say so, and who can fix it.
export default function RoleNotice({ role = 'scientist', what }: { role?: Role; what: string }) {
  const me = useMe();
  if (!me || hasRole(me, role)) return null;
  const none = !me.roles.some((g) => !g.revoked_at);
  return (
    <div className="notice" role="note">
      <Info size={18} aria-hidden="true" />
      <p>
        <strong>{none ? 'Your account has no roles yet' : `Your account doesn't have the ${ROLE_WORD[role]} role`},</strong> so you can look
        but not {what}. Ask an admin to grant the {ROLE_WORD[role]} role in Admin → Users and service accounts.
      </p>
    </div>
  );
}
