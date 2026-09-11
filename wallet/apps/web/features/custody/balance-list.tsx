'use client';

import type { Balance, Deposit } from '@wallet/types';
import { formatAmount, isZeroAmount } from '@/lib/format';
import { StatusBadge } from '@/components/ui';

/**
 * Presentation only (rule 163). It receives balances and renders them; it does
 * not fetch, and it does not compute.
 */
export function BalanceList({ balances }: { balances: readonly Balance[] }) {
  return (
    <ul className="divide-y divide-line">
      {balances.map((balance) => (
        <li key={balance.asset} className="flex items-baseline justify-between gap-4 py-3">
          <div>
            <p className="text-sm font-medium">{balance.asset}</p>
            {!isZeroAmount(balance.locked) && (
              <p className="text-xs text-muted">
                {formatAmount(balance.locked, balance.decimals)} reserved
              </p>
            )}
          </div>
          <p className="font-mono text-sm tabular-nums">
            {formatAmount(balance.available, balance.decimals)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Deposit lifecycle, shown honestly (rules 173-174).
 *
 * `confirming` is deliberately NOT presented as a balance. The ledger has not
 * moved, so the user has not been credited, and saying otherwise would mean
 * taking it back if the transaction were dropped on a fork.
 */
export function DepositStatusBadge({ status }: { status: Deposit['status'] }) {
  if (status === 'credited') return <StatusBadge tone="good">Credited</StatusBadge>;
  if (status === 'confirming') return <StatusBadge tone="warn">Confirming</StatusBadge>;
  return <StatusBadge tone="neutral">Not credited</StatusBadge>;
}
