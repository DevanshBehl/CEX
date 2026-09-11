'use client';

import { EmptyState, PageHeader } from '@/components/ui';

export default function WalletPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Wallet" />
      <EmptyState
        title="Your wallet lives on the Deposit and Withdraw pages"
        body="Custody addresses are under Deposit, balances on the Dashboard, and sending under Withdraw."
      />
    </div>
  );
}
