import { describe, expect, it } from 'vitest';
import {
  bucketsFor,
  formatUsd,
  isPortfolioRange,
  parseUsd,
  projectSeries,
  shareBps,
  summarise,
  valueOf,
  type PortfolioPoint,
  type PriceTick,
  type TimedEntry,
} from './index.js';

const SOL = 'devnet:SOL';
const USDC = 'devnet:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const DECIMALS: Record<string, number> = { [SOL]: 9, [USDC]: 6 };
const decimalsOf = (asset: string): number => DECIMALS[asset] ?? 0;

const at = (iso: string): Date => new Date(iso);

function credit(asset: string, amount: bigint, iso: string): TimedEntry {
  return { asset, amount, direction: 'credit', at: at(iso) };
}
function debit(asset: string, amount: bigint, iso: string): TimedEntry {
  return { asset, amount, direction: 'debit', at: at(iso) };
}
function tick(asset: string, priceUsd: string, iso: string): PriceTick {
  return { asset, priceUsd, at: at(iso) };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe('USD arithmetic stays in integers', () => {
  it('parses a decimal price exactly', () => {
    expect(parseUsd('1')).toBe(1_000_000n);
    expect(parseUsd('0.052')).toBe(52_000n);
    expect(parseUsd('142.87')).toBe(142_870_000n);
    expect(parseUsd('0.000001')).toBe(1n);
  });

  it('does not go through a float', () => {
    // 0.1 + 0.2 is the canonical example; these are the prices that would
    // actually appear. `Number('1.005') * 1e6` is 1004999.9999999999.
    expect(parseUsd('1.005')).toBe(1_005_000n);
    expect(parseUsd('0.07')).toBe(70_000n);
    // Eighteen significant figures, which a feed is free to return.
    expect(parseUsd('123456789.123456789')).toBe(123_456_789_123_456n);
  });

  it('truncates beyond six places, matching NUMERIC(18,6)', () => {
    // Not rounding: the column would truncate, and two different answers for
    // one input is worse than a slightly lossy one.
    expect(parseUsd('1.9999999')).toBe(1_999_999n);
  });

  it('round-trips through the wire format', () => {
    for (const value of ['0.000000', '1.000000', '142.870000', '0.052000']) {
      expect(formatUsd(parseUsd(value))).toBe(value);
    }
  });

  it('refuses something that is not a price', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e6', '$4']) {
      expect(() => parseUsd(bad)).toThrow(TypeError);
    }
  });

  it('values a holding by scaling base units', () => {
    // 2.5 SOL at $142.87 = $357.175
    expect(valueOf(2_500_000_000n, parseUsd('142.87'), 9)).toBe(parseUsd('357.175'));
    // 1000 USDC at $1.00 = $1000
    expect(valueOf(1_000_000_000n, parseUsd('1'), 6)).toBe(parseUsd('1000'));
  });

  it('handles an amount far above 2^53 without losing a lamport', () => {
    const huge = 9_007_199_254_740_993_000_000n; // > 2^53 lamports
    expect(valueOf(huge, parseUsd('1'), 9)).toBe(9_007_199_254_740n * 1_000_000n + 993_000n);
  });

  it('never overstates a holding when it truncates', () => {
    // One lamport at $142.87 is a fraction of a micro-dollar. It rounds to
    // zero — downward, which is the direction that does not claim someone has
    // money they do not.
    expect(valueOf(1n, parseUsd('142.87'), 9)).toBe(0n);
  });

  it('computes a share in basis points', () => {
    expect(shareBps(1n, 4n)).toBe(2_500);
    expect(shareBps(0n, 0n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('projecting a balance series', () => {
  const prices = new Map<string, PriceTick[]>([
    [
      SOL,
      [
        tick(SOL, '100', '2026-09-10T00:00:00Z'),
        tick(SOL, '150', '2026-09-11T00:00:00Z'),
        tick(SOL, '200', '2026-09-12T00:00:00Z'),
      ],
    ],
  ]);

  it('accumulates entries up to each bucket', () => {
    const points = projectSeries({
      entries: [
        credit(SOL, 1_000_000_000n, '2026-09-10T06:00:00Z'),
        credit(SOL, 1_000_000_000n, '2026-09-11T06:00:00Z'),
      ],
      buckets: [at('2026-09-10T00:00:00Z'), at('2026-09-11T00:00:00Z'), at('2026-09-12T00:00:00Z')],
      prices,
      decimalsOf,
    });

    expect(points.map((p) => p.holdings[0]?.amount ?? 0n)).toEqual([
      0n,
      1_000_000_000n,
      2_000_000_000n,
    ]);
  });

  it('treats a credit as an increase and a debit as a decrease', () => {
    // A user account is a liability: the same negation the balance endpoint
    // uses. Two projections of one number that disagree is worse than one
    // that is wrong.
    const points = projectSeries({
      entries: [
        credit(SOL, 5_000_000_000n, '2026-09-10T01:00:00Z'),
        debit(SOL, 2_000_000_000n, '2026-09-10T02:00:00Z'),
      ],
      buckets: [at('2026-09-10T03:00:00Z')],
      prices,
      decimalsOf,
    });

    expect(points[0]?.holdings[0]?.amount).toBe(3_000_000_000n);
  });

  it('values each point with the price as it was THEN, not now', () => {
    /*
     * The property that makes a historical chart honest. Valuing yesterday's
     * balance with today's price makes the line move when nothing happened,
     * and the user reads it as a gain they never had.
     */
    const points = projectSeries({
      entries: [credit(SOL, 1_000_000_000n, '2026-09-09T00:00:00Z')],
      buckets: [at('2026-09-10T12:00:00Z'), at('2026-09-11T12:00:00Z'), at('2026-09-12T12:00:00Z')],
      prices,
      decimalsOf,
    });

    expect(points.map((p) => p.totalUsd)).toEqual([
      parseUsd('100'),
      parseUsd('150'),
      parseUsd('200'),
    ]);
  });

  it('never uses a price from the future', () => {
    // The bucket is before every tick. There is no price yet, and inventing
    // one from the next observation is lookahead.
    const points = projectSeries({
      entries: [credit(SOL, 1_000_000_000n, '2026-09-01T00:00:00Z')],
      buckets: [at('2026-09-05T00:00:00Z')],
      prices,
      decimalsOf,
    });

    expect(points[0]?.holdings[0]?.valueUsd).toBeNull();
    expect(points[0]?.totalUsd).toBe(0n);
    expect(points[0]?.complete).toBe(false);
  });

  it('CARRIES THE LAST PRICE FORWARD past the final tick', () => {
    /*
     * REGRESSION.
     *
     * The walk through an asset's ticks is monotonic, so once they are
     * exhausted no bucket finds a NEW one. An implementation that reported
     * only newly-seen ticks returned null for every bucket after the last
     * observation — and since prices are recorded every few minutes while a
     * chart's last point is `now`, that was the right-hand edge: the line fell
     * to zero exactly where someone is looking.
     *
     * The most recent price remains the most recent price until a newer one
     * arrives.
     */
    const points = projectSeries({
      entries: [credit(SOL, 1_000_000_000n, '2026-09-09T00:00:00Z')],
      buckets: [
        at('2026-09-12T01:00:00Z'),
        at('2026-09-12T02:00:00Z'),
        at('2026-09-12T03:00:00Z'),
        at('2026-09-12T04:00:00Z'),
      ],
      prices,
      decimalsOf,
    });

    // Every bucket is after the last tick (2026-09-12T00:00:00Z, $200).
    expect(points.map((p) => p.totalUsd)).toEqual([
      parseUsd('200'),
      parseUsd('200'),
      parseUsd('200'),
      parseUsd('200'),
    ]);
    expect(points.every((p) => p.complete)).toBe(true);
  });

  it('marks a point incomplete rather than silently dropping an unpriced asset', () => {
    /*
     * A chart that quietly omits an asset it cannot price shows a FALL in
     * someone's net worth that did not happen — and they will believe it.
     * The point still renders; it says it is partial.
     */
    const points = projectSeries({
      entries: [
        credit(SOL, 1_000_000_000n, '2026-09-11T00:00:00Z'),
        credit(USDC, 500_000_000n, '2026-09-11T00:00:00Z'),
      ],
      buckets: [at('2026-09-12T00:00:00Z')],
      prices,
      decimalsOf,
    });

    expect(points[0]?.complete).toBe(false);
    expect(points[0]?.totalUsd).toBe(parseUsd('200'));
    expect(points[0]?.holdings.find((h) => h.asset === USDC)?.valueUsd).toBeNull();
  });

  it('does NOT call a zero holding incomplete when it has no price', () => {
    // A de-allowlisted asset the user no longer holds is worth nothing
    // whatever its price was. Flagging it would make every point partial
    // forever.
    const points = projectSeries({
      entries: [
        credit(USDC, 100n, '2026-09-10T00:00:00Z'),
        debit(USDC, 100n, '2026-09-10T01:00:00Z'),
        credit(SOL, 1_000_000_000n, '2026-09-10T02:00:00Z'),
      ],
      buckets: [at('2026-09-12T00:00:00Z')],
      prices,
      decimalsOf,
    });

    expect(points[0]?.complete).toBe(true);
  });

  it('includes entries from before the window, or the chart invents a deposit', () => {
    /*
     * A balance at time T is the sum of EVERYTHING before T. A window that
     * started from zero would draw a vertical rise at its left edge that never
     * happened.
     */
    const points = projectSeries({
      entries: [credit(SOL, 3_000_000_000n, '2026-01-01T00:00:00Z')],
      buckets: [at('2026-09-11T00:00:00Z'), at('2026-09-12T00:00:00Z')],
      prices,
      decimalsOf,
    });

    expect(points[0]?.holdings[0]?.amount).toBe(3_000_000_000n);
  });

  it('is deterministic in asset order', () => {
    const points = projectSeries({
      entries: [credit(USDC, 1n, '2026-09-10T00:00:00Z'), credit(SOL, 1n, '2026-09-10T00:00:00Z')],
      buckets: [at('2026-09-12T00:00:00Z')],
      prices,
      decimalsOf,
    });
    expect(points[0]?.holdings.map((h) => h.asset)).toEqual([USDC, SOL].sort());
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('the summary', () => {
  const point = (
    total: string,
    holdings: Array<[string, bigint, string | null]>,
  ): PortfolioPoint => ({
    at: at('2026-09-12T00:00:00Z'),
    totalUsd: parseUsd(total),
    holdings: holdings.map(([asset, amount, value]) => ({
      asset,
      amount,
      valueUsd: value === null ? null : parseUsd(value),
    })),
    complete: holdings.every(([, , value]) => value !== null),
  });

  it('reports an absolute and a relative change', () => {
    const summary = summarise(
      point('150', [[SOL, 1_000_000_000n, '150']]),
      point('100', [[SOL, 1_000_000_000n, '100']]),
    );

    expect(summary.changeUsd).toBe(parseUsd('50'));
    expect(summary.changeBps).toBe(5_000); // +50%
  });

  it('reports a fall as a negative change', () => {
    const summary = summarise(
      point('80', [[SOL, 1_000_000_000n, '80']]),
      point('100', [[SOL, 1_000_000_000n, '100']]),
    );
    expect(summary.changeUsd).toBe(-parseUsd('20'));
    expect(summary.changeBps).toBe(-2_000);
  });

  it('gives NO percentage when there was nothing to grow from', () => {
    /*
     * A portfolio that went from nothing to something has not risen by any
     * percentage. `∞%` and `0%` are both lies; null lets the interface say
     * "new" instead.
     */
    const summary = summarise(point('100', [[SOL, 1n, '100']]), point('0', []));
    expect(summary.changeUsd).toBe(parseUsd('100'));
    expect(summary.changeBps).toBeNull();
  });

  it('gives no change at all when there is nothing to compare against', () => {
    const summary = summarise(point('100', [[SOL, 1n, '100']]), undefined);
    expect(summary.changeUsd).toBeNull();
    expect(summary.changeBps).toBeNull();
  });

  it('allocates by share of the priced total', () => {
    const summary = summarise(
      point('200', [
        [SOL, 1n, '150'],
        [USDC, 1n, '50'],
      ]),
      undefined,
    );

    expect(summary.allocations.map((a) => a.shareBps)).toEqual([7_500, 2_500]);
  });

  it('carries a per-asset change, and none where a price was missing', () => {
    const summary = summarise(
      point('150', [
        [SOL, 1n, '150'],
        [USDC, 1n, null],
      ]),
      point('100', [
        [SOL, 1n, '100'],
        [USDC, 1n, null],
      ]),
    );

    expect(summary.allocations[0]?.changeUsd).toBe(parseUsd('50'));
    expect(summary.allocations[1]?.changeUsd).toBeNull();
    expect(summary.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

describe('time ranges', () => {
  const now = at('2026-09-12T12:00:00Z');

  it('accepts only the ranges it offers', () => {
    expect(isPortfolioRange('24h')).toBe(true);
    expect(isPortfolioRange('1y')).toBe(false);
    expect(isPortfolioRange('')).toBe(false);
  });

  it('ends exactly at now, so a fresh deposit is visible', () => {
    for (const range of ['24h', '7d', '30d', 'all'] as const) {
      const buckets = bucketsFor(range, now, at('2026-01-01T00:00:00Z'));
      expect(buckets.at(-1)?.getTime()).toBe(now.getTime());
    }
  });

  it('is ascending and covers the window', () => {
    const buckets = bucketsFor('24h', now, null);
    expect(buckets).toHaveLength(24);
    expect(buckets[0]?.toISOString()).toBe('2026-09-11T12:00:00.000Z');
    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i]!.getTime()).toBeGreaterThan(buckets[i - 1]!.getTime());
    }
  });

  it('starts `all` at the first entry rather than at an arbitrary epoch', () => {
    const buckets = bucketsFor('all', now, at('2026-09-01T00:00:00Z'));
    expect(buckets[0]?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('degrades to a single point when the window has no span', () => {
    // A brand-new account: `since` is now. One point beats dividing by zero.
    expect(bucketsFor('all', now, now)).toEqual([now]);
  });
});
