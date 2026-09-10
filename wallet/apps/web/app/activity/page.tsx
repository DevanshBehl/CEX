'use client';

import { EmptyState } from '@/components/ui';

export default function ActivityPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Activity</h1>
      <EmptyState
        title="No transactions yet"
        body="Deposits appear here in Phase 2 and withdrawals in Phase 3, each showing its full lifecycle state rather than a single 'pending' label."
        phase="Phase 2"
      />
    </div>
  );
}
