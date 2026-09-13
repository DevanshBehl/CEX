import { parseUsd, shareBps, valueOf } from './money.js';

/**
 * Portfolio valuation (Task 3).
 *
 * # What this package is, and what it deliberately is not
 *
 * Pure functions over data that is handed to them. No database, no HTTP, no
 * clock of its own — the same rule `@wallet/ledger` and `@wallet/risk` follow,
 * and for the same reason: a valuation is an assertion about someone's money,
 * and an assertion that cannot be reproduced from its inputs cannot be
 * audited.
 *
 * It is NOT a source of truth about balances. It projects the SAME ledger
 * entries the balance endpoint projects; if the two ever disagree, the
 * projection here is wrong, because there is no balance column to consult.
 */

export type Direction = 'debit' | 'credit';

/** A ledger entry, reduced to what a projection needs. */
export interface TimedEntry {
  /** Cluster-qualified ledger asset key (ADR-0021). */
  readonly asset: string;
  /** Base units, always positive. The sign lives in `direction`. */
  readonly amount: bigint;
  readonly direction: Direction;
  readonly at: Date;
}

/** One observation of an asset's USD price. */
export interface PriceTick {
  readonly asset: string;
  /** Decimal string, as stored. Parsed here, never floated. */
  readonly priceUsd: string;
  readonly at: Date;
}

export interface Holding {
  readonly asset: string;
  /** Base units held at this instant. */
  readonly amount: bigint;
  /** Micro-dollars, or `null` when no price was known at this instant. */
  readonly valueUsd: bigint | null;
}

export interface PortfolioPoint {
  readonly at: Date;
  /** Micro-dollars. Sums only the holdings that could be priced. */
  readonly totalUsd: bigint;
  readonly holdings: readonly Holding[];
  /**
   * True when every non-zero holding had a price.
   *
   * Surfaced rather than hidden: a chart that silently drops an unpriced asset
   * shows a fall in someone's net worth that did not happen, and they will
   * believe it.
   */
  readonly complete: boolean;
}

export interface ProjectInput {
  /**
   * Every `user_available` entry up to the last bucket, ASCENDING by time.
   *
   * All of them, not just those inside the window: a balance at time T is the
   * sum of everything before T, so a window that began after the first deposit
   * would start from zero and render a fictional deposit at its left edge.
   */
  readonly entries: readonly TimedEntry[];
  /** Instants to value, ascending. */
  readonly buckets: readonly Date[];
  /** Ticks per asset, ascending by time. */
  readonly prices: ReadonlyMap<string, readonly PriceTick[]>;
  /** Display decimals for an asset. Used only to scale base units. */
  decimalsOf(asset: string): number;
}

/**
 * Balances and their USD value at each bucket.
 *
 * One pass over the entries and one pass per asset over its ticks — both are
 * already sorted, so this is linear rather than a lookup per (bucket, asset).
 * With 30 buckets and three assets that hardly matters; with a year of daily
 * points and a busy account it is the difference between a page and a timeout.
 */
export function projectSeries(input: ProjectInput): PortfolioPoint[] {
  const balances = new Map<string, bigint>();
  const points: PortfolioPoint[] = [];

  let cursor = 0;
  /*
   * Per-asset walk through that asset's ticks, advanced monotonically with the
   * buckets so each asset's ticks are read once.
   *
   * `last` is the load-bearing half. A cursor alone answers "which ticks are
   * new since the previous bucket", and once the ticks are exhausted that is
   * NONE — so every bucket after the final tick would come back unpriced and
   * the chart would fall to zero at its right edge, which is the part someone
   * is actually looking at. The most recent price REMAINS the most recent
   * price until a newer one arrives.
   */
  const priceWalk = new Map<string, { index: number; last: PriceTick | undefined }>();

  for (const at of input.buckets) {
    while (cursor < input.entries.length) {
      const entry = input.entries[cursor];
      if (entry === undefined || entry.at.getTime() > at.getTime()) break;

      /*
       * A user account is a LIABILITY: a credit increases what the user holds.
       * The same negation as `projectUserBalance` in @wallet/ledger, and it
       * must stay the same — two projections of one number that disagree is
       * worse than one that is wrong.
       */
      const signed = entry.direction === 'credit' ? entry.amount : -entry.amount;
      balances.set(entry.asset, (balances.get(entry.asset) ?? 0n) + signed);
      cursor += 1;
    }

    const holdings: Holding[] = [];
    let total = 0n;
    let complete = true;

    for (const [asset, amount] of [...balances].sort(([a], [b]) => a.localeCompare(b))) {
      const priceMicros = priceAt(input.prices.get(asset) ?? [], at, priceWalk, asset);

      if (priceMicros === null) {
        // A zero holding with no price is not an incomplete valuation: it is
        // worth nothing whatever the price was.
        if (amount !== 0n) complete = false;
        holdings.push({ asset, amount, valueUsd: null });
        continue;
      }

      const value = valueOf(amount, priceMicros, input.decimalsOf(asset));
      total += value;
      holdings.push({ asset, amount, valueUsd: value });
    }

    points.push({ at, totalUsd: total, holdings, complete });
  }

  return points;
}

/**
 * The most recent price AT OR BEFORE `at`.
 *
 * Never the closest in either direction. A tick from after the instant being
 * valued is lookahead: it would value yesterday's balance with today's price
 * and make a historical chart move when nothing happened.
 */
function priceAt(
  ticks: readonly PriceTick[],
  at: Date,
  walks: Map<string, { index: number; last: PriceTick | undefined }>,
  asset: string,
): bigint | null {
  const walk = walks.get(asset) ?? { index: 0, last: undefined };

  while (walk.index < ticks.length) {
    const tick = ticks[walk.index];
    if (tick === undefined || tick.at.getTime() > at.getTime()) break;
    walk.last = tick;
    walk.index += 1;
  }

  walks.set(asset, walk);
  return walk.last === undefined ? null : parseUsd(walk.last.priceUsd);
}

export interface AssetAllocation {
  readonly asset: string;
  readonly amount: bigint;
  readonly valueUsd: bigint | null;
  /** Share of the priced total, in basis points. */
  readonly shareBps: number;
  /** Micro-dollars of change over the comparison window, when known. */
  readonly changeUsd: bigint | null;
}

export interface PortfolioSummary {
  readonly totalUsd: bigint;
  /** Change against the comparison point, in micro-dollars. */
  readonly changeUsd: bigint | null;
  /** The same change relative to the earlier total, in basis points. */
  readonly changeBps: number | null;
  readonly allocations: readonly AssetAllocation[];
  readonly complete: boolean;
}

/**
 * The headline numbers.
 *
 * `previous` is whatever the caller decided to compare against — 24 hours ago
 * for the dashboard. When it is absent, or when its total is zero, the
 * PERCENTAGE is null while the absolute change may still be real: a portfolio
 * that went from nothing to something has not risen by any percentage, and
 * rendering `∞%` or `0%` would both be lies.
 */
export function summarise(
  current: PortfolioPoint,
  previous: PortfolioPoint | undefined,
): PortfolioSummary {
  const before = new Map(
    (previous?.holdings ?? []).map((holding) => [holding.asset, holding.valueUsd]),
  );

  const allocations = current.holdings.map((holding) => {
    const earlier = before.get(holding.asset) ?? null;
    return {
      asset: holding.asset,
      amount: holding.amount,
      valueUsd: holding.valueUsd,
      shareBps: holding.valueUsd === null ? 0 : shareBps(holding.valueUsd, current.totalUsd),
      changeUsd: holding.valueUsd === null || earlier === null ? null : holding.valueUsd - earlier,
    };
  });

  const changeUsd = previous === undefined ? null : current.totalUsd - previous.totalUsd;
  const changeBps =
    previous === undefined || previous.totalUsd === 0n || changeUsd === null
      ? null
      : Number((changeUsd * 10_000n) / previous.totalUsd);

  return {
    totalUsd: current.totalUsd,
    changeUsd,
    changeBps,
    allocations,
    complete: current.complete && (previous?.complete ?? true),
  };
}
