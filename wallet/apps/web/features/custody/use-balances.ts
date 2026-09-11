'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Balance, Deposit } from '@wallet/types';
import { api, ApiError } from '@/lib/api';

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
    void refresh();
    if (pollMs <= 0) return;
    // Polling rather than WebSockets: rule 177 permits either, and a deposit
    // already takes ~13 seconds to finalize (ADR-0006), so a few seconds of
    // additional latency is not what the user notices.
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { ...state, refresh };
}

export function useDeposits(pollMs = 0) {
  const [state, setState] = useState<LoadState<Deposit[]>>(INITIAL);

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
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { ...state, refresh };
}
