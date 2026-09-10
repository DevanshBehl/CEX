'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { CurrentSessionResponse } from '@wallet/types';
import { api, ApiError } from '@/lib/api';

type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; data: CurrentSessionResponse }
  | { status: 'anonymous' };

interface SessionContextValue {
  readonly state: SessionState;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly setSession: (data: CurrentSessionResponse) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * The single source of truth for "am I signed in".
 *
 * It asks the server (rule 77 / master-prompt rule 77) rather than reading a
 * client-side flag. There is no localStorage entry and no JS-readable cookie to
 * consult, by design (rule 165) — the session cookie is httpOnly, so the only
 * honest way to know is to call /auth/session.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const data = await api.currentSession();
      setState({ status: 'authenticated', data });
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthenticated) {
        setState({ status: 'anonymous' });
        return;
      }
      setState({ status: 'anonymous' });
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setState({ status: 'anonymous' });
    }
  }, []);

  const setSession = useCallback((data: CurrentSessionResponse) => {
    setState({ status: 'authenticated', data });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ state, refresh, signOut, setSession }),
    [state, refresh, signOut, setSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
