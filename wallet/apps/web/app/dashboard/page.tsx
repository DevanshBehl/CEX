'use client';

import Link from 'next/link';
import { useSession } from '@/hooks/use-session';
import { useBalances } from '@/features/custody/use-balances';
import { BalanceList } from '@/features/custody/balance-list';
import { Button, Card, EmptyState, ErrorNotice, Spinner, StatusBadge } from '@/components/ui';

export default function DashboardPage() {
  const { state } = useSession();
  // Polled: a deposit takes ~13 seconds to finalize, so the balance changes
  // while the user is looking at it.
  const balances = useBalances(10_000);

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

      <Card title="Balances">
        {balances.loading ? (
          <Spinner label="Loading balances…" />
        ) : balances.error !== null ? (
          <ErrorNotice message={balances.error} />
        ) : balances.data && balances.data.length > 0 ? (
          <>
            <BalanceList balances={balances.data} />
            <div className="mt-4 flex gap-3">
              <Link href="/deposit">
                <Button>Deposit</Button>
              </Link>
              <Link href="/activity">
                <Button variant="secondary">Activity</Button>
              </Link>
            </div>
          </>
        ) : (
          <EmptyState title="No balances yet" body="Make a deposit to get started." />
        )}
      </Card>

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

      {/* Withdrawals are Phase 3. Saying so beats a disabled button. */}
      <EmptyState
        title="Withdrawals are not available yet"
        body="Money can arrive and be accounted for, but cannot leave. Withdrawals need transaction signing, risk checks, and fund locking — all of which arrive in Phase 3."
        phase="Phase 3"
      />
    </div>
  );
}
