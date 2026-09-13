'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useBalances } from '@/features/custody/use-balances';
import { useStepUpAction } from '@/features/security/use-step-up';
import { newIdempotencyKey, useWithdrawals } from '@/features/withdrawal/use-withdrawals';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { formatAmount, isZeroAmount, shortenAddress } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  Figure,
  Input,
  PageHeader,
  Section,
  Spinner,
  SystemNote,
} from '@/components/ui';

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
    <div className="animate-fade-up">
      <PageHeader
        title="Withdraw"
        description="Send SOL to an external address. Reviewed before it is sent."
      />

      {/*
        §8: the form takes a readable measure in the left two thirds; the
        balance and the standing warnings sit beside it rather than stacked
        above, so the primary action is the first thing at the top of the page.
      */}
      <div className="grid items-start gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Send SOL" description="Withdrawals are reviewed before they are sent.">
            {balances.loading ? (
              <Spinner label="Loading your balance…" />
            ) : (
              <form onSubmit={onSubmit} className="max-w-xl space-y-5">
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

                <div className="flex items-center gap-4 pt-1">
                  <Button type="submit" size="lg" disabled={submitting || stepUp.busy}>
                    {submitting || stepUp.busy ? 'Submitting…' : 'Request withdrawal'}
                  </Button>
                  <p className="text-xs text-ink-muted">
                    You will be asked to confirm with your passkey.
                  </p>
                </div>
              </form>
            )}
          </Section>
        </div>

        {/* Balance and standing warnings: reference, not the primary action. */}
        <aside className="space-y-3">
          <div className="atlas-raised rounded-lg px-[18px] py-4">
            <Figure
              label="Available"
              value={sol ? formatAmount(sol.available, sol.decimals) : '0'}
              unit="SOL"
              loading={balances.loading}
            />
            {/*
              The locked balance has existed in the ledger since Phase 2 and
              was never shown. A user whose funds are reserved against a
              pending withdrawal is owed that number (rule 158).
            */}
            {sol && !isZeroAmount(sol.locked) && (
              <p className="mt-4 flex items-center gap-1.5 border-t border-line pt-4 text-xs text-warning">
                <span aria-hidden="true" className="h-1 w-1 rounded-full bg-warning" />
                {formatAmount(sol.locked, sol.decimals)} SOL reserved against a pending withdrawal
              </p>
            )}
          </div>

          <SystemNote label="Before you send" title="A sent transaction cannot be reversed">
            Large withdrawals and first-time destinations are reviewed by a person before sending.
            Check the destination address character by character — there is no recovery path for
            funds sent to the wrong one.
          </SystemNote>
        </aside>
      </div>

      <div className="mt-3">
        <Section title="Your withdrawals" flush>
          {withdrawals.loading ? (
            <div className="p-4">
              <Spinner label="Loading…" />
            </div>
          ) : withdrawals.error !== null ? (
            <div className="p-4">
              <ErrorNotice message={withdrawals.error} />
            </div>
          ) : withdrawals.data && withdrawals.data.length > 0 ? (
            <ul className="divide-y divide-line">
              {withdrawals.data.map((w) => (
                <li
                  key={w.id}
                  className="px-4 py-3.5 transition-colors duration-micro hover:bg-background-subtle"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-semibold text-ink">
                        −{formatAmount(w.amount, w.decimals)} {w.asset}
                      </span>
                      <WithdrawalStatusBadge status={w.status} />
                    </div>
                    <span className="font-mono text-xs text-ink-muted">
                      {new Date(w.createdAt).toLocaleString()}
                    </span>
                  </div>

                  {/*
                  §20: the identifiers sit on their own line in mono, indented
                  under the amount. A wallet user reads an address by its shape,
                  and proportional type destroys the shape.
                */}
                  <p className="mt-2 font-mono text-xs text-ink-muted">
                    <span className="text-ink-disabled">to</span> {shortenAddress(w.destination, 8)}
                    {w.txSignature !== null && (
                      <>
                        <span className="mx-2 text-ink-disabled">·</span>
                        {shortenAddress(w.txSignature, 8)}
                      </>
                    )}
                  </p>

                  {/* A safe, specific explanation per state — never a risk code. */}
                  <p className="mt-1.5 text-xs text-ink-secondary">{w.statusDetail}</p>

                  {w.networkFee !== null && !isZeroAmount(w.networkFee) && (
                    <p className="mt-1 text-xs text-ink-muted">
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
        </Section>
      </div>
    </div>
  );
}
