'use client';

import { CLUSTER_DISPLAY, type PortfolioAllocation } from '@wallet/types';
import { useNetwork } from '@/features/network/network-context';
import { formatAmount, formatBps, formatDelta, formatUsd } from './format';
import { shortenAsset, useAssetLabel } from './use-asset-label';

/**
 * The segregated asset breakdown (Task 4).
 *
 * # Why each row links to an explorer
 *
 * Under segregated custody a user's funds sit at an address that is THEIRS
 * (ADR-0020). The whole claim of the model is that it can be checked from
 * outside, and a link to a block explorer — on the right cluster — is what
 * makes that more than a sentence in a document.
 */

function ExplorerAddressLink({ address }: { address: string }) {
  const { cluster } = useNetwork();
  if (cluster === undefined || cluster === 'localnet') return null;

  const query = CLUSTER_DISPLAY[cluster].explorerQuery;
  const href = `https://explorer.solana.com/address/${address}${
    query === '' ? '' : `?cluster=${query}`
  }`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="breakdown-explorer-link"
      className="font-mono text-2xs text-accent transition-colors duration-micro ease-atlas hover:underline"
    >
      {shortenAsset(address)} ↗
    </a>
  );
}

export function AssetBreakdown({
  allocations,
  address,
  loading,
}: {
  allocations: readonly PortfolioAllocation[];
  /** The user's segregated address on this cluster, when they have one. */
  address?: string | undefined;
  loading: boolean;
}) {
  const labelOf = useAssetLabel();

  return (
    <section className="atlas-raised overflow-hidden rounded-lg" data-testid="asset-breakdown">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Holdings</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Held at your own address on this network, not in a pool.
          </p>
        </div>
        {address !== undefined && <ExplorerAddressLink address={address} />}
      </header>

      {loading && allocations.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">Loading…</p>
      ) : allocations.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">Nothing held on this network yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-background-subtle text-left">
                {['Asset', 'Balance', 'Value', '24h', 'Share'].map((heading, index) => (
                  <th
                    key={heading}
                    scope="col"
                    className={['atlas-th px-4 py-2', index === 0 ? '' : 'text-right'].join(' ')}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allocations.map((allocation) => (
                <tr
                  key={allocation.asset}
                  data-testid="breakdown-row"
                  className="border-b border-line/60 transition-colors duration-micro last:border-0 hover:bg-background-subtle"
                >
                  <td className="px-4 py-3">
                    <span className="font-semibold text-ink" data-testid="breakdown-symbol">
                      {labelOf(allocation.asset, allocation.symbol)}
                    </span>
                    {/*
                      The mint under the ticker, abbreviated. A symbol is not
                      an identity — anyone can mint a token calling itself
                      USDC (ADR-0016) — so the address stays visible.
                    */}
                    {labelOf(allocation.asset, allocation.symbol) !== allocation.asset && (
                      <span className="ml-2 font-mono text-2xs text-ink-disabled">
                        {shortenAsset(allocation.asset)}
                      </span>
                    )}
                  </td>

                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-secondary">
                    {formatAmount(allocation.amount, allocation.decimals)}
                  </td>

                  <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-ink">
                    {allocation.valueUsd === null ? (
                      // NOT "$0.00". A holding nothing can price is not worth
                      // nothing, and saying so would understate what someone
                      // has.
                      <span className="text-ink-disabled">No price</span>
                    ) : (
                      formatUsd(allocation.valueUsd)
                    )}
                  </td>

                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {allocation.changeUsd === null ? (
                      <span className="text-ink-disabled">—</span>
                    ) : (
                      <span
                        className={
                          allocation.changeUsd.startsWith('-') ? 'text-danger' : 'text-success'
                        }
                      >
                        {formatDelta(allocation.changeUsd)}
                      </span>
                    )}
                  </td>

                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-muted">
                    {allocation.valueUsd === null
                      ? '—'
                      : formatBps(allocation.shareBps).replace('+', '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
