'use client';

import type { MarketView, TradeView } from '@wallet/types';
import type { SocketState } from '@/lib/ws';
import { formatBase, formatPrice, timeOf } from './format';
import { LiveBadge } from './notices';

/**
 * The public tape: what matched, newest first.
 *
 * These are everyone's trades, as the engine published them. A trade of the
 * signed-in user's appears here like anyone's and is NOT marked as theirs: a
 * match is public before it is settled, and "your fill" is something only the
 * ledger can say (rule 127). Their fills are in the panel that reads them from
 * it.
 */
export function TradeTape({
  trades,
  socket,
  market,
}: {
  trades: readonly TradeView[];
  socket: SocketState;
  market: MarketView;
}) {
  return (
    <section className="atlas-raised overflow-hidden rounded-lg" aria-label="Recent trades">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold text-ink">Trades</h2>
        <LiveBadge socket={socket} />
      </header>
      <div className="grid grid-cols-3 gap-2 px-3 py-1.5 text-right text-[11px] font-semibold text-ink-muted">
        <span className="text-left">Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      {trades.length === 0 ? (
        <p className="px-3 py-8 text-center text-xs text-ink-muted">No trades yet.</p>
      ) : (
        <ul
          className={`max-h-80 overflow-y-auto font-mono text-xs ${socket === 'open' ? '' : 'opacity-50'}`}
          data-testid="trade-tape"
        >
          {trades.map((trade) => (
            <li key={trade.id} className="grid grid-cols-3 gap-2 px-3 py-[3px] text-right">
              <span
                className={`text-left ${trade.takerSide === 'buy' ? 'text-success' : 'text-danger'}`}
              >
                {formatPrice(trade.price, market)}
              </span>
              <span className="text-ink">{formatBase(trade.qty, market, 3)}</span>
              <span className="text-ink-muted">{timeOf(trade.time)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
