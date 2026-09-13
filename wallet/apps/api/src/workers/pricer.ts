import { createPriceRepository, type PrismaClient } from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import { parseLedgerAssetKey, type AssetRegistry, type Cluster } from '@wallet/types';
import type { PriceSource } from '../services/prices/source.js';

/**
 * The price ingestion worker (Task 3).
 *
 * # What it does, and the two things it refuses to do
 *
 * It polls one source for the assets this deployment allowlists and appends a
 * tick per (cluster, asset). That is all.
 *
 * It does NOT interpolate. A cycle that fails writes nothing, so the most
 * recent tick stays the most recent tick and a chart simply stops advancing.
 * Filling the gap with the previous value would manufacture evidence that the
 * price held steady, which is a different claim from "we do not know".
 *
 * It does NOT write a tick per cluster from separate requests. One fetch per
 * cycle is fanned out across clusters, so devnet and mainnet see the SAME
 * observation of the same market — otherwise two charts of the same asset
 * disagree by whatever moved between two HTTP calls, and the difference looks
 * like a bug in the ledger.
 */

export interface PricerDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly source: PriceSource;
  /** Which assets to price, per cluster. */
  readonly clusters: ReadonlyMap<Cluster, AssetRegistry>;
  readonly intervalMs: number;
}

export interface Pricer {
  /** One cycle. Returns how many ticks were written. */
  runOnce(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createPricer(deps: PricerDeps): Pricer {
  const prices = createPriceRepository(deps.db);
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  /**
   * Symbols to ask for, and where each answer goes.
   *
   * Keyed by symbol because that is what a feed indexes — a mint address is
   * per cluster and no feed carries it. One symbol can map to several
   * (cluster, asset) rows: `USDC` is a different mint on devnet and mainnet
   * and the same market for both.
   */
  function targets(): Map<string, Array<{ cluster: Cluster; asset: string }>> {
    const bySymbol = new Map<string, Array<{ cluster: Cluster; asset: string }>>();

    for (const [cluster, registry] of deps.clusters) {
      for (const key of registry.keys) {
        const symbol = registry.symbolOf(key).toUpperCase();
        const { asset } = parseLedgerAssetKey(key);

        const existing = bySymbol.get(symbol);
        if (existing) existing.push({ cluster, asset });
        else bySymbol.set(symbol, [{ cluster, asset }]);
      }
    }

    return bySymbol;
  }

  return {
    async runOnce(): Promise<number> {
      const bySymbol = targets();
      if (bySymbol.size === 0) return 0;

      let quotes;
      try {
        quotes = await deps.source.fetch([...bySymbol.keys()].map((symbol) => ({ symbol })));
      } catch (error) {
        /*
         * A failed cycle is an ordinary condition, not an incident: feeds rate
         * limit, and the last tick remains valid. Logged at warn, and the
         * REASON is a class name rather than the message, which can carry the
         * endpoint and therefore an API key.
         */
        deps.logger.warn('price fetch failed', {
          event: 'pricer.fetch_failed',
          outcome: 'failure',
          source: deps.source.name,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return 0;
      }

      const recordedAt = new Date();
      const ticks = quotes.flatMap((quote) =>
        (bySymbol.get(quote.symbol.toUpperCase()) ?? []).map((target) => ({
          cluster: target.cluster,
          asset: target.asset,
          priceUsd: quote.priceUsd,
          source: deps.source.name,
          // OUR clock, not the feed's. `observedAt` can be minutes old on a
          // thin market, and a tick timestamped in the past would sit behind
          // buckets that have already been valued.
          recordedAt,
        })),
      );

      if (ticks.length === 0) {
        deps.logger.warn('price source returned nothing usable', {
          event: 'pricer.empty',
          outcome: 'failure',
          source: deps.source.name,
        });
        return 0;
      }

      const written = await prices.record(ticks);

      // No amounts and no prices in the log line: this is an operational
      // record that the worker ran, not a copy of the data (rule 90).
      logSecurityEvent(deps.logger, 'pricer.recorded', {
        outcome: 'success',
        count: written,
        targetType: 'price_source',
        targetId: deps.source.name,
      });

      return written;
    },

    start() {
      if (timer !== undefined) return;

      const tick = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
          await this.runOnce();
        } catch (error) {
          deps.logger.error('price cycle failed', {
            event: 'pricer.cycle_failed',
            outcome: 'failure',
            errorName: error instanceof Error ? error.name : 'unknown',
          });
        } finally {
          running = false;
        }
      };

      // Immediately, then on the interval: a fresh deployment should not show
      // an unpriced portfolio for the first five minutes.
      void tick();
      timer = setInterval(() => void tick(), deps.intervalMs);
    },

    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
