'use client';

import { useState } from 'react';
import {
  parseDecimal,
  parseHumanPrice,
  type MarketView,
  type OrderStatus,
  type OrderView,
  type UserFillView,
} from '@wallet/types';
import { Button, ErrorNotice, Field, Input, Modal, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { formatBase, formatPrice, formatQuote, timeOf } from './format';

/**
 * The user's orders and fills.
 *
 * Every status the server can send has a label here, and one it cannot is
 * shown as unknown rather than guessed at (rule 145). `statusDetail` is the
 * server's own sentence and is shown as given: it is generic by contract, and
 * this does not sharpen it into something the server did not say (rule 146).
 */

const STATUS: Record<OrderStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  PENDING_ENGINE: { label: 'Being placed', tone: 'neutral' },
  OPEN: { label: 'Open', tone: 'good' },
  PARTIALLY_FILLED: { label: 'Partly filled', tone: 'good' },
  PENDING_CANCEL: { label: 'Cancelling', tone: 'warn' },
  FILLED: { label: 'Filled', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  REJECTED: { label: 'Not accepted', tone: 'bad' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'bad' },
};

function Status({ status }: { status: string }) {
  const known = STATUS[status as OrderStatus] as (typeof STATUS)[OrderStatus] | undefined;
  return <StatusBadge tone={known?.tone ?? 'warn'}>{known?.label ?? 'Unknown'}</StatusBadge>;
}

type Tab = 'open' | 'history' | 'fills';

function AmendDialog({
  order,
  market,
  onClose,
  onDone,
}: {
  order: OrderView;
  market: MarketView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per intent, as for a placement: an amend PLACES A NEW ORDER.
  const [clientOrderId] = useState(() => crypto.randomUUID());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsedPrice = parseHumanPrice(price, market);
    const parsedQty = parseDecimal(qty, market.baseDecimals);
    if (!parsedPrice.ok || !parsedQty.ok || parsedQty.value === 0n) {
      setError('Enter a price and a quantity as plain numbers.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.amendOrder(order.id, {
        clientOrderId,
        price: parsedPrice.value.toString(),
        qty: parsedQty.value.toString(),
      });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The order could not be changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="Change this order" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 p-5">
        <p className="text-xs leading-relaxed text-ink-muted">
          Changing an order cancels it and places a new one. The new order goes to the back of the
          queue at its price, and is shown as a separate order.
        </p>
        <Field label={`New price (${market.quoteSymbol})`}>
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label={`New quantity (${market.baseSymbol})`}>
          <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        {error && <ErrorNotice message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Changing…' : 'Replace order'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function OrdersPanel({
  market,
  orders,
  fills,
  loading,
  error,
  hasMoreOrders,
  hasMoreFills,
  onMoreOrders,
  onMoreFills,
  onChanged,
}: {
  market: MarketView;
  orders: readonly OrderView[];
  fills: readonly UserFillView[];
  loading: boolean;
  error: string | null;
  hasMoreOrders: boolean;
  hasMoreFills: boolean;
  onMoreOrders: () => void;
  onMoreFills: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>('open');
  const [amending, setAmending] = useState<OrderView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const open = orders.filter((order) => !order.isTerminal);
  const shown = tab === 'open' ? open : orders;

  async function cancel(order: OrderView) {
    setCancelling(order.id);
    setFailure(null);
    try {
      await api.cancelOrder(order.id);
      onChanged();
    } catch (problem) {
      // Including the conflict while an order is still being placed: the
      // server's sentence says so, and it is shown as given.
      setFailure(problem instanceof Error ? problem.message : 'The order could not be cancelled.');
    } finally {
      setCancelling(null);
    }
  }

  return (
    <section className="atlas-raised overflow-hidden rounded-lg" aria-label="Your orders">
      <header className="flex items-center gap-1 border-b border-line px-2 py-1.5" role="tablist">
        {(
          [
            ['open', `Open orders (${String(open.length)})`],
            ['history', 'Order history'],
            ['fills', 'Your fills'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-sm px-2.5 py-1 text-xs font-semibold ${
              tab === id ? 'bg-surface-active text-ink' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </header>

      {error && (
        <div className="p-3">
          <ErrorNotice message={error} />
        </div>
      )}
      {failure && (
        <div className="p-3">
          <ErrorNotice message={failure} />
        </div>
      )}

      {tab === 'fills' ? (
        fills.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-ink-muted">
            {loading ? 'Loading…' : 'No fills yet. A fill appears here once it has settled.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="fills-table">
              <thead className="text-left text-[11px] text-ink-muted">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">Time</th>
                  <th className="px-3 py-1.5 font-semibold">Side</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Price</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Size</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Value</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Fee</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {fills.map((fill) => (
                  <tr key={fill.id} className="border-t border-line">
                    <td className="px-3 py-1.5 text-ink-muted">{timeOf(fill.time)}</td>
                    <td
                      className={`px-3 py-1.5 ${fill.side === 'buy' ? 'text-success' : 'text-danger'}`}
                    >
                      {fill.side} · {fill.role}
                    </td>
                    <td className="px-3 py-1.5 text-right text-ink">
                      {formatPrice(fill.price, market)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-ink">
                      {formatBase(fill.qty, market, 3)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-ink">
                      {formatQuote(fill.notional, market)}
                    </td>
                    {/* The recorded rate and amount: not an estimate (rule 153). */}
                    <td className="px-3 py-1.5 text-right text-ink-secondary">
                      {formatQuote(fill.fee, market, 4)}{' '}
                      <span className="text-ink-muted">({String(fill.feeBps)} bp)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasMoreFills && (
              <div className="border-t border-line p-2 text-center">
                <Button variant="ghost" size="sm" onClick={onMoreFills}>
                  Load older fills
                </Button>
              </div>
            )}
          </div>
        )
      ) : shown.length === 0 ? (
        <p className="px-3 py-8 text-center text-xs text-ink-muted">
          {loading ? 'Loading…' : tab === 'open' ? 'No open orders.' : 'No orders yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="orders-table">
            <thead className="text-left text-[11px] text-ink-muted">
              <tr>
                <th className="px-3 py-1.5 font-semibold">Side</th>
                <th className="px-3 py-1.5 text-right font-semibold">Price</th>
                <th className="px-3 py-1.5 text-right font-semibold">Size</th>
                <th className="px-3 py-1.5 text-right font-semibold">Filled</th>
                <th className="px-3 py-1.5 font-semibold">Status</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((order) => (
                <tr key={order.id} className="border-t border-line" data-order-id={order.id}>
                  <td
                    className={`px-3 py-1.5 font-mono ${order.side === 'buy' ? 'text-success' : 'text-danger'}`}
                  >
                    {order.side} · {order.type}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink">
                    {order.price === null ? 'market' : formatPrice(order.price, market)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink">
                    {formatBase(order.qty, market, 3)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink-secondary">
                    {formatBase(order.filledQty, market, 3)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Status status={order.status} />
                    <span className="ml-2 text-[11px] text-ink-muted">{order.statusDetail}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    {!order.isTerminal && (
                      <>
                        {order.type === 'limit' &&
                          (order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED') && (
                            <Button variant="ghost" size="sm" onClick={() => setAmending(order)}>
                              Change
                            </Button>
                          )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cancelling === order.id || order.status === 'PENDING_CANCEL'}
                          onClick={() => void cancel(order)}
                        >
                          {order.status === 'PENDING_CANCEL' ? 'Cancelling' : 'Cancel'}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tab === 'history' && hasMoreOrders && (
            <div className="border-t border-line p-2 text-center">
              <Button variant="ghost" size="sm" onClick={onMoreOrders}>
                Load older orders
              </Button>
            </div>
          )}
        </div>
      )}

      {amending && (
        <AmendDialog
          order={amending}
          market={market}
          onClose={() => setAmending(null)}
          onDone={() => {
            setAmending(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
