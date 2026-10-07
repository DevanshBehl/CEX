'use client';

import type { MarketView } from '@wallet/types';
import type { SocketState } from '@/lib/ws';
import { bookRows, topOfBook, type BookRow, type BookState } from './book-state';
import { formatBase, formatPrice } from './format';
import { LiveBadge } from './notices';

const DEPTH = 14;

/**
 * The order book, with cumulative depth.
 *
 * The bar behind each row is its cumulative quantity as a share of the deepest
 * row shown. That share is computed in integers and becomes a `number` only as
 * a CSS percentage — to place pixels, never to show or compute a value.
 */
function Side({
  rows,
  side,
  deepest,
  market,
  onPick,
}: {
  rows: readonly BookRow[];
  side: 'buy' | 'sell';
  deepest: bigint;
  market: MarketView;
  onPick: (price: bigint) => void;
}) {
  return (
    <ul className="font-mono text-xs">
      {rows.map((row) => {
        const share = deepest === 0n ? 0 : Number((row.cumulative * 1000n) / deepest) / 10;
        return (
          <li key={row.price.toString()} className="relative">
            <span
              aria-hidden="true"
              className={`absolute inset-y-0 right-0 ${side === 'buy' ? 'bg-success-dim' : 'bg-danger-dim'}`}
              style={{ width: `${String(share)}%` }}
            />
            <button
              type="button"
              onClick={() => onPick(row.price)}
              title="Use this price"
              className="relative grid w-full grid-cols-3 gap-2 px-3 py-[3px] text-right hover:bg-surface-hover"
            >
              <span className={`text-left ${side === 'buy' ? 'text-success' : 'text-danger'}`}>
                {formatPrice(row.price, market)}
              </span>
              <span className="text-ink">{formatBase(row.qty, market, 3)}</span>
              <span className="text-ink-muted">{formatBase(row.cumulative, market, 3)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function OrderBook({
  book,
  socket,
  market,
  onPickPrice,
}: {
  book: BookState;
  socket: SocketState;
  market: MarketView;
  onPickPrice: (price: bigint) => void;
}) {
  const bids = bookRows(book.bids, 'buy', DEPTH);
  // Asks are listed best-at-the-bottom, so the spread sits in the middle.
  const asks = bookRows(book.asks, 'sell', DEPTH);
  const deepest = [bids.at(-1)?.cumulative ?? 0n, asks.at(-1)?.cumulative ?? 0n].reduce(
    (a, b) => (a > b ? a : b),
    0n,
  );
  const top = topOfBook(book);
  // Not live: dimmed, and still shown. Hiding a stale book is a different lie.
  const current = socket === 'open' && book.status === 'live';

  return (
    <section className="atlas-raised overflow-hidden rounded-lg" aria-label="Order book">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold text-ink">Order book</h2>
        <LiveBadge socket={socket} book={book.status} />
      </header>
      <div className="grid grid-cols-3 gap-2 px-3 py-1.5 text-right text-[11px] font-semibold text-ink-muted">
        <span className="text-left">Price ({market.quoteSymbol})</span>
        <span>Size ({market.baseSymbol})</span>
        <span>Total</span>
      </div>
      <div className={current ? '' : 'opacity-50'} data-testid="book-levels" data-live={current}>
        <Side
          rows={[...asks].reverse()}
          side="sell"
          deepest={deepest}
          market={market}
          onPick={onPickPrice}
        />
        <p className="border-y border-line px-3 py-1.5 font-mono text-xs text-ink-secondary">
          {top.bid !== null && top.ask !== null ? (
            <>
              Spread {formatPrice(top.ask - top.bid, market)}
              <span className="ml-2 text-ink-muted">mid {formatPrice(top.mid!, market)}</span>
            </>
          ) : (
            <span className="text-ink-muted">
              {book.status === 'empty' ? 'No book yet.' : 'One side of the book is empty.'}
            </span>
          )}
        </p>
        <Side rows={bids} side="buy" deepest={deepest} market={market} onPick={onPickPrice} />
      </div>
      {book.truncated && (
        <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
          The book is deeper than is shown here.
        </p>
      )}
    </section>
  );
}

/**
 * Depth: cumulative quantity against price, both sides, as two stepped areas.
 * Drawn as plain SVG — the geometry is a handful of rectangles, and it keeps
 * every quantity a `bigint` until the moment it becomes a height.
 */
export function DepthChart({ book, market }: { book: BookState; market: MarketView }) {
  const bids = bookRows(book.bids, 'buy', 40);
  const asks = bookRows(book.asks, 'sell', 40);
  const deepest = [bids.at(-1)?.cumulative ?? 0n, asks.at(-1)?.cumulative ?? 0n].reduce(
    (a, b) => (a > b ? a : b),
    0n,
  );
  if (deepest === 0n) {
    return <p className="px-3 py-8 text-center text-xs text-ink-muted">No depth to draw.</p>;
  }
  const bar = (row: BookRow, index: number, count: number, side: 'buy' | 'sell') => {
    const height = Number((row.cumulative * 1000n) / deepest) / 10;
    const width = 50 / Math.max(count, 1);
    const x = side === 'buy' ? 50 - (index + 1) * width : 50 + index * width;
    return (
      <rect
        key={`${side}-${row.price.toString()}`}
        x={x}
        y={100 - height}
        width={width}
        height={height}
        className={side === 'buy' ? 'fill-success/40' : 'fill-danger/40'}
      >
        <title>
          {formatPrice(row.price, market)} — {formatBase(row.cumulative, market, 3)}{' '}
          {market.baseSymbol} cumulative
        </title>
      </rect>
    );
  };
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="h-28 w-full"
      role="img"
      aria-label="Cumulative depth by price"
    >
      {bids.map((row, index) => bar(row, index, bids.length, 'buy'))}
      {asks.map((row, index) => bar(row, index, asks.length, 'sell'))}
    </svg>
  );
}
