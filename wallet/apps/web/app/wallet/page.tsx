'use client';

import { EmptyState } from '@/components/ui';

export default function WalletPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Wallet</h1>
      <EmptyState
        title="Your wallet lives on the Deposit and Withdraw pages"
        body="Custody addresses are under Deposit, balances on the Dashboard, and sending under Withdraw."
      />
    </div>
  );
}
