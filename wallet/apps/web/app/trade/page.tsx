'use client';

import Link from 'next/link';
import { EmptyState, ErrorNotice, PageHeader, Skeleton, StatusBadge } from '@/components/ui';
import { useCapabilities } from '@/features/platform/use-capabilities';
import { formatBase, formatChange, formatPrice } from '@/features/trading/format';
import { useMarkets } from '@/features/trading/use-market-data';

/**
 * The markets this deployment trades, on the network selected.
 *
 * What is shown is what the server said: a market with no trades has no last
 * price, and says so — it is not shown at zero.
 */
export default function MarketsPage() {
  const capabilities = useCapabilities();
  const { markets, error, unavailable, cluster } = useMarkets();

  return (
    <div className="space-y-6">
      <PageHeader title="Trade" description="Spot markets on this deployment." />

      {capabilities?.trading.enabled === false || unavailable ? (
        <EmptyState
          title="Trading is not available here"
          body={
            unavailable
              ? `There are no markets on ${cluster ?? 'this network'}. Switch network to see where trading runs.`
              : 'This deployment is a wallet only: it has no markets configured.'
          }
        />
      ) : error ? (
        <ErrorNotice message={error} />
      ) : markets === null ? (
        <Skeleton className="h-24 w-full" />
      ) : markets.length === 0 ? (
        <EmptyState title="No markets" body="No market is configured on this network." />
      ) : (
        <ul className="atlas-raised divide-y divide-line overflow-hidden rounded-lg">
          {markets.map((market) => {
            const ticker = market.ticker;
            const change = formatChange(
              ticker?.open24h ? BigInt(ticker.open24h) : null,
              ticker?.lastPrice ? BigInt(ticker.lastPrice) : null,
            );
            return (
              <li key={market.symbol}>
                <Link
                  href={`/trade/${market.symbol}`}
                  className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-3 hover:bg-surface-hover"
                >
                  <span className="text-sm font-semibold text-ink">
                    {market.baseSymbol}
                    <span className="text-ink-muted"> / {market.quoteSymbol}</span>
                  </span>
                  <span className="font-mono text-sm text-ink">
                    {ticker?.lastPrice ? formatPrice(ticker.lastPrice, market) : 'No trades yet'}
                  </span>
                  <span className="font-mono text-xs text-ink-muted">
                    {change ?? '—'}
                    {ticker && (
                      <span className="ml-3">
                        24h {formatBase(ticker.baseVolume24h, market, 2)} {market.baseSymbol}
                      </span>
                    )}
                  </span>
                  <StatusBadge tone={market.status === 'open' ? 'good' : 'warn'}>
                    {market.status.replace('_', ' ')}
                  </StatusBadge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
