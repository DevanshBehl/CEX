'use client';

import type { CapabilitiesResponse, MarketView } from '@wallet/types';
import { StatusBadge } from '@/components/ui';
import type { SocketState } from '@/lib/ws';
import type { BookState } from './book-state';

/**
 * What the screen says about itself (prompt_phase_s5.md rules 143, 147, 148).
 *
 * A trading screen lies by omission more easily than any other: a book that
 * stopped updating looks like a quiet market, and liquidity quoted by a
 * program looks like a market. These are the statements that stop it — each
 * one read from the server, none of them copy that could go stale.
 */

/** Whether the live panels are current. Shown on each of them, not once. */
export function LiveBadge({ socket, book }: { socket: SocketState; book?: BookState['status'] }) {
  if (socket === 'signed_out') return <StatusBadge tone="bad">Signed out</StatusBadge>;
  if (socket !== 'open') return <StatusBadge tone="warn">Reconnecting — stale</StatusBadge>;
  if (book === 'stale') return <StatusBadge tone="warn">Resynchronising — stale</StatusBadge>;
  if (book === 'empty') return <StatusBadge tone="neutral">Waiting for the book</StatusBadge>;
  return <StatusBadge tone="good">Live</StatusBadge>;
}

function Notice({
  tone,
  children,
}: {
  tone: 'warn' | 'bad' | 'neutral';
  children: React.ReactNode;
}) {
  const styles = {
    warn: 'border-warning/30 bg-warning-dim text-warning',
    bad: 'border-danger/30 bg-danger-dim text-danger',
    neutral: 'border-line bg-surface-active text-ink-secondary',
  }[tone];
  return (
    <p role="status" className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${styles}`}>
      {children}
    </p>
  );
}

export function DeploymentNotices({
  capabilities,
  market,
  socket,
}: {
  capabilities: CapabilitiesResponse | undefined;
  market: MarketView;
  socket: SocketState;
}) {
  const trading = capabilities?.trading;
  return (
    <div className="space-y-2">
      {socket === 'signed_out' && (
        <Notice tone="bad">
          Your session ended, so live data has stopped. Sign in again to continue.
        </Notice>
      )}
      {socket === 'connecting' && (
        <Notice tone="warn">
          Reconnecting. The book and the tape below are not current; orders you place still go
          through.
        </Notice>
      )}
      {trading?.syntheticLiquidity === true && (
        <Notice tone="neutral">
          <strong className="font-semibold">Synthetic liquidity.</strong> Quotes in this book are
          placed by a demo market maker, a program quoting around a reference price it was given —
          by default one it generates itself. It is not a real market. Its fills are real: they move
          your trading balance and charge fees.
        </Notice>
      )}
      {trading !== undefined && !trading.settlement && (
        <Notice tone="warn">
          <strong className="font-semibold">Settlement is off on this deployment.</strong> Orders
          match and their holds are taken, but fills do not move balances.
        </Notice>
      )}
      {market.settlement === 'delayed' && (
        <Notice tone="warn">
          Settlement for this market is running behind. Fills will appear, and balances will change,
          later than the trades on the tape.
        </Notice>
      )}
      {market.settlement === 'halted' && (
        <Notice tone="bad">
          <strong className="font-semibold">Settlement for this market has stopped</strong> and
          needs an operator. Orders may still match; fills will not reach your balance until it
          resumes. Funds held for your orders remain held.
        </Notice>
      )}
      {market.status !== 'open' && (
        <Notice tone="warn">
          This market is {market.status.replace('_', ' ')}.{' '}
          {market.status === 'halted'
            ? 'New orders are refused; you can still cancel.'
            : 'Some orders may be refused.'}
        </Notice>
      )}
    </div>
  );
}
