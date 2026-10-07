'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { publicConfig } from '@/lib/config';
import { createSocketClient, type SocketClient, type SocketState } from '@/lib/ws';

/**
 * ONE socket for the trading screen, and its state where every panel can see
 * it (prompt_phase_s5.md rules 139, 143).
 *
 * Every live panel must show whether what it draws is current. That is only
 * possible if the connection's state is something a component can read without
 * owning the connection — so it lives here, and the socket itself lives in
 * `lib/ws`, the one module allowed to construct one.
 */

interface SocketContextValue {
  /** Null when this deployment has no market data: there is nothing to connect to. */
  readonly client: SocketClient | null;
  readonly state: SocketState;
  /**
   * Bumped on every successful (re)connection. Hooks that hold REST data
   * refetch when it changes: the private channel is a hint, and whatever was
   * missed while disconnected is recovered by asking (ADR-0037 §7).
   */
  readonly connection: number;
}

const SocketContext = createContext<SocketContextValue>({
  client: null,
  state: 'closed',
  connection: 0,
});

export function SocketProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [client, setClient] = useState<SocketClient | null>(null);
  const [state, setState] = useState<SocketState>('connecting');
  const [connection, setConnection] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const created = createSocketClient({ url: publicConfig.socketUrl });
    setClient(created);
    setState(created.state);
    const off = created.onState((next) => {
      setState(next);
      if (next === 'open') setConnection((count) => count + 1);
    });
    return () => {
      off();
      created.close();
      setClient(null);
    };
  }, [enabled]);

  const value = useMemo(() => ({ client, state, connection }), [client, state, connection]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export const useSocket = (): SocketContextValue => useContext(SocketContext);
