'use client';

import { useMemo, useState } from 'react';
import type { Balance } from '@wallet/types';
import { api } from '@/lib/api';
import { useBalances } from '@/features/custody/use-balances';
import { useStepUpAction } from '@/features/security/use-step-up';
import { newIdempotencyKey, useWithdrawals } from '@/features/withdrawal/use-withdrawals';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { formatAmount, isZeroAmount, parseAmount, shortenAddress } from '@/lib/format';
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

/**
 * Worth preselecting: an asset the user actually holds some of.
 *
 * The balance list already contains every allowlisted asset, zero-filled, so
 * "which one did they most likely come here to send" is a real question and
 * the answer is the first one with a balance. Never a filter — an asset with
 * a zero balance still appears in the picker, because a user needs to see that
 * the platform can send it at all.
 *
 * The form is driven by that list rather than by a hard-coded `SOL` because
 * every asset the platform will credit is one it must be able to withdraw
 * (ADR-0016): a balance you can receive and cannot send is a balance the
 * product has trapped. A token allowlisted tomorrow is sendable without
 * touching this file.
 */
function holdsSome(balance: Balance): boolean {
  return !isZeroAmount(balance.available);
}

export default function WithdrawPage() {
  const balances = useBalances(10_000);
  const withdrawals = useWithdrawals(5_000);
  const stepUp = useStepUpAction();

  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const assets = useMemo(() => balances.data ?? [], [balances.data]);

  /*
   * The selection, resolved against what the server actually returned.
   *
   * Held as an asset KEY rather than an index or a `Balance` object, because
   * the list is re-fetched every ten seconds and on every network switch. An
   * index would silently point at a different asset after a refetch, and a
   * held object would go stale. A key that no longer appears — the usual case
   * being a cluster switch, where the mints are entirely different — falls
   * back to the first asset rather than leaving the form pointed at nothing.
   */
  const selected = useMemo(() => {
    const match = assets.find((balance) => balance.asset === selectedAsset);
    if (match) return match;
    return assets.find(holdsSome) ?? assets[0] ?? null;
  }, [assets, selectedAsset]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (!selected) {
      setFormError('No asset selected.');
      return;
    }

    // Client validation is for the user's benefit only. The server validates
    // the same things again, and that is the check that counts
    // (master-prompt rule 76).
    if (destination.trim().length < 32) {
      setFormError('That does not look like a Solana address.');
      return;
    }

    // Parsed with the SELECTED asset's decimals. Nine was right only for as
    // long as SOL was the only sendable asset; a six-decimal token parsed at
    // nine asks the server for a thousand times the amount on screen.
    const parsed = parseAmount(amount, selected.decimals);
    if (!parsed.ok) {
      setFormError(
        parsed.reason === 'too_precise'
          ? `${selected.symbol} has at most ${String(selected.decimals)} decimal places.`
          : 'Enter an amount greater than zero.',
      );
      return;
    }

    if (BigInt(parsed.baseUnits) > BigInt(selected.available)) {
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
        // The asset key as the server names it: `SOL`, or a mint address for a
        // token. The cluster is NOT sent — the server takes it from the
        // request's context (ADR-0021).
        asset: selected.asset,
        amount: parsed.baseUnits,
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

  function selectAsset(assetKey: string) {
    setSelectedAsset(assetKey);
    // The amount means something different under each asset — "10" is ten SOL
    // or ten USDC — and carrying it across is how a user sends the wrong size.
    setAmount('');
    setFormError(null);
  }

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Withdraw"
        description="Send your assets to an external address. Reviewed before they are sent."
      />

      {/*
        §8: the form takes a readable measure in the left two thirds; the
        balance and the standing warnings sit beside it rather than stacked
        above, so the primary action is the first thing at the top of the page.
      */}
      <div className="grid items-start gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section
            title={selected ? `Send ${selected.symbol}` : 'Send'}
            description="Withdrawals are reviewed before they are sent."
          >
            {balances.loading ? (
              <Spinner label="Loading your balances…" />
            ) : assets.length === 0 ? (
              <EmptyState
                title="Nothing to send yet"
                body="Deposit an asset first and it will appear here, ready to withdraw."
              />
            ) : (
              <form onSubmit={onSubmit} className="max-w-xl space-y-5">
                {/*
                  §19: the asset comes FIRST, because it changes the meaning of
                  every field under it — the decimals the amount is read at,
                  the balance it is checked against, and the ticker beside it.
                  Rendered as a segmented control rather than a <select> so the
                  available balance is visible without opening anything: the
                  number a person needs in order to choose.
                */}
                <fieldset>
                  <legend className="mb-1.5 block text-xs font-semibold text-ink-secondary">
                    Asset
                  </legend>
                  <div
                    role="radiogroup"
                    aria-label="Asset to withdraw"
                    className="flex flex-wrap gap-2"
                  >
                    {assets.map((balance) => {
                      const active = selected?.asset === balance.asset;
                      return (
                        <button
                          key={balance.asset}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => selectAsset(balance.asset)}
                          className={[
                            'rounded-md border px-3 py-2 text-left',
                            'transition-colors duration-micro ease-atlas',
                            active
                              ? 'border-accent-strong bg-background-subtle'
                              : 'border-line hover:border-line-strong',
                          ].join(' ')}
                        >
                          <span className="block text-sm font-semibold text-ink">
                            {balance.symbol}
                          </span>
                          <span className="block font-mono text-xs text-ink-muted">
                            {formatAmount(balance.available, balance.decimals)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

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

                <Field label={selected ? `Amount (${selected.symbol})` : 'Amount'}>
                  <Input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.0"
                  />
                </Field>

                {selected && !isZeroAmount(selected.available) && (
                  <p className="-mt-2 text-xs text-ink-muted">
                    Available {formatAmount(selected.available, selected.decimals)}{' '}
                    {selected.symbol}
                    {/*
                      Fills the field rather than submitting: "max" is a
                      convenience, and a withdrawal is not something to send on
                      one click.
                    */}
                    <button
                      type="button"
                      className="ml-2 font-semibold text-accent-strong hover:underline"
                      onClick={() =>
                        setAmount(
                          formatAmount(selected.available, selected.decimals).replace(/,/g, ''),
                        )
                      }
                    >
                      Use max
                    </button>
                  </p>
                )}

                {/*
                  The network fee is the house's, in SOL, whatever is being
                  sent (ADR-0020 §3). Stated here because a user sending a
                  token holds no SOL and would reasonably expect to need some.
                */}
                {selected && selected.symbol !== 'SOL' && (
                  <p className="-mt-2 text-xs text-ink-muted">
                    You need no SOL to send {selected.symbol}. We pay the network fee.
                  </p>
                )}

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
              value={selected ? formatAmount(selected.available, selected.decimals) : '0'}
              unit={selected?.symbol ?? ''}
              loading={balances.loading}
            />
            {/*
              The locked balance has existed in the ledger since Phase 2 and
              was never shown. A user whose funds are reserved against a
              pending withdrawal is owed that number (rule 158).
            */}
            {selected && !isZeroAmount(selected.locked) && (
              <p className="mt-4 flex items-center gap-1.5 border-t border-line pt-4 text-xs text-warning">
                <span aria-hidden="true" className="h-1 w-1 rounded-full bg-warning" />
                {formatAmount(selected.locked, selected.decimals)} {selected.symbol} reserved
                against a pending withdrawal
              </p>
            )}
          </div>

          <SystemNote label="Before you send" title="A sent transaction cannot be reversed">
            Large withdrawals are reviewed by a person before sending. Check the destination address
            character by character — there is no recovery path for funds sent to the wrong one, and
            sending a token to an address on the wrong network loses it.
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
                      {/*
                        `symbol`, not `asset`. For a token the asset key IS the
                        mint address, and rendering it here put 44 characters
                        of base58 where a ticker belongs.
                      */}
                      <span className="font-mono text-sm font-semibold text-ink">
                        −{formatAmount(w.amount, w.decimals)} {w.symbol}
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
                      {/*
                        The fee's OWN symbol and decimals. A validator is paid
                        in SOL whatever moved, so a USDC withdrawal's fee is
                        lamports at nine decimals — rendered with the token's
                        six it read a thousand times too large, in the wrong
                        unit.
                      */}
                      Network fee {formatAmount(w.networkFee, w.networkFeeDecimals)}{' '}
                      {w.networkFeeSymbol}, paid by us.
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
