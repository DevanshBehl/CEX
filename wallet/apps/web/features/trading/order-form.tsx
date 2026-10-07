'use client';

import { useMemo, useRef, useState } from 'react';
import { TIME_IN_FORCE, type Cluster, type MarketView, type TradingBalance } from '@wallet/types';
import { Button, ErrorNotice, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatBase, formatQuote } from './format';
import { draftOrder } from './order-draft';

/**
 * Order entry (prompt_phase_s5.md rules 149-153).
 *
 * What it shows before a person submits is what the gateway will do: the same
 * validation, and the same hold. What it sends is integers parsed from what
 * was typed, never a float.
 *
 * ONE `clientOrderId` PER INTENT. It is minted when the person commits to an
 * order and reused for every retry of that submission — a double click, or a
 * retry after a timeout, is then the SAME order with one hold, because the
 * gateway's idempotency sees the same key. Only a successful response, or an
 * edit to the order, ends the intent and allows a new id.
 */
export function OrderForm({
  cluster,
  market,
  reference,
  balances,
  price,
  onPrice,
  onPlaced,
}: {
  cluster: Cluster;
  market: MarketView;
  /** The last trade, else the mid: an estimate of the engine's reference. */
  reference: bigint | null;
  balances: readonly TradingBalance[];
  price: string;
  onPrice: (price: string) => void;
  onPlaced: () => void;
}) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'limit' | 'market'>('limit');
  const [timeInForce, setTimeInForce] = useState<(typeof TIME_IN_FORCE)[number]>('GTC');
  const [postOnly, setPostOnly] = useState(false);
  const [qty, setQty] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );
  /** The intent in flight: the order as drafted, and the one id it was given. */
  const intent = useRef<{ fingerprint: string; clientOrderId: string } | null>(null);

  const draft = useMemo(
    () => draftOrder({ cluster, market, side, type, timeInForce, postOnly, price, qty, reference }),
    [cluster, market, side, type, timeInForce, postOnly, price, qty, reference],
  );

  const base = balances.find((balance) => balance.asset === market.baseAsset);
  const quote = balances.find((balance) => balance.asset === market.quoteAsset);
  const spendable = BigInt((side === 'buy' ? quote : base)?.available ?? '0');
  const short = draft.ok && draft.hold.amount > spendable;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    // A second submit while the first is in flight is the same click twice.
    if (!draft.ok || short || submitting) return;

    const fingerprint = JSON.stringify(draft.body);
    if (intent.current?.fingerprint !== fingerprint) {
      intent.current = { fingerprint, clientOrderId: crypto.randomUUID() };
    }
    const { clientOrderId } = intent.current;

    setSubmitting(true);
    setFailure(null);
    try {
      await api.placeOrder({ ...draft.body, clientOrderId });
      // The intent is complete. The next submission is a new order.
      intent.current = null;
      setQty('');
      setTouched(false);
      onPlaced();
    } catch (error) {
      // The id is KEPT: pressing submit again retries this order, it does not
      // place another. If the first attempt did reach the gateway, the retry
      // returns the order it already created.
      setFailure({
        message: error instanceof Error ? error.message : 'The order could not be placed.',
        correlationId: error instanceof ApiError ? error.correlationId : null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  const holdText =
    draft.ok &&
    (draft.hold.asset === 'quote'
      ? `${formatQuote(draft.hold.amount, market)} ${market.quoteSymbol}`
      : `${formatBase(draft.hold.amount, market)} ${market.baseSymbol}`);

  return (
    <section className="atlas-raised overflow-hidden rounded-lg" aria-label="Place an order">
      <header className="border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold text-ink">Place an order</h2>
      </header>
      <form onSubmit={submit} className="space-y-3 p-3" noValidate>
        <div className="grid grid-cols-2 gap-1" role="group" aria-label="Side">
          {(['buy', 'sell'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={side === option}
              onClick={() => setSide(option)}
              className={`rounded-md py-1.5 text-sm font-semibold ${
                side === option
                  ? option === 'buy'
                    ? 'bg-success-dim text-success'
                    : 'bg-danger-dim text-danger'
                  : 'bg-surface-active text-ink-muted hover:text-ink'
              }`}
            >
              {option === 'buy' ? 'Buy' : 'Sell'} {market.baseSymbol}
            </button>
          ))}
        </div>

        <div className="flex gap-3 text-xs" role="group" aria-label="Order type">
          {(['limit', 'market'] as const).map((option) => (
            <label key={option} className="flex items-center gap-1.5 text-ink-secondary">
              <input
                type="radio"
                name="order-type"
                checked={type === option}
                onChange={() => setType(option)}
              />
              {option === 'limit' ? 'Limit' : 'Market'}
            </label>
          ))}
        </div>

        {type === 'limit' && (
          <Field label={`Price (${market.quoteSymbol})`}>
            <Input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={price}
              onChange={(event) => onPrice(event.target.value)}
            />
          </Field>
        )}
        <Field label={`Quantity (${market.baseSymbol})`}>
          <Input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={qty}
            onChange={(event) => setQty(event.target.value)}
          />
        </Field>

        {type === 'limit' && (
          <div className="flex items-center justify-between gap-3 text-xs text-ink-secondary">
            <label className="flex items-center gap-1.5">
              Time in force
              <select
                value={timeInForce}
                onChange={(event) =>
                  setTimeInForce(event.target.value as (typeof TIME_IN_FORCE)[number])
                }
                className="rounded-sm border border-line bg-background-subtle px-1.5 py-1 text-ink"
              >
                {TIME_IN_FORCE.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={postOnly}
                onChange={(event) => setPostOnly(event.target.checked)}
              />
              Post only
            </label>
          </div>
        )}

        <dl className="space-y-1 border-t border-line pt-3 text-xs">
          <div className="flex justify-between">
            <dt className="text-ink-muted">Available</dt>
            <dd className="font-mono text-ink">
              {side === 'buy'
                ? `${formatQuote(spendable, market)} ${market.quoteSymbol}`
                : `${formatBase(spendable, market)} ${market.baseSymbol}`}
            </dd>
          </div>
          {draft.ok && (
            <>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Will be reserved</dt>
                <dd className="font-mono text-ink" data-testid="hold-amount">
                  {holdText}
                </dd>
              </div>
              {draft.estimatedFee !== null && (
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Estimated fee, if it takes</dt>
                  <dd className="font-mono text-ink-secondary">
                    ≈ {formatQuote(draft.estimatedFee, market)} {market.quoteSymbol}
                  </dd>
                </div>
              )}
            </>
          )}
        </dl>

        {draft.ok && side === 'buy' && (
          <p className="text-[11px] leading-relaxed text-ink-muted">
            {type === 'market'
              ? 'A market buy reserves at the top of this market’s price band, the most it could pay, plus the highest fee rate. '
              : 'The reservation includes the highest fee rate you could be charged. '}
            Whatever is not spent returns to your trading balance when the order is finished.
          </p>
        )}

        {touched && !draft.ok && (
          <ul className="space-y-1 text-xs text-danger" role="alert">
            {draft.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        {short && (
          <p className="text-xs text-danger" role="alert">
            This order would reserve more than your available trading balance.
          </p>
        )}
        {failure && <ErrorNotice message={failure.message} correlationId={failure.correlationId} />}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Placing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${market.baseSymbol}`}
        </Button>
      </form>
    </section>
  );
}
