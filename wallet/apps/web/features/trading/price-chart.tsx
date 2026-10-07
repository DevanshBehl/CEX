'use client';

import { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CANDLE_INTERVALS,
  CANDLE_INTERVAL_SECONDS,
  formatDecimal,
  priceDecimals,
  type CandleInterval,
  type CandleView,
  type MarketView,
} from '@wallet/types';
import { formatBase, formatPrice } from './format';

/**
 * Price and volume over time (prompt_phase_s5.md rules 93, 156).
 *
 * Deliberately modest: a close line, a volume bar, an interval switch. The
 * chart is the easiest place on this screen to spend unbounded time.
 *
 * Two things it is careful about:
 *
 *   - A bucket with no trades has no candle. The line carries the previous
 *     close across the gap and the tooltip says nothing traded — it does not
 *     draw a candle the server did not send.
 *   - `recharts` positions points with numbers, so each price and volume is
 *     converted for PLACEMENT only. Every value a person reads is formatted
 *     from the integer the server sent.
 */

interface Point {
  readonly at: number;
  /** For placing the point. Never displayed. */
  readonly close: number;
  readonly volume: number;
  readonly candle: CandleView | null;
  /** The close carried forward across a bucket with no trades. */
  readonly carried: string;
}

function points(
  candles: readonly CandleView[],
  interval: CandleInterval,
  market: MarketView,
): Point[] {
  const step = CANDLE_INTERVAL_SECONDS[interval] * 1_000;
  const decimals = priceDecimals(market);
  const place = (price: string) => Number(formatDecimal(BigInt(price), decimals));
  const out: Point[] = [];
  let previous: CandleView | null = null;
  for (const candle of candles) {
    const at = new Date(candle.time).getTime();
    if (previous) {
      // Fill the buckets between two candles with the earlier close and no
      // volume — bounded, so a long-dormant market does not draw forever.
      const from = new Date(previous.time).getTime() + step;
      for (let gap = from, n = 0; gap < at && n < 500; gap += step, n += 1) {
        out.push({
          at: gap,
          close: place(previous.close),
          volume: 0,
          candle: null,
          carried: previous.close,
        });
      }
    }
    out.push({
      at,
      close: place(candle.close),
      volume: Number(formatDecimal(BigInt(candle.baseVolume), market.baseDecimals)),
      candle,
      carried: candle.close,
    });
    previous = candle;
  }
  return out;
}

function Detail({ point, market }: { point: Point; market: MarketView }) {
  const when = new Date(point.at).toLocaleString([], { hour12: false });
  if (!point.candle) {
    return (
      <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs">
        <p className="text-ink-muted">{when}</p>
        <p className="mt-1 text-ink-secondary">No trades in this interval.</p>
        <p className="font-mono text-ink-muted">Last {formatPrice(point.carried, market)}</p>
      </div>
    );
  }
  const c = point.candle;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs">
      <p className="font-sans text-ink-muted">{when}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-ink">
        <dt className="text-ink-muted">Open</dt>
        <dd className="text-right">{formatPrice(c.open, market)}</dd>
        <dt className="text-ink-muted">High</dt>
        <dd className="text-right">{formatPrice(c.high, market)}</dd>
        <dt className="text-ink-muted">Low</dt>
        <dd className="text-right">{formatPrice(c.low, market)}</dd>
        <dt className="text-ink-muted">Close</dt>
        <dd className="text-right">{formatPrice(c.close, market)}</dd>
        <dt className="text-ink-muted">Volume</dt>
        <dd className="text-right">
          {formatBase(c.baseVolume, market, 3)} {market.baseSymbol}
        </dd>
        <dt className="text-ink-muted">Trades</dt>
        <dd className="text-right">{String(c.trades)}</dd>
      </dl>
    </div>
  );
}

export function PriceChart({
  candles,
  interval,
  onInterval,
  market,
  loading,
}: {
  candles: readonly CandleView[];
  interval: CandleInterval;
  onInterval: (interval: CandleInterval) => void;
  market: MarketView;
  loading: boolean;
}) {
  const data = useMemo(() => points(candles, interval, market), [candles, interval, market]);

  return (
    <section className="atlas-raised overflow-hidden rounded-lg" aria-label="Price chart">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold text-ink">Price</h2>
        <div className="flex gap-1" role="group" aria-label="Interval">
          {CANDLE_INTERVALS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === interval}
              onClick={() => onInterval(option)}
              className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold ${
                option === interval ? 'bg-surface-active text-ink' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      <div className="h-64 p-2">
        {data.length === 0 ? (
          <p className="flex h-full items-center justify-center text-xs text-ink-muted">
            {loading ? 'Loading…' : 'No trades in this market yet.'}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--atlas-border)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="at"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tick={{ fontSize: 10, fill: 'var(--atlas-text-muted)' }}
                tickFormatter={(at: number) =>
                  new Date(at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })
                }
                stroke="var(--atlas-border)"
              />
              <YAxis yAxisId="price" domain={['auto', 'auto']} hide />
              <YAxis
                yAxisId="volume"
                orientation="right"
                domain={[0, (max: number) => max * 4]}
                hide
              />
              <Tooltip
                isAnimationActive={false}
                content={({ active, payload }) => {
                  const point = (payload?.[0]?.payload ?? null) as Point | null;
                  return active && point ? <Detail point={point} market={market} /> : null;
                }}
              />
              <Bar
                yAxisId="volume"
                dataKey="volume"
                fill="var(--atlas-border-strong)"
                isAnimationActive={false}
              />
              <Line
                yAxisId="price"
                type="stepAfter"
                dataKey="close"
                stroke="var(--atlas-accent)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
