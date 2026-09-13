'use client';

import { useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PortfolioRangeName } from '@/lib/api';
import { usePortfolioHistory } from './use-portfolio';
import { formatAxisTime, formatPointTime, formatUsd } from './format';

/**
 * The portfolio chart (Task 4).
 *
 * # What it will not do
 *
 * It does not interpolate across a gap, and it does not hide a point it could
 * not price. A period with no price data is drawn as a break in the line and
 * said in words underneath, because a smooth curve through a gap is a claim
 * about what someone's money was worth at a time nobody knows.
 */

const RANGES: ReadonlyArray<{ value: PortfolioRangeName; label: string }> = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '1M' },
  { value: 'all', label: 'ALL' },
];

interface ChartPoint {
  readonly at: string;
  /** `null` breaks the line rather than drawing through a gap. */
  readonly value: number | null;
  readonly complete: boolean;
}

export function PortfolioChart() {
  const [range, setRange] = useState<PortfolioRangeName>('24h');
  const { data, loading, error } = usePortfolioHistory(range);

  const points: ChartPoint[] = (data?.points ?? []).map((point) => ({
    at: point.at,
    // A `number` for the axis only. Every figure a person READS comes from the
    // string the server sent.
    value: point.complete ? Number(point.totalUsd) : null,
    complete: point.complete,
  }));

  const incomplete = points.some((point) => !point.complete);
  const hasAny = points.some((point) => point.value !== null && point.value > 0);

  return (
    <section className="atlas-raised rounded-lg px-[18px] py-4" data-testid="portfolio-chart">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Portfolio value</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Priced from recorded spot rates, not live quotes.
          </p>
        </div>

        <div
          role="group"
          aria-label="Time range"
          className="flex items-center gap-0.5 rounded-[5px] bg-surface-active p-0.5"
        >
          {RANGES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setRange(option.value)}
              aria-pressed={range === option.value}
              data-testid={`range-${option.value}`}
              className={[
                'rounded-sm px-2.5 py-[3px] text-[11px]',
                'transition-colors duration-micro ease-atlas',
                range === option.value
                  ? 'bg-surface font-semibold text-ink shadow-sm'
                  : 'font-medium text-ink-muted hover:text-ink-secondary',
              ].join(' ')}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <div className={`mt-5 h-56 ${loading ? 'opacity-50' : ''} transition-opacity`}>
        {error !== null ? (
          <p className="flex h-full items-center justify-center text-sm text-ink-muted">{error}</p>
        ) : !hasAny ? (
          <p className="flex h-full items-center justify-center text-center text-sm text-ink-muted">
            {/*
              An empty chart is not an error. A new account genuinely has no
              history, and drawing a flat line at zero would imply we have been
              watching it fall.
            */}
            Nothing to chart yet. A value appears once you hold something and a price has been
            recorded.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="atlas-portfolio" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="rgb(var(--atlas-accent-strong))"
                    stopOpacity={0.18}
                  />
                  <stop offset="100%" stopColor="rgb(var(--atlas-accent-strong))" stopOpacity={0} />
                </linearGradient>
              </defs>

              <CartesianGrid
                stroke="rgb(var(--atlas-border))"
                strokeDasharray="2 6"
                vertical={false}
              />

              <XAxis
                dataKey="at"
                tickFormatter={(value: string) => formatAxisTime(value, range)}
                tick={{ fill: 'rgb(var(--atlas-text-muted))', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={32}
              />
              <YAxis
                width={64}
                tick={{ fill: 'rgb(var(--atlas-text-muted))', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value: number) => formatUsd(value.toFixed(6))}
              />

              <Tooltip
                cursor={{ stroke: 'rgb(var(--atlas-border-emphasis))' }}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as ChartPoint | undefined;
                  if (active !== true || point === undefined) return null;
                  return (
                    <div
                      className="atlas-raised rounded-md px-3 py-2 shadow-md"
                      data-testid="chart-tooltip"
                    >
                      <p className="font-mono text-2xs text-ink-muted">
                        {formatPointTime(point.at)}
                      </p>
                      <p className="mt-1 font-mono text-sm text-ink">
                        {point.value === null
                          ? 'No price recorded'
                          : formatUsd(point.value.toFixed(6))}
                      </p>
                    </div>
                  );
                }}
              />

              <Area
                type="monotone"
                dataKey="value"
                stroke="rgb(var(--atlas-accent-strong))"
                strokeWidth={1.75}
                fill="url(#atlas-portfolio)"
                // A gap stays a gap. `connectNulls` would draw a straight line
                // through a period nobody has a price for.
                connectNulls={false}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {incomplete && hasAny && (
        <p className="mt-3 text-2xs text-ink-muted" data-testid="chart-incomplete">
          Some points are missing a price and are drawn as gaps rather than as zero.
        </p>
      )}

      {data?.truncated === true && (
        <p className="mt-1 text-2xs text-warning">
          Your history is longer than one valuation can read; older activity is not included.
        </p>
      )}
    </section>
  );
}
