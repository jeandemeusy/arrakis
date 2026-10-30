'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { api, ApiError } from './api';

/**
 * Who is looking at the studio.
 *
 * `undefined` while the first check is in flight, `null` for a reader, a user
 * for an editor. `unavailable` carries the reason the query store cannot be
 * reached at all — usually that APP_DATABASE_URL is not set — so every page can
 * say so instead of failing piecemeal.
 */

export type SessionUser = { username: string; role: 'editor' | 'admin' };

type SessionState = {
  user: SessionUser | null | undefined;
  unavailable: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState>({
  user: undefined,
  unavailable: null,
  refresh: async () => undefined,
  signOut: async () => undefined,
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const session = await api<{ user: SessionUser | null }>(
        '/api/v1/auth/session',
      );
      setUser(session.user);
      // The session route never fails for a missing app database, so ask a
      // route that does, once, to learn whether the store is usable at all.
      await api('/api/v1/queries?kind=fragment');
      setUnavailable(null);
    } catch (error) {
      setUser((current) => current ?? null);
      if (error instanceof ApiError && error.status === 503) {
        setUnavailable(error.message);
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }, []);

  useEffect(() => {
    let live = true;
    api<{ user: SessionUser | null }>('/api/v1/auth/session')
      .then((session) => live && setUser(session.user))
      .catch(() => live && setUser(null));
    // The session route never fails for a missing app database, so ask a
    // route that does, once, to learn whether the store is usable at all.
    api('/api/v1/queries?kind=fragment').catch((error: unknown) => {
      if (live && error instanceof ApiError && error.status === 503) {
        setUnavailable(error.message);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const value = useMemo(
    () => ({ user, unavailable, refresh, signOut }),
    [user, unavailable, refresh, signOut],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}

/** True once the check has finished and found an editor. */
export function useIsEditor(): boolean {
  return Boolean(useSession().user);
}
