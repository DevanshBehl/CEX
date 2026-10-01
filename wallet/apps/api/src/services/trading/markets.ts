import type { Logger } from '@wallet/logger';
import {
  createMarket,
  ledgerAssetKey,
  parseLedgerAssetKey,
  type AssetRegistry,
  type Cluster,
  type Market,
  type MarketStatus,
} from '@wallet/types';
import type { EngineClient } from './engine-client.js';

/**
 * Markets, and whether the gateway may route to each (prompt_phase_s3.md §9).
 *
 * Markets are static configuration, validated at boot into frozen structures
 * with `createMarket` — which refuses a market whose assets span clusters.
 *
 * # The engine holds its own copy of each market, and they must agree
 *
 * A gateway validating against a tick the engine does not share accepts
 * orders the engine rejects, and every one of them takes a hold and then
 * releases it (rule 89). So the gateway compares tick, lot, minimum notional
 * and collar against the engine's own `/v1/health` and REFUSES TO ROUTE a
 * market that disagrees.
 *
 * Refuses to route — not refuses to start. A misconfigured market must not take
 * down deposits and withdrawals, which share this process. An engine that
 * cannot be reached is checked again on the next request rather than being
 * trusted blind.
 */

export interface MarketEntry {
  /** Bare symbol, as the wire speaks it. */
  readonly symbol: string;
  readonly market: Market;
  readonly engine: EngineClient;
  readonly baseSymbol: string;
  readonly quoteSymbol: string;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
}

export type Routability =
  | { readonly ok: true; readonly market: Market }
  | {
      readonly ok: false;
      readonly reason: 'unknown_market' | 'engine_unreachable' | 'engine_disagrees';
    };

export interface MarketRegistry {
  readonly entries: readonly MarketEntry[];
  get(symbol: string): MarketEntry | undefined;
  /**
   * The market as the ENGINE currently has it — live status included — or a
   * reason it cannot be routed to. Status changes at runtime (a halt), so it is
   * read from the engine with a short cache rather than from configuration.
   */
  routable(symbol: string): Promise<Routability>;
  /** Run the agreement check for every market now. Called at boot. */
  verifyAll(): Promise<void>;
}

export interface MarketRegistryDeps {
  readonly cluster: Cluster;
  readonly assets: AssetRegistry;
  readonly markets: ReadonlyArray<{
    readonly symbol: string;
    readonly tickSize: string;
    readonly lotSize: string;
    readonly minNotional: string;
    readonly collarBps: number;
  }>;
  readonly engines: ReadonlyMap<string, EngineClient>;
  readonly logger: Logger;
  readonly statusTtlMs?: number;
  readonly clock?: () => number;
}

/**
 * Resolve `SOL` or `USDC` to its ledger key on this cluster, via the allowlist.
 *
 * REFUSES AN AMBIGUOUS SYMBOL. Tokens are identified by mint, never by symbol,
 * because anyone can create a token called USDC (ADR-0016). If two allowlisted
 * mints share a symbol, a market named by that symbol does not say which one
 * it trades — and picking the first silently would hold one while the user was
 * credited in the other. This first picked silently; a test caught it with two
 * tokens both named USDC.
 */
function assetBySymbol(assets: AssetRegistry, symbol: string): string {
  const matches = assets.keys.filter((k) => assets.symbolOf(k) === symbol);
  if (matches.length === 0) {
    throw new Error(
      `market asset ${symbol} is not allowlisted on ${assets.cluster}; a market may only ` +
        'trade assets the platform can custody (ADR-0016)',
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `market asset ${symbol} is ambiguous on ${assets.cluster}: ${String(matches.length)} ` +
        'allowlisted mints share that symbol. Tokens are identified by mint, not by name ' +
        '(ADR-0016) — give each a distinct symbol before trading it.',
    );
  }
  return matches[0]!;
}

export function createMarketRegistry(deps: MarketRegistryDeps): MarketRegistry {
  const ttl = deps.statusTtlMs ?? 2_000;
  const clock = deps.clock ?? (() => Date.now());

  const entries: MarketEntry[] = deps.markets.map((definition) => {
    const [base = '', quote = ''] = definition.symbol.split('-');
    const baseAsset = assetBySymbol(deps.assets, base);
    const quoteAsset = assetBySymbol(deps.assets, quote);
    const engine = deps.engines.get(definition.symbol);
    if (!engine) throw new Error(`no engine configured for ${definition.symbol}`);
    return {
      symbol: definition.symbol,
      market: createMarket({
        cluster: deps.cluster,
        symbol: definition.symbol,
        baseAsset,
        quoteAsset,
        tickSize: definition.tickSize,
        lotSize: definition.lotSize,
        minNotional: definition.minNotional,
        collarBps: definition.collarBps,
        // Placeholder until the engine is asked; `routable` supplies the live one.
        status: 'pre_open',
      }),
      engine,
      baseSymbol: base,
      quoteSymbol: quote,
      baseDecimals: deps.assets.decimalsOf(baseAsset),
      quoteDecimals: deps.assets.decimalsOf(quoteAsset),
    };
  });

  const bySymbol = new Map(entries.map((entry) => [entry.symbol, entry]));
  const cache = new Map<string, { at: number; result: Routability }>();

  async function check(entry: MarketEntry): Promise<Routability> {
    const health = await entry.engine.health();
    if (!health) return { ok: false, reason: 'engine_unreachable' };

    const disagreements: string[] = [];
    if (health.market !== entry.market.id) disagreements.push('market');
    if (health.tickSize !== BigInt(entry.market.tickSize)) disagreements.push('tick_size');
    if (health.lotSize !== BigInt(entry.market.lotSize)) disagreements.push('lot_size');
    if (health.minNotional !== entry.market.minNotional) disagreements.push('min_notional');
    if (health.collarBps !== entry.market.collarBps) disagreements.push('collar_bps');
    if (disagreements.length > 0) {
      deps.logger.error('market disagrees with its engine; refusing to route it', {
        event: 'trading.market_disagrees',
        outcome: 'failure',
        targetType: 'market',
        targetId: entry.symbol,
        reason: disagreements.join(','),
      });
      return { ok: false, reason: 'engine_disagrees' };
    }
    return { ok: true, market: { ...entry.market, status: health.status as MarketStatus } };
  }

  return {
    entries,
    get: (symbol) => bySymbol.get(symbol),

    async routable(symbol) {
      const entry = bySymbol.get(symbol);
      if (!entry) return { ok: false, reason: 'unknown_market' };
      const cached = cache.get(symbol);
      if (cached && clock() - cached.at < ttl) return cached.result;
      const result = await check(entry);
      cache.set(symbol, { at: clock(), result });
      return result;
    },

    async verifyAll() {
      for (const entry of entries) {
        const result = await check(entry);
        cache.set(entry.symbol, { at: clock(), result });
        if (result.ok) {
          deps.logger.info('market verified against its engine', {
            event: 'trading.market_verified',
            outcome: 'success',
            targetType: 'market',
            targetId: entry.symbol,
          });
        } else if (result.reason === 'engine_unreachable') {
          deps.logger.warn('engine unreachable at boot; will re-check on first use', {
            event: 'trading.engine_unreachable',
            outcome: 'failure',
            targetType: 'market',
            targetId: entry.symbol,
          });
        }
      }
    },
  };
}

/** Storage speaks cluster-qualified keys; the wire speaks bare assets. */
export function wireAsset(assetKey: string): string {
  try {
    return parseLedgerAssetKey(assetKey).asset;
  } catch {
    return assetKey;
  }
}

export { ledgerAssetKey };
