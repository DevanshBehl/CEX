'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Balance, Deposit } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { useNetwork } from '@/features/network/network-context';

interface LoadState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const INITIAL = { data: null, loading: true, error: null } as const;

/**
 * Balances, fetched from the server on every load.
 *
 * Nothing is cached client-side and no balance is ever computed in the browser
 * (master-prompt rule 77, prompt_phase2.md rule 178). The server projects it
 * from ledger entries; the client renders what it is told.
 */
export function useBalances(pollMs = 0) {
  const [state, setState] = useState<LoadState<Balance[]>>(INITIAL);
  /*
   * Balances are PER CLUSTER (ADR-0021).
   *
   * `version` changes exactly when the answer would, so switching networks
   * refetches. `ready` gates the first load: a request made before the cluster
   * is known carries no header and is answered for the server's default, which
   * would render one network's balances under another's label for a moment.
   */
  const { version, ready } = useNetwork();

  const refresh = useCallback(async () => {
    try {
      const { balances } = await api.listBalances();
      setState({ data: balances, loading: false, error: null });
    } catch (error) {
      setState({
        data: null,
        loading: false,
        error: error instanceof ApiError ? error.message : 'Could not load balances.',
      });
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    setState(INITIAL);
    void refresh();
    if (pollMs <= 0) return;
    // Polling rather than WebSockets: rule 177 permits either, and a deposit
    // already takes ~13 seconds to finalize (ADR-0006), so a few seconds of
    // additional latency is not what the user notices.
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs, version, ready]);

  return { ...state, refresh };
}

export function useDeposits(pollMs = 0) {
  const [state, setState] = useState<LoadState<Deposit[]>>(INITIAL);
  const { version, ready } = useNetwork();

  const refresh = useCallback(async () => {
    try {
      const { deposits } = await api.listDeposits();
      setState({ data: deposits, loading: false, error: null });
    } catch (error) {
      setState({
        data: null,
        loading: false,
        error: error instanceof ApiError ? error.message : 'Could not load deposits.',
      });
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    setState(INITIAL);
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs, version, ready]);

  return { ...state, refresh };
}
