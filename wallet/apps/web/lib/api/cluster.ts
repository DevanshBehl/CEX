import { CLUSTERS, type Cluster } from '@wallet/types';

/**
 * The cluster every request is made against (ADR-0021).
 *
 * # Why this is module state and not a parameter
 *
 * Every call in `endpoints.ts` would otherwise need a cluster argument, and
 * the failure when one was forgotten would be a mainnet answer rendered in a
 * devnet interface. Module state means the header is attached in exactly one
 * place — the same argument that keeps `fetch` confined to `client.ts`.
 *
 * It is a single value for a single browser tab, which is what the user means:
 * they pick a network and everything on the page is about that network.
 */
const STORAGE_KEY = 'atlas.cluster';

/**
 * Nothing until the provider sets it.
 *
 * Deliberately not a hardcoded default: the server's default is the
 * authoritative one, and a client guessing `devnet` while the server defaults
 * to `mainnet-beta` would label real balances as play money. An absent header
 * means "no opinion", and the server answers with its own default.
 */
let active: Cluster | undefined;

export function setActiveCluster(cluster: Cluster): void {
  active = cluster;
}

export function getActiveCluster(): Cluster | undefined {
  return active;
}

/** The header for the current cluster, or nothing when none is chosen. */
export function clusterHeader(): Record<string, string> {
  return active === undefined ? {} : { 'x-solana-cluster': active };
}

/**
 * The stored preference, if it is still a cluster this deployment serves.
 *
 * A stale preference is discarded rather than sent: the deployment may have
 * stopped serving that cluster, and the server would reject every request
 * with a 400 that the user could not clear without knowing about
 * `localStorage`.
 */
export function readStoredCluster(served: readonly Cluster[]): Cluster | undefined {
  if (typeof window === 'undefined') return undefined;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing, or storage disabled. Not an error: the preference is a
    // convenience, and the server's default is a correct answer.
    return undefined;
  }

  if (stored === null) return undefined;
  if (!(CLUSTERS as readonly string[]).includes(stored)) return undefined;
  return served.includes(stored as Cluster) ? (stored as Cluster) : undefined;
}

export function storeCluster(cluster: Cluster): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, cluster);
  } catch {
    // See above. The choice still applies to this session.
  }
}
