'use client';

import { useCallback } from 'react';
import { ledgerAssetKey } from '@wallet/types';
import { useCapabilities } from '@/features/platform/use-capabilities';
import { useNetwork } from '@/features/network/network-context';

/**
 * What to call an asset (Task 4).
 *
 * # The bug this exists to close
 *
 * The dashboard rendered `5qtUNGVQ1e8jg8Rtpz5CbYFkkm4KbwndYgr17SrhA7vy` where
 * a ticker belongs, because the balance row carried a mint address and nothing
 * looked up its name.
 *
 * There are two sources for that name and this prefers the nearer one:
 *
 *   1. The `symbol` the endpoint sent. The server holds the allowlist, so this
 *      is authoritative and always right for an asset the platform credits.
 *   2. `capabilities.assets.labels`, keyed by CLUSTER-QUALIFIED asset. This
 *      covers a row that arrived without one — a de-allowlisted mint the user
 *      still holds, or an older response shape.
 *
 * The mint itself is the last resort. A row that cannot be named still has to
 * render: a balance that exists must be visible, even if all we can say about
 * it is its address.
 */
export function useAssetLabel(): (asset: string, symbol?: string) => string {
  const capabilities = useCapabilities();
  const { cluster } = useNetwork();

  return useCallback(
    (asset: string, symbol?: string) => {
      if (symbol !== undefined && symbol !== '' && symbol !== asset) return symbol;

      if (capabilities !== undefined && cluster !== undefined) {
        // The labels map is keyed the way the ledger is: `devnet:<mint>`.
        const label = capabilities.assets.labels[ledgerAssetKey(cluster, asset)];
        if (label !== undefined && label !== '') return label;
      }

      return asset;
    },
    [capabilities, cluster],
  );
}

/** A mint, shortened for display. Never used where the full value is needed. */
export function shortenAsset(asset: string): string {
  return asset.length > 12 ? `${asset.slice(0, 4)}…${asset.slice(-4)}` : asset;
}
