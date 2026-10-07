'use client';

import { useEffect, useState } from 'react';
import {
  isTerminal,
  type Balance,
  type MarketView,
  type TradingBalance,
  type Withdrawal,
} from '@wallet/types';
import { Button, ErrorNotice, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useStepUpAction } from '@/features/security/use-step-up';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { newIdempotencyKey } from '@/features/withdrawal/use-withdrawals';
import { formatAmount, parseAmount } from '@/lib/format';

/**
 * Moving funds between the wallet and trading (prompt_phase_s5.md rules
 * 159-160, ADR-0025).
 *
 * Two balances with two meanings, shown as two. The WALLET balance sits at the
 * user's own address. The TRADING balance is a claim on the clearing pool. A
 * transfer between them is a real on-chain transaction behind a passkey
 * confirmation, and takes as long as one — so its lifecycle is shown as it is,
 * state by state, rather than as a spinner that implies it is instant.
 */
export function TransferPanel({
  market,
  wallet,
  trading,
  onSettled,
}: {
  market: MarketView;
  wallet: readonly Balance[];
  trading: readonly TradingBalance[];
  /** A transfer reached a final state: both balances may have changed. */
  onSettled: () => void;
}) {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [asset, setAsset] = useState(market.quoteAsset);
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<Withdrawal | null>(null);
  const stepUp = useStepUpAction();

  const options = [
    { asset: market.baseAsset, symbol: market.baseSymbol, decimals: market.baseDecimals },
    { asset: market.quoteAsset, symbol: market.quoteSymbol, decimals: market.quoteDecimals },
  ];
  const selected = options.find((option) => option.asset === asset) ?? options[0]!;
  const walletAvailable = wallet.find((b) => b.asset === selected.asset)?.available ?? '0';
  const tradingAvailable = trading.find((b) => b.asset === selected.asset)?.available ?? '0';
  const source = direction === 'in' ? walletAvailable : tradingAvailable;

  // Follow the transfer through its real states until it reaches a final one.
  useEffect(() => {
    if (!transfer || isTerminal(transfer.status)) return;
    const timer = setInterval(() => {
      void api
        .getWithdrawal(transfer.id)
        .then(({ withdrawal }) => {
          setTransfer(withdrawal);
          if (isTerminal(withdrawal.status)) onSettled();
        })
        .catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [transfer, onSettled]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseAmount(amount, selected.decimals);
    if (!parsed.ok) {
      setFormError(
        parsed.reason === 'too_precise'
          ? `${selected.symbol} has at most ${String(selected.decimals)} decimal places.`
          : 'Enter an amount greater than zero.',
      );
      return;
    }
    if (BigInt(parsed.baseUnits) > BigInt(source)) {
      setFormError('That is more than is available to move.');
      return;
    }
    // One key per submission: a retry after a failure is the same transfer.
    const body = {
      asset: selected.asset,
      amount: parsed.baseUnits,
      idempotencyKey: newIdempotencyKey(),
    };
    await stepUp.run(async () => {
      const { withdrawal } = await (direction === 'in' ? api.allocate(body) : api.deallocate(body));
      setTransfer(withdrawal);
      setAmount('');
    });
  }

  return (
    <section className="atlas-raised overflow-hidden rounded-lg" aria-label="Move funds">
      <header className="border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold text-ink">Wallet ↔ Trading</h2>
      </header>
      <form onSubmit={submit} className="space-y-3 p-3" noValidate>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border border-line p-2">
            <dt className="text-ink-muted">Wallet — at your own address</dt>
            <dd className="mt-0.5 font-mono text-ink">
              {formatAmount(walletAvailable, selected.decimals)} {selected.symbol}
            </dd>
          </div>
          <div className="rounded-md border border-line p-2">
            <dt className="text-ink-muted">Trading — a claim on the clearing pool</dt>
            <dd className="mt-0.5 font-mono text-ink" data-testid="trading-available">
              {formatAmount(tradingAvailable, selected.decimals)} {selected.symbol}
            </dd>
          </div>
        </dl>

        <div className="grid grid-cols-2 gap-1" role="group" aria-label="Direction">
          {(
            [
              ['in', 'To trading'],
              ['out', 'To wallet'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={direction === value}
              onClick={() => setDirection(value)}
              className={`rounded-md py-1.5 text-xs font-semibold ${
                direction === value ? 'bg-surface-active text-ink' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[auto_1fr] items-end gap-2">
          <label className="block space-y-1.5 text-xs font-semibold text-ink-secondary">
            Asset
            <select
              value={selected.asset}
              onChange={(event) => setAsset(event.target.value)}
              className="block rounded-md border border-line bg-background-subtle px-2 py-2.5 text-sm text-ink"
            >
              {options.map((option) => (
                <option key={option.asset} value={option.asset}>
                  {option.symbol}
                </option>
              ))}
            </select>
          </label>
          <Field label="Amount">
            <Input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-muted">
          This is an on-chain transfer, confirmed with your passkey. It is finalised by the network
          before it is credited, which usually takes around half a minute.
        </p>

        {formError && <ErrorNotice message={formError} />}
        {stepUp.error && (
          <ErrorNotice message={stepUp.error.message} correlationId={stepUp.error.correlationId} />
        )}

        <Button type="submit" variant="secondary" className="w-full" disabled={stepUp.busy}>
          {stepUp.busy ? 'Confirming…' : direction === 'in' ? 'Move to trading' : 'Move to wallet'}
        </Button>

        {transfer && (
          <div
            className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-xs"
            data-testid="transfer-status"
          >
            <span className="text-ink-secondary">
              {isTerminal(transfer.status) ? 'Last transfer' : 'Transfer in progress — on-chain'}
            </span>
            <WithdrawalStatusBadge status={transfer.status} />
          </div>
        )}
      </form>
    </section>
  );
}
