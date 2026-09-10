'use client';

import { useSession } from '@/hooks/use-session';
import { Card, EmptyState, StatusBadge } from '@/components/ui';

export default function DashboardPage() {
  const { state } = useSession();
  if (state.status !== 'authenticated') return null;
  const { user, factors } = state.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Signed in as {user.email ?? user.displayName ?? user.id}
        </p>
      </div>

      <Card title="Account">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
            <dd className="mt-1">
              <StatusBadge tone={user.status === 'active' ? 'good' : 'warn'}>
                {user.status}
              </StatusBadge>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Sign-in methods</dt>
            <dd className="mt-1 text-sm">{factors.length > 0 ? factors.join(', ') : 'none'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Member since</dt>
            <dd className="mt-1 text-sm">{new Date(user.createdAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      </Card>

      {/*
        Rule 157: no fake balance, no sample transactions. A plausible number
        that is not real is worse than no number, and this is a wallet.
      */}
      <EmptyState
        title="No balances yet"
        body="Wallets, deposit addresses, and the double-entry ledger are Phase 2. Nothing here is a placeholder for a real balance — there is genuinely nothing to show."
        phase="Phase 2"
      />
    </div>
  );
}
