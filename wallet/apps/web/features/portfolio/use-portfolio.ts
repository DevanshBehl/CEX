'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PortfolioHistoryResponse, PortfolioSummaryResponse } from '@wallet/types';
import { api, ApiError, type PortfolioRangeName } from '@/lib/api';
import { useNetwork } from '@/features/network/network-context';

/**
 * Portfolio valuation, fetched per cluster (Task 3).
 *
 * Nothing is computed here. The server projects the ledger and multiplies by a
 * recorded price; the client renders what it is told. A total assembled in the
 * browser would be a number nobody could reproduce — and this is the number a
 * user reads first.
 */

interface LoadState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const INITIAL = { data: null, loading: true, error: null } as const;

export function usePortfolioSummary(pollMs = 0) {
  const [state, setState] = useState<LoadState<PortfolioSummaryResponse>>(INITIAL);
  const { version, ready } = useNetwork();

  const refresh = useCallback(async () => {
    try {
      setState({ data: await api.getPortfolioSummary(), loading: false, error: null });
    } catch (error) {
      setState({
        data: null,
        loading: false,
        error: error instanceof ApiError ? error.message : 'Could not value your portfolio.',
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

export function usePortfolioHistory(range: PortfolioRangeName) {
  const [state, setState] = useState<LoadState<PortfolioHistoryResponse>>(INITIAL);
  const { version, ready } = useNetwork();

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    /*
     * The previous series is KEPT while a new range loads.
     *
     * Clearing it would collapse the chart to an empty box on every toggle,
     * and the toggles are the part someone clicks repeatedly. The loading flag
     * dims it instead.
     */
    setState((current) => ({ ...current, loading: true, error: null }));

    void api
      .getPortfolioHistory(range)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: error instanceof ApiError ? error.message : 'Could not load your history.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [range, version, ready]);

  return state;
}
