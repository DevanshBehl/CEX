'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { formatScaledPrice, type CandleInterval } from '@wallet/types';
import { EmptyState, ErrorNotice, Skeleton } from '@/components/ui';
import { useBalances } from '@/features/custody/use-balances';
import { useNetwork } from '@/features/network/network-context';
import { useCapabilities } from '@/features/platform/use-capabilities';
import { topOfBook } from '@/features/trading/book-state';
import { formatBase, formatChange, formatPrice } from '@/features/trading/format';
import { DeploymentNotices } from '@/features/trading/notices';
import { DepthChart, OrderBook } from '@/features/trading/order-book';
import { OrderForm } from '@/features/trading/order-form';
import { OrdersPanel } from '@/features/trading/orders-panel';
import { PriceChart } from '@/features/trading/price-chart';
import { SocketProvider, useSocket } from '@/features/trading/socket-context';
import { TradeTape } from '@/features/trading/trade-tape';
import { TransferPanel } from '@/features/trading/transfer-panel';
import { useAccount } from '@/features/trading/use-account';
import {
  useBook,
  useCandles,
  useMarkets,
  useTicker,
  useTrades,
} from '@/features/trading/use-market-data';

/**
 * The trading screen for one market (prompt_phase_s5.md §11).
 *
 * Composition only. The book is a reducer, the socket is a module, every
 * number is formatted from an integer the server sent, and each panel says
 * whether it is current. This file decides where things go.
 */
export default function MarketPage() {
  const capabilities = useCapabilities();
  // No socket where there is no market data to put on it.
  return (
    <SocketProvider enabled={capabilities?.trading.marketData === true}>
      <Screen />
    </SocketProvider>
  );
}

function Screen() {
  const params = useParams<{ market: string }>();
  const symbol = decodeURIComponent(params.market);
  const capabilities = useCapabilities();
  const { cluster } = useNetwork();
  const { state: socket } = useSocket();
  const { markets, error, unavailable } = useMarkets();
  const market = markets?.find((candidate) => candidate.symbol === symbol);

  const book = useBook(market?.symbol);
  const trades = useTrades(market?.symbol);
  const ticker = useTicker(market);
  const account = useAccount(market?.symbol);
  const wallet = useBalances();
  const [interval, setInterval] = useState<CandleInterval>('1m');
  const candles = useCandles(market?.symbol, interval, trades[0]?.id ?? '');
  const [price, setPrice] = useState('');

  const refreshAccount = account.refresh;
  const refreshWallet = wallet.refresh;
  const onTransferSettled = useCallback(() => {
    void refreshAccount();
    void refreshWallet();
  }, [refreshAccount, refreshWallet]);

  if (unavailable || capabilities?.trading.enabled === false) {
    return (
      <EmptyState
        title="Trading is not available here"
        body="There is no such market on this network. Switch network, or go back to the market list."
      />
    );
  }
  if (error) return <ErrorNotice message={error} />;
  if (markets === null || !cluster) return <Skeleton className="h-96 w-full" />;
  if (!market) {
    return <EmptyState title="No such market" body={`${symbol} is not traded on this network.`} />;
  }

  const top = topOfBook(book);
  const last = ticker?.lastPrice ? BigInt(ticker.lastPrice) : null;
  // What the engine centres its collar on: the last trade, else the mid.
  const reference = last ?? top.mid;
  const change = formatChange(ticker?.open24h ? BigInt(ticker.open24h) : null, last);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/trade" className="text-xs text-ink-muted hover:text-ink">
            ← Markets
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-ink">
            {market.baseSymbol}
            <span className="text-ink-muted"> / {market.quoteSymbol}</span>
          </h1>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div>
            <dt className="text-ink-muted">Last</dt>
            <dd className="font-mono text-base text-ink" data-testid="last-price">
              {last === null ? 'No trades yet' : formatPrice(last, market)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">24h change</dt>
            <dd className="font-mono text-ink">{change ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">24h high / low</dt>
            <dd className="font-mono text-ink">
              {ticker?.high24h && ticker.low24h
                ? `${formatPrice(ticker.high24h, market)} / ${formatPrice(ticker.low24h, market)}`
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">24h volume</dt>
            <dd className="font-mono text-ink">
              {formatBase(ticker?.baseVolume24h ?? '0', market, 2)} {market.baseSymbol}
            </dd>
          </div>
        </dl>
      </header>

      <DeploymentNotices capabilities={capabilities} market={market} socket={socket} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px_300px]">
        <div className="min-w-0 space-y-4">
          <PriceChart
            candles={candles.candles}
            interval={interval}
            onInterval={setInterval}
            market={market}
            loading={candles.loading}
          />
          <section className="atlas-raised overflow-hidden rounded-lg" aria-label="Depth">
            <header className="border-b border-line px-3 py-2">
              <h2 className="text-sm font-semibold text-ink">Depth</h2>
            </header>
            <div className={socket === 'open' && book.status === 'live' ? '' : 'opacity-50'}>
              <DepthChart book={book} market={market} />
            </div>
          </section>
          <OrdersPanel
            market={market}
            orders={account.orders}
            fills={account.fills}
            loading={account.loading}
            error={account.error}
            hasMoreOrders={account.ordersCursor !== null}
            hasMoreFills={account.fillsCursor !== null}
            onMoreOrders={() => void account.loadMoreOrders()}
            onMoreFills={() => void account.loadMoreFills()}
            onChanged={() => void account.refresh()}
          />
        </div>

        <div className="space-y-4">
          <OrderBook
            book={book}
            socket={socket}
            market={market}
            onPickPrice={(picked) => setPrice(formatScaledPrice(picked, market))}
          />
          <TradeTape trades={trades} socket={socket} market={market} />
        </div>

        <div className="space-y-4">
          <OrderForm
            cluster={cluster}
            market={market}
            reference={reference}
            balances={account.balances}
            price={price}
            onPrice={setPrice}
            onPlaced={() => void account.refresh()}
          />
          <TransferPanel
            market={market}
            wallet={wallet.data ?? []}
            trading={account.balances}
            onSettled={onTransferSettled}
          />
        </div>
      </div>
    </div>
  );
}
