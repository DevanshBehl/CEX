'use client';

import { useDeposits } from '@/features/custody/use-balances';
import { DepositStatusBadge } from '@/features/custody/balance-list';
import { formatAmount, isZeroAmount, shortenAddress } from '@/lib/format';
import { Card, EmptyState, ErrorNotice, Spinner, PageHeader } from '@/components/ui';

export default function ActivityPage() {
  const deposits = useDeposits(10_000);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Every deposit and withdrawal, with the state the ledger actually holds."
      />

      <Card>
        {deposits.loading ? (
          <Spinner label="Loading activity…" />
        ) : deposits.error !== null ? (
          <ErrorNotice message={deposits.error} />
        ) : deposits.data && deposits.data.length > 0 ? (
          <ul className="divide-y divide-line">
            {deposits.data.map((deposit) => (
              <li key={deposit.id} className="space-y-1 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Deposit</span>
                    <DepositStatusBadge status={deposit.status} />
                  </div>
                  <span className="font-mono text-sm tabular-nums">
                    +{formatAmount(deposit.creditedAmount, deposit.decimals)} {deposit.asset}
                  </span>
                </div>

                <p className="text-xs text-ink-muted">
                  {new Date(deposit.createdAt).toLocaleString()} ·{' '}
                  <span className="font-mono">{shortenAddress(deposit.txSignature, 8)}</span>
                </p>

                {/*
                  Rule 158: the gap between what arrived and what was credited
                  is shown, not hidden. A user who sends 1 SOL and is credited
                  slightly less is owed an explanation.
                */}
                {!isZeroAmount(deposit.rentReserved) && (
                  <p className="text-xs text-ink-muted">
                    {formatAmount(deposit.amount, deposit.decimals)} received;{' '}
                    {formatAmount(deposit.rentReserved, deposit.decimals)} held back as a one-time
                    network account minimum, which is not withdrawable.
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No activity yet"
            body="Deposits appear here as soon as the network sees them, and are credited once finalized."
          />
        )}
      </Card>
    </div>
  );
}
