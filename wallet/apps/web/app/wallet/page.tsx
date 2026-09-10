'use client';

import { EmptyState } from '@/components/ui';

export default function WalletPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Wallet</h1>
      <EmptyState
        title="No wallet exists yet"
        body="Custody records, Solana address management, and deposit addresses arrive with Phase 2, alongside the ledger that accounts for them."
        phase="Phase 2"
      />
    </div>
  );
}
