import { useEffect, useState } from 'react';
import { getMe, type Me, type Role } from './api';

// One /v1/me per page load, shared by the shell and the views that gate actions on roles.
let cached: Promise<Me> | null = null;

export function loadMe(): Promise<Me> {
  if (!cached) {
    cached = getMe();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

export function forgetMe() {
  cached = null;
}

export function hasRole(me: Me | null, role: Role): boolean {
  return !!me?.roles.some((g) => g.role === role && !g.revoked_at);
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    loadMe()
      .then((m) => live && setMe(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return me;
}
