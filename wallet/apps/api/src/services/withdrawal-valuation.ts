import { createPriceRepository, type PrismaClient } from '@wallet/db';
import { parseUsd, valueOf } from '@wallet/portfolio';
import { parseLedgerAssetKey, type AssetRegistry, type Cluster } from '@wallet/types';

/**
 * What a withdrawal is worth in micro-dollars, for the risk engine (ADR-0024).
 *
 * `null` whenever the answer is not trustworthy — no tick for the asset, or a
 * tick older than `maxAgeSeconds` — so the engine reviews rather than
 * auto-approves. A stale price that happened to be low is exactly how a large
 * withdrawal would slip under the threshold.
 *
 * Uses the registry's decimals, which are otherwise display-only: this value
 * never reaches the ledger, it only decides whether a person looks at the
 * withdrawal, and the ledger lock still moves exact base units.
 */
export type WithdrawalValuation = (
  assetKey: string,
  amount: bigint,
  at: Date,
) => Promise<bigint | null>;

export function createWithdrawalValuation(deps: {
  readonly db: PrismaClient;
  readonly cluster: Cluster;
  readonly assets: AssetRegistry;
  readonly maxAgeSeconds: number;
}): WithdrawalValuation {
  const prices = createPriceRepository(deps.db);

  return async (assetKey, amount, at) => {
    let bare: string;
    try {
      bare = parseLedgerAssetKey(assetKey).asset;
    } catch {
      return null;
    }

    const [tick] = await prices.latestAt(deps.cluster, [bare], at);
    if (tick === undefined) return null;
    if (at.getTime() - tick.recordedAt.getTime() > deps.maxAgeSeconds * 1000) return null;

    try {
      return valueOf(amount, parseUsd(tick.priceUsd), deps.assets.decimalsOf(assetKey));
    } catch {
      return null;
    }
  };
}
