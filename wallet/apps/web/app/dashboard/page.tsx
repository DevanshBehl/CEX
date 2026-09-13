'use client';

import Link from 'next/link';
import { useSession } from '@/hooks/use-session';
import { useBalances } from '@/features/custody/use-balances';
import { useWithdrawals } from '@/features/withdrawal/use-withdrawals';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { AssetMark } from '@/components/crypto';
import { formatAmount, isZeroAmount, shortenAddress } from '@/lib/format';
import {
  ActionTile,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Section,
  Skeleton,
  StatCard,
  StatusBadge,
  SystemNote,
} from '@/components/ui';
import { useCapabilities } from '@/features/platform/use-capabilities';
import { usePortfolioSummary } from '@/features/portfolio/use-portfolio';
import { PortfolioChart } from '@/features/portfolio/portfolio-chart';
import { AssetBreakdown } from '@/features/portfolio/asset-breakdown';
import { useAssetLabel } from '@/features/portfolio/use-asset-label';
import { formatBps, formatDelta, formatUsd } from '@/features/portfolio/format';

const DEPOSIT_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
  >
    <path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5M4 20h16" />
  </svg>
);

const WITHDRAW_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
  >
    <path d="M12 20V8m0 0L7.5 12.5M12 8l4.5 4.5M4 4h16" />
  </svg>
);

export default function DashboardPage() {
  const { state } = useSession();
  // Polled: a deposit takes ~13 seconds to finalize, so the balance changes
  // while the user is looking at it.
  const balances = useBalances(10_000);
  const withdrawals = useWithdrawals(15_000);
  const capabilities = useCapabilities();
  // Polled on the same cadence as balances: a valuation that lagged the
  // balance beside it reads as one of the two being wrong.
  const summary = usePortfolioSummary(10_000);
  const labelOf = useAssetLabel();

  const changeTone =
    summary.data?.changeBps === null || summary.data === null
      ? 'default'
      : summary.data.changeBps < 0
        ? 'warning'
        : 'accent';

  if (state.status !== 'authenticated') return null;
  const { user, factors } = state.data;

  const assets = balances.data ?? [];
  const reserved = assets.filter((b) => !isZeroAmount(b.locked));
  const recent = (withdrawals.data ?? []).slice(0, 4);

  return (
    <div className="animate-fade-up space-y-3">
      <PageHeader
        title="Dashboard"
        description="Your balances, and everything currently in flight."
      />

      {/*
        §8: a grid of statistics.
        
        The portfolio value is REAL now — projected from the ledger and
        multiplied by a recorded spot price (Task 3). It was absent before
        because there was no price feed, and a fabricated number in a wallet is
        worse than no number at all. That rule has not changed: where a price
        is genuinely unknown this still says so rather than showing $0.00.
      */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Portfolio value"
          value={
            summary.data === null
              ? '—'
              : summary.data.complete || summary.data.totalUsd !== '0.000000'
                ? formatUsd(summary.data.totalUsd)
                : 'No price'
          }
          loading={summary.loading}
          tone={changeTone}
          hint={
            summary.data === null
              ? 'Valuation unavailable'
              : summary.data.changeUsd === null
                ? 'No comparison yet'
                : `${formatDelta(summary.data.changeUsd)}${
                    summary.data.changeBps === null ? '' : ` · ${formatBps(summary.data.changeBps)}`
                  } in 24h`
          }
        />
        <StatCard
          label="Assets held"
          value={String(assets.length)}
          loading={balances.loading}
          hint={assets.length === 0 ? 'Deposit to get started' : 'Supported on this network'}
        />
        <StatCard
          label="Reserved"
          value={String(reserved.length)}
          tone={reserved.length > 0 ? 'warning' : 'default'}
          loading={balances.loading}
          hint="Locked against a pending withdrawal"
        />
        <StatCard
          label="In flight"
          value={String(
            (withdrawals.data ?? []).filter(
              (w) => w.status !== 'SETTLED' && w.status !== 'FAILED' && w.status !== 'REJECTED',
            ).length,
          )}
          loading={withdrawals.loading}
          hint="Withdrawals not yet settled"
        />
      </div>

      <PortfolioChart />

      {/*
        No `address` here, deliberately.
        
        Obtaining it means POSTing to /wallets/addresses, which under
        segregated custody PROVISIONS A THRESHOLD KEY (ADR-0020). Doing that
        for everyone who opens a dashboard would run a ceremony per user who
        never asked to deposit. The address — and its explorer link — lives on
        the deposit page, where asking for one is the point.
      */}
      <AssetBreakdown allocations={summary.data?.allocations ?? []} loading={summary.loading} />

      <div className="grid items-start gap-3 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          <Section
            title="Balances"
            description="Available to spend, excluding anything reserved."
            flush
            action={
              <Link href="/activity" className="text-xs font-semibold text-accent hover:underline">
                View activity →
              </Link>
            }
          >
            {balances.loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            ) : balances.error !== null ? (
              <div className="p-4">
                <ErrorNotice message={balances.error} />
              </div>
            ) : assets.length > 0 ? (
              <ul className="divide-y divide-line">
                {assets.map((balance) => (
                  <li
                    key={balance.asset}
                    className="flex items-center gap-3 px-4 py-3 transition-colors duration-micro hover:bg-background-subtle"
                  >
                    <AssetMark symbol={labelOf(balance.asset, balance.symbol)} />
                    <div className="min-w-0 flex-1">
                      {/*
                        The SYMBOL, not the mint. This rendered a 44-character
                        base58 address until the response carried a name for
                        it (Task 4).
                      */}
                      <p className="text-sm font-semibold text-ink">
                        {labelOf(balance.asset, balance.symbol)}
                      </p>
                      {!isZeroAmount(balance.locked) && (
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-warning">
                          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-warning" />
                          {formatAmount(balance.locked, balance.decimals)} reserved
                        </p>
                      )}
                    </div>
                    <p className="shrink-0 font-mono text-sm font-semibold text-ink">
                      {formatAmount(balance.available, balance.decimals)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No balances yet"
                body="Deposit SOL to your address and it will appear here once the network finalizes it."
              />
            )}
          </Section>

          <div className="grid gap-3 sm:grid-cols-2">
            <ActionTile
              href="/deposit"
              title="Deposit"
              description="Get your permanent address and send funds to it."
              icon={DEPOSIT_ICON}
              primary
            />
            <ActionTile
              href="/withdraw"
              title="Withdraw"
              description="Send to an external address, after risk review."
              icon={WITHDRAW_ICON}
            />
          </div>
        </div>

        <div className="space-y-3">
          <Section
            title="Recent withdrawals"
            action={
              recent.length > 0 ? (
                <Link
                  href="/withdraw"
                  className="text-xs font-semibold text-accent hover:underline"
                >
                  All →
                </Link>
              ) : undefined
            }
          >
            {withdrawals.loading ? (
              <Skeleton className="h-20 w-full rounded-lg" />
            ) : recent.length > 0 ? (
              <ul className="divide-y divide-line">
                {recent.map((w) => (
                  <li key={w.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm text-ink">
                        −{formatAmount(w.amount, w.decimals)} {w.asset}
                      </span>
                      <WithdrawalStatusBadge status={w.status} />
                    </div>
                    <p className="mt-1 font-mono text-2xs text-ink-muted">
                      to {shortenAddress(w.destination, 6)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-2 text-sm text-ink-muted">Nothing sent yet.</p>
            )}
          </Section>

          {/*
            What signing ACTUALLY is, read from the platform rather than
            asserted here (rules 236-237).

            The sidebar carries a permanent one-line indicator, but the sidebar
            is hidden below `lg` — so relying on it alone left mobile users
            with NO disclosure at all. master-prompt rule 8 is not a
            breakpoint-dependent requirement, so the full statement lives in
            the page body where every viewport sees it.

            While capabilities are unknown the cautious copy is shown: if the
            platform cannot say what its signing is, the weaker claim is the
            honest one. Neither branch ever says "production-safe".
          */}
          {capabilities?.signing.mode === 'threshold-mpc' ? (
            <SystemNote label="Custody" title="Signing is 3-of-5 threshold">
              Withdrawals are signed by five separate participants, any three of which suffice. No
              single machine holds a whole key, each participant verifies the approval proof itself,
              and none of them returns key material. The participants run as five processes rather
              than on five hosts, so the independence is not yet real. This system has not been
              audited.
            </SystemNote>
          ) : capabilities?.signing.mode === 'single-key-mpc' ? (
            <SystemNote label="Custody" title="Signing is real, and it is a single key">
              Withdrawals are signed by a separate service that holds the key, verifies an approval
              proof bound to the exact transaction, and never returns key material. It is not yet
              threshold signing: one compromised host would still yield the key. This system has not
              been audited.
            </SystemNote>
          ) : (
            <SystemNote label="Custody" title="Signing is not real yet" tone="warning">
              Withdrawals run the full lifecycle — risk checks, fund locking, signing, broadcast and
              settlement — but the signer is a clearly-labelled mock that produces signatures
              verifying against nothing.
            </SystemNote>
          )}

          <Section title="Account">
            <dl className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-xs text-ink-muted">Status</dt>
                <dd>
                  <StatusBadge tone={user.status === 'active' ? 'good' : 'warn'}>
                    {user.status}
                  </StatusBadge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-xs text-ink-muted">Sign-in</dt>
                <dd className="text-xs text-ink-secondary">
                  {factors.length > 0 ? factors.join(', ') : 'none'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-xs text-ink-muted">Member since</dt>
                <dd className="font-mono text-xs text-ink-secondary">
                  {new Date(user.createdAt).toLocaleDateString()}
                </dd>
              </div>
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
