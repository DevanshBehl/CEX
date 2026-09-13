'use client';

import { useEffect, useState } from 'react';
import type { DepositAddress } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import {
  ErrorNotice,
  PageHeader,
  Section,
  Spinner,
  StatusBadge,
  SystemNote,
} from '@/components/ui';
import { AddressDisplay } from '@/components/crypto';
import { CLUSTER_DISPLAY, type Cluster } from '@wallet/types';
import { FaucetPanel } from '@/features/network/faucet-panel';
import { AssetBreakdown } from '@/features/portfolio/asset-breakdown';
import { usePortfolioSummary } from '@/features/portfolio/use-portfolio';
import { useNetwork } from '@/features/network/network-context';

export default function DepositPage() {
  const [address, setAddress] = useState<DepositAddress | null>(null);
  /*
   * A deposit address is PER CLUSTER (ADR-0021): the same user has a different
   * one on each, and showing a devnet address while the pill says Mainnet is
   * how someone sends real SOL somewhere it cannot be recovered from.
   */
  const { version, ready, cluster } = useNetwork();
  const summary = usePortfolioSummary();
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setAddress(null);
    setError(null);
    void (async () => {
      try {
        const result = await api.getDepositAddress();
        if (!cancelled) setAddress(result.address);
      } catch (e) {
        if (!cancelled) {
          setError({
            message: e instanceof Error ? e.message : 'Could not get a deposit address.',
            correlationId: e instanceof ApiError ? e.correlationId : null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version, ready, cluster]);

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Deposit"
        description="Your address is permanent. Send to it as many times as you like."
      />

      {error !== null && (
        <div className="mb-8 max-w-2xl">
          <ErrorNotice message={error.message} correlationId={error.correlationId} />
        </div>
      )}

      {address === null && error === null ? (
        <Spinner label="Preparing your deposit address…" />
      ) : address !== null ? (
        <div className="grid gap-10 lg:grid-cols-3 lg:gap-12">
          <div className="lg:col-span-2">
            {/*
              Rule 172: the asset and the network are stated unambiguously and
              BEFORE the address. Sending an asset on the wrong network is the
              most common way users lose funds, and a vague label is a
              contributing cause — so this warning is not a footnote under the
              address, it is the thing you read first.
            */}
            <Section
              title={`Send ${address.asset} only`}
              action={
                <div className="flex items-center gap-2">
                  <StatusBadge tone="warn">{address.asset}</StatusBadge>
                  <StatusBadge tone="neutral">{address.network}</StatusBadge>
                </div>
              }
            >
              <p className="max-w-prose text-sm leading-relaxed text-ink-secondary">
                This address accepts{' '}
                <strong className="font-medium text-ink">{address.asset}</strong> on the{' '}
                <strong className="font-medium text-ink">{address.network}</strong> network only.
                Anything else sent here may be permanently lost.
              </p>

              {/*
                Copying is part of the address component, not a button beside
                it. "Select 44 characters by hand" is how a transposition error
                happens, and the affordance belongs where the risk is.
              */}
              <div className="mt-5 max-w-xl">
                <AddressDisplay
                  address={address.address}
                  testId="deposit-address"
                  label={`Your ${address.asset} address · ${address.network}`}
                />
              </div>

              <div className="mt-4">
                <ExplorerLink value={address.address} cluster={cluster} />
              </div>

              {/* Test clusters only; nothing is rendered on mainnet. */}
              <div className="mt-6 max-w-xl">
                <FaucetPanel address={address.address} />
              </div>

              {/*
                What is actually held AT this address (ADR-0020, Task 4).
                
                Beside the address rather than only on the dashboard: the claim
                segregated custody makes is that these funds are at an address
                that is the user's, and the two facts are worth seeing
                together.
              */}
              <div className="mt-6">
                <AssetBreakdown
                  allocations={summary.data?.allocations ?? []}
                  address={address.address}
                  loading={summary.loading}
                />
              </div>
            </Section>
          </div>

          <aside className="space-y-8">
            <Section title="What happens next">
              {/*
                §29: a numbered sequence as a rail, not a bulleted list. The
                index sits in mono at a fixed width so the steps align, which
                is what makes a process read as a process.
              */}
              <ol className="space-y-4">
                {[
                  <>Send {address.asset} to the address from any wallet or exchange.</>,
                  <>
                    It appears as <strong className="font-medium text-ink">Confirming</strong> once
                    the network has seen it.
                  </>,
                  <>
                    It is credited once the network has{' '}
                    <strong className="font-medium text-ink">finalized</strong> it — usually within
                    a minute. Until then it is not spendable, because a transaction below finality
                    can still be reversed.
                  </>,
                ].map((step, index) => (
                  <li key={index} className="flex gap-3">
                    <span className="mt-px shrink-0 font-mono text-2xs text-ink-disabled">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="text-xs leading-relaxed text-ink-muted">{step}</span>
                  </li>
                ))}
              </ol>
            </Section>

            <SystemNote label="One-time" title="A small network minimum is held back">
              Your first deposit to this address reserves the network&apos;s account minimum. It is
              shown separately on the Activity page and is never counted as your balance.
            </SystemNote>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A QR code rendered as an SVG, with no dependency.
 *
 * A full QR encoder is a real library; this deliberately is not one. It renders
 * a placeholder that makes the address scannable-looking only when a proper
 * encoder is wired in. Rather than ship a fake that appears to work and does
 * not, it links out until then.
 */
/**
 * A link to this address on a block explorer, ON THE RIGHT CLUSTER.
 *
 * Without the cluster the link always resolves to mainnet, where a devnet
 * address either does not exist or — worse — is a DIFFERENT account that
 * happens to occupy that address. Either way the page contradicts the one the
 * user is looking at (ADR-0021).
 *
 * `localnet` gets no link at all: a local validator is not on any explorer,
 * and a link that always 404s is worse than none.
 */
function ExplorerLink({ value, cluster }: { value: string; cluster: Cluster | undefined }) {
  if (cluster === undefined || cluster === 'localnet') return null;

  const query = CLUSTER_DISPLAY[cluster].explorerQuery;
  const href = `https://explorer.solana.com/address/${value}${
    query === '' ? '' : `?cluster=${query}`
  }`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm text-accent transition-colors duration-micro ease-atlas hover:text-accent-strong"
    >
      View on explorer
    </a>
  );
}
