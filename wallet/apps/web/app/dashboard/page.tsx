'use client';

import Link from 'next/link';
import { useSession } from '@/hooks/use-session';
import { useBalances } from '@/features/custody/use-balances';
import { BalanceList } from '@/features/custody/balance-list';
import { Button, Card, EmptyState, ErrorNotice, Spinner, StatusBadge } from '@/components/ui';
import { useCapabilities } from '@/features/platform/use-capabilities';

export default function DashboardPage() {
  const { state } = useSession();
  // Polled: a deposit takes ~13 seconds to finalize, so the balance changes
  // while the user is looking at it.
  const balances = useBalances(10_000);
  const capabilities = useCapabilities();

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
              <Link href="/withdraw">
                <Button variant="secondary">Withdraw</Button>
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

      {/*
        What signing ACTUALLY is, read from the platform rather than asserted
        here (rules 236-237).

        This block used to say "the signer is a mock". That was true in Phase 3
        and became false the moment a real signing service shipped — a
        hardcoded claim about custody that quietly goes stale is worse than no
        claim, because people rely on it.

        While capabilities are unknown the cautious copy is shown: if the
        platform cannot say what its signing is, the weaker claim is the honest
        one. And neither branch ever says "production-safe" — master-prompt
        rule 8.
      */}
      {capabilities?.signing.mode === 'single-key-mpc' ? (
        <EmptyState
          title="Signing is real, and it is a single key"
          body="Withdrawals are signed by a separate service that holds the key, verifies an approval proof bound to the exact transaction, and never returns key material. It is not yet threshold signing: one compromised host would still yield the key. This system has not been audited."
          phase="Phase 4"
        />
      ) : (
        <EmptyState
          title="Signing is not real yet"
          body="Withdrawals run the full lifecycle — risk checks, fund locking, signing, broadcast and settlement — but the signer is a clearly-labelled mock that produces signatures verifying against nothing."
          phase="Phase 4"
        />
      )}
    </div>
  );
}
