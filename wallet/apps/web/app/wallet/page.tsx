'use client';

import { EmptyState } from '@/components/ui';

export default function WalletPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Wallet</h1>
      <EmptyState
        title="Your wallet is on the Deposit page"
        body="Custody addresses and balances now live under Deposit and Dashboard. This page becomes the withdrawal surface in Phase 3."
        phase="Phase 3"
      />
    </div>
  );
}
