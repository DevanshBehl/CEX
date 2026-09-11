'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useBalances } from '@/features/custody/use-balances';
import { useStepUpAction } from '@/features/security/use-step-up';
import { newIdempotencyKey, useWithdrawals } from '@/features/withdrawal/use-withdrawals';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { formatAmount, isZeroAmount, shortenAddress } from '@/lib/format';
import { Button, Card, EmptyState, ErrorNotice, Field, Input, Spinner } from '@/components/ui';

export default function WithdrawPage() {
  const balances = useBalances(10_000);
  const withdrawals = useWithdrawals(5_000);
  const stepUp = useStepUpAction();

  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sol = balances.data?.find((b) => b.asset === 'SOL');

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    // Client validation is for the user's benefit only. The server validates
    // the same things again, and that is the check that counts
    // (master-prompt rule 76).
    if (destination.trim().length < 32) {
      setFormError('That does not look like a Solana address.');
      return;
    }
    const whole = Number.parseFloat(amount);
    if (!Number.isFinite(whole) || whole <= 0) {
      setFormError('Enter an amount greater than zero.');
      return;
    }

    // Whole SOL to lamports, as a string. The value never becomes a JS number
    // on the way to the server.
    const [integer = '0', fraction = ''] = amount.trim().split('.');
    const decimals = sol?.decimals ?? 9;
    if (fraction.length > decimals) {
      setFormError(`At most ${decimals} decimal places.`);
      return;
    }
    const baseUnits = `${integer}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');

    if (sol && BigInt(baseUnits) > BigInt(sol.available)) {
      setFormError('That is more than your available balance.');
      return;
    }

    // One key per form submission, so a retry after a network failure is the
    // same withdrawal rather than a second one.
    const idempotencyKey = newIdempotencyKey();
    setSubmitting(true);

    // `useStepUpAction` prompts for a fresh passkey assertion and retries if
    // the server asks for one — it already does exactly this for credential
    // changes, and needed no change for withdrawals (ADR-0011).
    const ok = await stepUp.run(() =>
      api.requestWithdrawal({
        asset: 'SOL',
        amount: baseUnits,
        destination: destination.trim(),
        idempotencyKey,
      }),
    );

    setSubmitting(false);
    if (ok) {
      setAmount('');
      setDestination('');
      await Promise.all([withdrawals.refresh(), balances.refresh()]);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Withdraw</h1>

      <Card title="Send SOL" description="Withdrawals are reviewed before they are sent.">
        {balances.loading ? (
          <Spinner label="Loading your balance…" />
        ) : (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Available</dt>
                <dd className="mt-1 font-mono tabular-nums">
                  {sol ? formatAmount(sol.available, sol.decimals) : '0'} SOL
                </dd>
              </div>
              {/*
                The locked balance has existed in the ledger since Phase 2 and
                has never been shown. A user whose funds are reserved against a
                pending withdrawal is owed that number (rule 158).
              */}
              {sol && !isZeroAmount(sol.locked) && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted">Reserved</dt>
                  <dd className="mt-1 font-mono tabular-nums text-muted">
                    {formatAmount(sol.locked, sol.decimals)} SOL
                  </dd>
                </div>
              )}
            </dl>

            <form onSubmit={onSubmit} className="space-y-4">
              <Field
                label="Destination address"
                hint="A Solana address on the same network. Check it carefully — a sent transaction cannot be reversed."
              >
                <Input
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="Recipient's Solana address"
                  spellCheck={false}
                />
              </Field>

              <Field label="Amount (SOL)">
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.0"
                />
              </Field>

              {formError !== null && <ErrorNotice message={formError} />}
              {stepUp.error !== null && (
                <ErrorNotice
                  message={stepUp.error.message}
                  correlationId={stepUp.error.correlationId}
                />
              )}

              <Button type="submit" disabled={submitting || stepUp.busy}>
                {submitting || stepUp.busy ? 'Submitting…' : 'Request withdrawal'}
              </Button>

              <p className="text-xs text-muted">
                Large withdrawals and first-time destinations are reviewed by a person before
                sending. You will be asked to confirm with your passkey.
              </p>
            </form>
          </>
        )}
      </Card>

      <Card title="Your withdrawals">
        {withdrawals.loading ? (
          <Spinner label="Loading…" />
        ) : withdrawals.error !== null ? (
          <ErrorNotice message={withdrawals.error} />
        ) : withdrawals.data && withdrawals.data.length > 0 ? (
          <ul className="divide-y divide-line">
            {withdrawals.data.map((w) => (
              <li key={w.id} className="space-y-1 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm tabular-nums">
                      −{formatAmount(w.amount, w.decimals)} {w.asset}
                    </span>
                    <WithdrawalStatusBadge status={w.status} />
                  </div>
                  <span className="text-xs text-muted">
                    {new Date(w.createdAt).toLocaleString()}
                  </span>
                </div>

                <p className="text-xs text-muted">
                  To <span className="font-mono">{shortenAddress(w.destination, 8)}</span>
                  {w.txSignature !== null && (
                    <>
                      {' · '}
                      <span className="font-mono">{shortenAddress(w.txSignature, 8)}</span>
                    </>
                  )}
                </p>

                {/* A safe, specific explanation per state — never a risk code. */}
                <p className="text-xs text-muted">{w.statusDetail}</p>

                {w.networkFee !== null && !isZeroAmount(w.networkFee) && (
                  <p className="text-xs text-muted">
                    Network fee {formatAmount(w.networkFee, w.decimals)} {w.asset}, paid by us.
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No withdrawals yet"
            body="Withdrawals appear here with their full status, from review through to settlement."
          />
        )}
      </Card>
    </div>
  );
}
