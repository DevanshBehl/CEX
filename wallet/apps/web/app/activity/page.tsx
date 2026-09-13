'use client';

import { useMemo } from 'react';
import type { Deposit, Withdrawal } from '@wallet/types';
import { useDeposits } from '@/features/custody/use-balances';
import { DepositStatusBadge } from '@/features/custody/balance-list';
import { useWithdrawals } from '@/features/withdrawal/use-withdrawals';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { useAssetLabel } from '@/features/portfolio/use-asset-label';
import { formatAmount, isZeroAmount, shortenAddress } from '@/lib/format';
import { EmptyState, ErrorNotice, PageHeader, Section, Spinner } from '@/components/ui';

/**
 * Everything that moved, in one list (Task 5).
 *
 * It listed DEPOSITS only, while its own description promised "every deposit
 * and withdrawal". A page that says it shows everything and shows half is
 * worse than one that admits to half: someone checking whether their
 * withdrawal went through looked here and found nothing.
 */
type Row =
  | { kind: 'deposit'; at: string; deposit: Deposit }
  | { kind: 'withdrawal'; at: string; withdrawal: Withdrawal };

export default function ActivityPage() {
  const deposits = useDeposits(10_000);
  const withdrawals = useWithdrawals(10_000);
  const labelOf = useAssetLabel();

  const rows = useMemo<Row[]>(() => {
    const merged: Row[] = [
      ...(deposits.data ?? []).map(
        (deposit): Row => ({ kind: 'deposit', at: deposit.createdAt, deposit }),
      ),
      ...(withdrawals.data ?? []).map(
        (withdrawal): Row => ({ kind: 'withdrawal', at: withdrawal.createdAt, withdrawal }),
      ),
    ];
    // Newest first. One ordering across both kinds, because a user reading
    // this is reconstructing a sequence of events, not two sequences.
    return merged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [deposits.data, withdrawals.data]);

  const loading = deposits.loading || withdrawals.loading;
  const error = deposits.error ?? withdrawals.error;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Activity"
        description="Every deposit and withdrawal, with the state the ledger actually holds."
      />

      <Section title="Transactions" flush>
        {loading && rows.length === 0 ? (
          <div className="p-4">
            <Spinner label="Loading activity…" />
          </div>
        ) : error !== null ? (
          <div className="p-4">
            <ErrorNotice message={error} />
          </div>
        ) : rows.length > 0 ? (
          <ul className="divide-y divide-line">
            {rows.map((row) =>
              row.kind === 'deposit' ? (
                <li
                  key={`d-${row.deposit.id}`}
                  className="space-y-1 px-4 py-3 transition-colors duration-micro hover:bg-background-subtle"
                  data-testid="activity-deposit"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">Deposit</span>
                      <DepositStatusBadge status={row.deposit.status} />
                    </div>
                    <span className="font-mono text-sm font-semibold tabular-nums text-success">
                      +{formatAmount(row.deposit.creditedAmount, row.deposit.decimals)}{' '}
                      {labelOf(row.deposit.asset)}
                    </span>
                  </div>

                  <p className="text-xs text-ink-muted">
                    {new Date(row.deposit.createdAt).toLocaleString()} ·{' '}
                    <span className="font-mono">{shortenAddress(row.deposit.txSignature, 8)}</span>
                  </p>

                  {/*
                    Rule 158: the gap between what arrived and what was credited
                    is shown, not hidden. A user who sends 1 SOL and is credited
                    slightly less is owed an explanation.
                  */}
                  {!isZeroAmount(row.deposit.rentReserved) && (
                    <p className="text-xs text-ink-muted">
                      {formatAmount(row.deposit.amount, row.deposit.decimals)} received;{' '}
                      {formatAmount(row.deposit.rentReserved, row.deposit.decimals)} held back as a
                      one-time network account minimum, which is not withdrawable.
                    </p>
                  )}
                </li>
              ) : (
                <li
                  key={`w-${row.withdrawal.id}`}
                  className="space-y-1 px-4 py-3 transition-colors duration-micro hover:bg-background-subtle"
                  data-testid="activity-withdrawal"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">Withdrawal</span>
                      <WithdrawalStatusBadge status={row.withdrawal.status} />
                    </div>
                    <span className="font-mono text-sm font-semibold tabular-nums text-ink">
                      −{formatAmount(row.withdrawal.amount, row.withdrawal.decimals)}{' '}
                      {labelOf(row.withdrawal.asset)}
                    </span>
                  </div>

                  <p className="text-xs text-ink-muted">
                    {new Date(row.withdrawal.createdAt).toLocaleString()} · to{' '}
                    <span className="font-mono">
                      {shortenAddress(row.withdrawal.destination, 6)}
                    </span>
                    {row.withdrawal.txSignature !== null && (
                      <>
                        {' · '}
                        <span className="font-mono">
                          {shortenAddress(row.withdrawal.txSignature, 8)}
                        </span>
                      </>
                    )}
                  </p>

                  {/*
                    The network fee, once it is known. It is paid by the
                    platform and never deducted from the amount sent — saying
                    so is cheaper than being asked.
                  */}
                  {row.withdrawal.networkFee !== null &&
                    !isZeroAmount(row.withdrawal.networkFee) && (
                      <p className="text-xs text-ink-muted">
                        Network fee{' '}
                        {formatAmount(row.withdrawal.networkFee, row.withdrawal.decimals)}{' '}
                        {labelOf(row.withdrawal.asset)}, paid by the platform.
                      </p>
                    )}
                </li>
              ),
            )}
          </ul>
        ) : (
          <EmptyState
            title="No activity yet"
            body="Deposits appear here as soon as the network sees them, and are credited once finalized."
          />
        )}
      </Section>
    </div>
  );
}
