import { z } from 'zod';
import type { Brand } from './brands.js';

/**
 * Clusters, and the ledger asset key (ADR-0021).
 *
 * # Why the cluster is inside the asset key
 *
 * Devnet SOL and mainnet SOL are both `SOL`. With no cluster dimension they are
 * the same ledger account, and worthless testnet balances add to real ones
 * while every double-entry invariant still passes — nothing is inconsistent,
 * it is simply wrong.
 *
 * A `cluster` COLUMN would fix that only if every query remembered to filter on
 * it. Forgetting silently sums clusters: the query returns a number, the number
 * is wrong, and nothing reports an error.
 *
 * Putting the cluster in the key makes that mistake unrepresentable. There is
 * no query that merges clusters by omission, because there is no key that means
 * "both". Same reasoning as `user_locked` being an account rather than a column.
 */

export const CLUSTERS = ['localnet', 'devnet', 'testnet', 'mainnet-beta'] as const;
export type Cluster = (typeof CLUSTERS)[number];

export const clusterSchema = z.enum(CLUSTERS);

/** Clusters whose funds have no monetary value. */
export const TEST_CLUSTERS: ReadonlySet<Cluster> = new Set<Cluster>([
  'localnet',
  'devnet',
  'testnet',
]);

export function isTestCluster(cluster: Cluster): boolean {
  return TEST_CLUSTERS.has(cluster);
}

/**
 * A ledger asset key: `<cluster>:<asset>`.
 *
 * Branded so a bare string cannot be passed where a key is expected. The whole
 * protection is that you cannot get one by accident — `'SOL'` does not
 * typecheck as a `LedgerAssetKey`, so an unqualified asset cannot reach the
 * ledger.
 */
export type LedgerAssetKey = Brand<string, 'LedgerAssetKey'>;

/** The separator. `:` cannot appear in a cluster name or a base58 mint. */
const SEPARATOR = ':';

export function ledgerAssetKey(cluster: Cluster, asset: string): LedgerAssetKey {
  if (asset.includes(SEPARATOR)) {
    // Otherwise `parse` cannot round-trip, and a mint containing a colon would
    // silently become a different key than the one that was stored.
    throw new TypeError(`asset must not contain "${SEPARATOR}": ${asset}`);
  }
  return `${cluster}${SEPARATOR}${asset}` as LedgerAssetKey;
}

export interface ParsedAssetKey {
  readonly cluster: Cluster;
  /** `SOL`, or a mint address. */
  readonly asset: string;
}

export function parseLedgerAssetKey(key: string): ParsedAssetKey {
  const index = key.indexOf(SEPARATOR);
  if (index === -1) {
    throw new TypeError(`not a ledger asset key (no cluster): ${key}`);
  }

  const cluster = key.slice(0, index);
  const asset = key.slice(index + 1);

  if (!(CLUSTERS as readonly string[]).includes(cluster)) {
    throw new TypeError(`unknown cluster in asset key: ${cluster}`);
  }
  if (asset === '') {
    throw new TypeError(`empty asset in key: ${key}`);
  }

  return { cluster: cluster as Cluster, asset };
}

/** True when `key` belongs to `cluster`. Cheaper than parsing. */
export function assetKeyInCluster(key: string, cluster: Cluster): boolean {
  return key.startsWith(`${cluster}${SEPARATOR}`);
}

/**
 * The operational chain id for a cluster — what the `chain` column carries on
 * addresses, deposits, withdrawals, nonce accounts and indexer cursors.
 *
 * `solana:devnet`, not `solana`. Those tables already had a `chain` column, so
 * they need no migration to become per-cluster; they just need the value to say
 * which cluster.
 */
export function chainId(cluster: Cluster): string {
  return `solana${SEPARATOR}${cluster}`;
}

/**
 * How a cluster is shown to a person.
 *
 * `intent` drives the colour of the status pill: a test cluster must be
 * unmistakable, because the failure mode is someone sending real money to an
 * address that only exists on devnet. Held here rather than in the web app so
 * the API and the UI cannot disagree about which clusters are play money.
 */
export interface ClusterDisplay {
  readonly label: string;
  readonly intent: 'live' | 'test';
  /** Where a block explorer expects the cluster in a query string. */
  readonly explorerQuery: string;
}

export const CLUSTER_DISPLAY: Readonly<Record<Cluster, ClusterDisplay>> = Object.freeze({
  localnet: Object.freeze({ label: 'Localnet', intent: 'test', explorerQuery: 'custom' }),
  devnet: Object.freeze({ label: 'Devnet', intent: 'test', explorerQuery: 'devnet' }),
  testnet: Object.freeze({ label: 'Testnet', intent: 'test', explorerQuery: 'testnet' }),
  'mainnet-beta': Object.freeze({ label: 'Mainnet', intent: 'live', explorerQuery: '' }),
});

export function clusterFromChainId(chain: string): Cluster {
  const index = chain.indexOf(SEPARATOR);
  const candidate = index === -1 ? '' : chain.slice(index + 1);
  if (!(CLUSTERS as readonly string[]).includes(candidate)) {
    throw new TypeError(`not a cluster-qualified chain id: ${chain}`);
  }
  return candidate as Cluster;
}
