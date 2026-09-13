'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Withdrawal } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { useNetwork } from '@/features/network/network-context';

export function useWithdrawals(pollMs = 0) {
  const [data, setData] = useState<Withdrawal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Withdrawal history is per cluster (ADR-0021).
  const { version, ready } = useNetwork();

  const refresh = useCallback(async () => {
    try {
      const { withdrawals } = await api.listWithdrawals();
      setData(withdrawals);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load withdrawals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    setData(null);
    setLoading(true);
    void refresh();
    if (pollMs <= 0) return;
    // A withdrawal moves through several states over a minute or so, and the
    // user is watching. Polling keeps the lifecycle visible.
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs, version, ready]);

  return { data, error, loading, refresh };
}

/** Generated per form, so a retry after a network failure is not a second withdrawal. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
