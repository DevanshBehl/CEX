'use client';

import type { Balance, Deposit } from '@wallet/types';
import { formatAmount, isZeroAmount } from '@/lib/format';
import { StatusBadge } from '@/components/ui';

/**
 * Presentation only (rule 163). It receives balances and renders them; it does
 * not fetch, and it does not compute.
 *
 * The ROW is the unit, not a card. A balance list is tabular data (§20): the
 * asset on the left, the figure hard-right in tabular monospace so a column of
 * them aligns on the decimal. Reserved funds sit beneath the asset as a muted
 * line rather than a second column, because they are the exception and giving
 * them equal weight would imply they are not.
 */
export function BalanceList({ balances }: { balances: readonly Balance[] }) {
  return (
    <ul className="divide-y divide-line">
      {balances.map((balance) => (
        <li
          key={balance.asset}
          className="group flex items-center justify-between gap-4 py-4 transition-colors duration-micro ease-atlas"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{balance.asset}</p>
            {!isZeroAmount(balance.locked) && (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-warning">
                <span aria-hidden="true" className="h-1 w-1 rounded-full bg-warning" />
                {formatAmount(balance.locked, balance.decimals)} reserved
              </p>
            )}
          </div>
          <p className="shrink-0 font-mono text-lg tracking-[-0.01em] text-ink">
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
