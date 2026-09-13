/**
 * The time windows a chart offers, and the points inside them.
 *
 * # Why the resolutions differ per range
 *
 * A fixed point count would make 24h coarse and 30d needlessly heavy. These
 * are chosen so each range has enough points to show a shape and few enough
 * that the query stays one round trip: the cost of a point is a price lookup,
 * not a query.
 */

export const PORTFOLIO_RANGES = ['24h', '7d', '30d', 'all'] as const;
export type PortfolioRange = (typeof PORTFOLIO_RANGES)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface RangeShape {
  /** How far back the window reaches. `null` means "since the first entry". */
  readonly spanMs: number | null;
  readonly points: number;
}

const SHAPES: Readonly<Record<PortfolioRange, RangeShape>> = {
  '24h': { spanMs: DAY, points: 24 },
  '7d': { spanMs: 7 * DAY, points: 28 },
  '30d': { spanMs: 30 * DAY, points: 30 },
  all: { spanMs: null, points: 40 },
};

export function isPortfolioRange(value: string): value is PortfolioRange {
  return (PORTFOLIO_RANGES as readonly string[]).includes(value);
}

/** How far back a range reaches from `now`, for the price query. */
export function windowStart(range: PortfolioRange, now: Date, since: Date | null): Date {
  const shape = SHAPES[range];
  if (shape.spanMs === null) {
    // `all` starts at the first entry. With no entries there is nothing to
    // chart, and a day of flat zero is a more honest empty state than a single
    // point.
    return since ?? new Date(now.getTime() - DAY);
  }
  return new Date(now.getTime() - shape.spanMs);
}

/**
 * The instants to value, ascending, ending exactly at `now`.
 *
 * The last point is `now` rather than the last whole interval: a user who has
 * just deposited expects to see it, and a chart whose right edge is up to an
 * hour stale looks broken in precisely that moment.
 */
export function bucketsFor(range: PortfolioRange, now: Date, since: Date | null): Date[] {
  const start = windowStart(range, now, since);
  const { points } = SHAPES[range];

  const span = now.getTime() - start.getTime();
  if (span <= 0) return [now];

  const step = span / (points - 1);
  const buckets: Date[] = [];
  for (let index = 0; index < points - 1; index += 1) {
    buckets.push(new Date(Math.round(start.getTime() + step * index)));
  }
  buckets.push(now);
  return buckets;
}
