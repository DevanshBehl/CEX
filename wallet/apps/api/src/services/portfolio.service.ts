import { createLedgerRepository, createPriceRepository, type PrismaClient } from '@wallet/db';
import {
  bucketsFor,
  projectSeries,
  summarise,
  windowStart,
  type PortfolioPoint,
  type PortfolioRange,
  type PortfolioSummary,
  type PriceTick,
  type TimedEntry,
} from '@wallet/portfolio';
import {
  ledgerAssetKey,
  parseLedgerAssetKey,
  type AssetRegistry,
  type Cluster,
} from '@wallet/types';

/**
 * Portfolio valuation, assembled (Task 3).
 *
 * # Where the work happens, and where it does not
 *
 * This service does I/O and nothing else: it reads entries, reads prices, and
 * hands both to `@wallet/portfolio`, which is pure. The arithmetic that turns
 * someone's ledger into a dollar figure lives in a package with no database
 * and no clock, so it can be reproduced from its inputs — which is the only
 * way a number about someone's money can be checked.
 */

/**
 * How many entries one valuation will read.
 *
 * A cap rather than a page: the projection needs EVERY entry before the
 * window, so paging would produce a wrong answer rather than a slow one. An
 * account beyond this says so (`truncated`) instead of quietly starting from
 * the middle of its own history.
 */
const MAX_ENTRIES = 20_000;

export interface PortfolioServiceDeps {
  readonly db: PrismaClient;
  readonly cluster: Cluster;
  readonly assets: AssetRegistry;
  /** Injected so a test can value a portfolio at a fixed instant. */
  readonly now?: () => Date;
}

export interface HistoryResult {
  readonly cluster: Cluster;
  readonly range: PortfolioRange;
  readonly points: readonly PortfolioPoint[];
  /** True when the account has more history than one valuation may read. */
  readonly truncated: boolean;
}

export interface SummaryResult {
  readonly cluster: Cluster;
  readonly summary: PortfolioSummary;
  readonly symbolOf: (asset: string) => string;
  readonly truncated: boolean;
}

export interface PortfolioService {
  history(userId: string, range: PortfolioRange): Promise<HistoryResult>;
  summary(userId: string): Promise<SummaryResult>;
}

export function createPortfolioService(deps: PortfolioServiceDeps): PortfolioService {
  const ledger = createLedgerRepository(deps.db);
  const prices = createPriceRepository(deps.db);
  const clock = deps.now ?? ((): Date => new Date());

  async function valueAt(
    userId: string,
    buckets: readonly Date[],
    now: Date,
  ): Promise<{ points: PortfolioPoint[]; truncated: boolean }> {
    const rows = await ledger.getUserAvailableEntries(userId, deps.cluster, now, MAX_ENTRIES + 1);

    const truncated = rows.length > MAX_ENTRIES;
    const entries: TimedEntry[] = rows.slice(0, MAX_ENTRIES).map((row) => ({
      asset: row.asset,
      amount: BigInt(row.amount),
      direction: row.direction,
      at: row.at,
    }));

    /*
     * Prices for the assets the user actually HOLDS, not for the whole
     * allowlist. An account holding only SOL should not make the endpoint wait
     * on a mint it has never touched.
     */
    const held = [...new Set(entries.map((entry) => entry.asset))];
    const from = buckets[0] ?? now;

    const tickRows = await prices.seriesFor(
      deps.cluster,
      held.map((key) => parseLedgerAssetKey(key).asset),
      from,
      now,
    );

    // Back to cluster-qualified keys: the projection speaks ledger asset keys,
    // and the price table stores the bare asset.
    const byAsset = new Map<string, PriceTick[]>();
    for (const row of tickRows) {
      const key = ledgerAssetKey(deps.cluster, row.asset);
      const list = byAsset.get(key);
      const tick: PriceTick = { asset: key, priceUsd: row.priceUsd, at: row.recordedAt };
      if (list) list.push(tick);
      else byAsset.set(key, [tick]);
    }

    const points = projectSeries({
      entries,
      buckets,
      prices: byAsset,
      decimalsOf: (asset) => deps.assets.decimalsOf(asset),
    });

    return { points, truncated };
  }

  /** When this account's history starts, for the `all` range. */
  async function firstEntryAt(userId: string, now: Date): Promise<Date | null> {
    const rows = await ledger.getUserAvailableEntries(userId, deps.cluster, now, 1);
    return rows[0]?.at ?? null;
  }

  return {
    async history(userId, range) {
      const now = clock();
      const since = range === 'all' ? await firstEntryAt(userId, now) : null;
      const buckets = bucketsFor(range, now, since);

      const { points, truncated } = await valueAt(userId, buckets, now);
      return { cluster: deps.cluster, range, points, truncated };
    },

    async summary(userId) {
      const now = clock();
      /*
       * Exactly two points: now, and 24 hours ago.
       *
       * The 24h delta has to be measured against the SAME projection the
       * headline uses. Computing "now" here and "yesterday" from a different
       * query is how the two end up inconsistent — and a delta that disagrees
       * with the numbers either side of it is the one number on the page
       * nobody can explain.
       */
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const { points, truncated } = await valueAt(userId, [dayAgo, now], now);

      const previous = points[0];
      const current = points[1];
      if (current === undefined) {
        throw new Error('valuation produced no current point');
      }

      return {
        cluster: deps.cluster,
        summary: summarise(current, previous),
        symbolOf: (asset: string) => deps.assets.symbolOf(asset),
        truncated,
      };
    },
  };
}

export { windowStart };
