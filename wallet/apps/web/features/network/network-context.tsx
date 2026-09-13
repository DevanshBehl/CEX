'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CLUSTER_DISPLAY, type Cluster, type ClusterDisplay } from '@wallet/types';
import {
  getActiveCluster,
  readStoredCluster,
  setActiveCluster,
  storeCluster,
} from '@/lib/api/cluster';
import { useCapabilities } from '@/features/platform/use-capabilities';

/**
 * Which Solana cluster the interface is showing (ADR-0021).
 *
 * # Why the served list comes from the server
 *
 * A hardcoded list of four clusters would offer a network this deployment
 * cannot answer for, and every request after the switch would fail with a 400
 * the user has no way to interpret. `/capabilities` already says what the
 * deployment can do and is unauthenticated, so the switcher can be correct
 * before anyone signs in.
 *
 * # Why `version` exists
 *
 * Balances, deposits and withdrawals are all per cluster, and every hook that
 * reads them has to refetch when the cluster changes. Rather than each hook
 * subscribing to the cluster and remembering to, they depend on a counter that
 * changes exactly when the answer would — the same reason a query library has
 * a key.
 */
export interface NetworkState {
  /** Undefined until capabilities load: the server's default is authoritative. */
  readonly cluster: Cluster | undefined;
  readonly served: readonly Cluster[];
  readonly display: ClusterDisplay | undefined;
  /** Bumped on every change, for hooks that must refetch. */
  readonly version: number;
  readonly ready: boolean;
  switchTo(cluster: Cluster): void;
}

const NetworkContext = createContext<NetworkState | undefined>(undefined);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const capabilities = useCapabilities();
  const [cluster, setCluster] = useState<Cluster | undefined>(getActiveCluster);
  const [version, setVersion] = useState(0);

  const served = useMemo(() => capabilities?.clusters.served ?? [], [capabilities]);

  useEffect(() => {
    if (!capabilities) return;

    /*
     * The stored preference wins, then the server's default.
     *
     * A stored cluster this deployment no longer serves is discarded rather
     * than sent: the server would reject every request with a 400 the user
     * could not clear without knowing what localStorage is.
     */
    const preferred = readStoredCluster(capabilities.clusters.served);
    const resolved = preferred ?? capabilities.clusters.default;

    setActiveCluster(resolved);
    setCluster(resolved);
    // Not a version bump. Nothing has been fetched with a different cluster
    // yet, and bumping here would make every page load twice.
  }, [capabilities]);

  const switchTo = useCallback(
    (next: Cluster) => {
      if (next === cluster) return;
      setActiveCluster(next);
      storeCluster(next);
      setCluster(next);
      setVersion((current) => current + 1);
    },
    [cluster],
  );

  const value = useMemo<NetworkState>(
    () => ({
      cluster,
      served,
      display: cluster ? CLUSTER_DISPLAY[cluster] : undefined,
      version,
      ready: cluster !== undefined,
      switchTo,
    }),
    [cluster, served, version, switchTo],
  );

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkState {
  const context = useContext(NetworkContext);
  if (!context) {
    // A hook that silently returned a default would let a component render
    // balances outside the provider — with no cluster header, so the server's
    // default would answer and the page would look right while being about a
    // different chain.
    throw new Error('useNetwork must be used inside a NetworkProvider');
  }
  return context;
}
