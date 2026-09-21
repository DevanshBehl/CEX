import { z } from 'zod';
import type { Brand } from './brands.js';
import {
  clusterSchema,
  parseLedgerAssetKey,
  type Cluster,
  type LedgerAssetKey,
} from './clusters.js';
import { asPrice, asQty, type Price, type Qty } from './price.js';

/**
 * Market definitions (ADR-0027).
 *
 * Everything an order can be rejected for that is not about the order itself —
 * the tick it is priced on, the lot it is sized in, the minimum it must be
 * worth, how far from the market it may reach — is a property of the MARKET.
 *
 * The alternative is that these arrive on the request, which makes them a
 * client parameter. A client-supplied collar is not a safety band; it is a
 * field an attacker sets to the value that removes the band.
 */

export const MARKET_STATUSES = [
  /** The market exists and is not yet trading. Accepts nothing. */
  'pre_open',
  /** Accepts everything. */
  'open',
  /** Accepts only post-only orders. Used to build a book before opening. */
  'post_only',
  /**
   * Accepts nothing — except cancels.
   *
   * A halt that traps resting orders gives a trader no way out of a position
   * they can no longer manage. The point of a halt is to stop price formation,
   * not to take away the exit (ADR-0027).
   */
  'halted',
] as const;

export type MarketStatus = (typeof MARKET_STATUSES)[number];
export const marketStatusSchema = z.enum(MARKET_STATUSES);

/** States in which a new order may be placed at all. */
export const PLACEABLE_STATUSES: ReadonlySet<MarketStatus> = new Set<MarketStatus>([
  'open',
  'post_only',
]);

/** `devnet:SOL-USDC` — cluster-qualified, as every asset key is (ADR-0021). */
export type MarketId = Brand<string, 'MarketId'>;

const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

export function marketId(cluster: Cluster, symbol: string): MarketId {
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new TypeError(`market symbol must be BASE-QUOTE in uppercase: ${symbol}`);
  }
  return `${cluster}:${symbol}` as MarketId;
}

export interface ParsedMarketId {
  readonly cluster: Cluster;
  readonly symbol: string;
}

export function parseMarketId(value: string): ParsedMarketId {
  const separator = value.indexOf(':');
  if (separator <= 0) {
    throw new TypeError(`market id is not cluster-qualified: ${value}`);
  }
  const cluster = clusterSchema.safeParse(value.slice(0, separator));
  if (!cluster.success) {
    throw new TypeError(`market id has an unknown cluster: ${value}`);
  }
  const symbol = value.slice(separator + 1);
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new TypeError(`market id has a malformed symbol: ${value}`);
  }
  return { cluster: cluster.data, symbol };
}

export interface Market {
  readonly id: MarketId;
  readonly cluster: Cluster;
  readonly symbol: string;
  readonly baseAsset: LedgerAssetKey;
  readonly quoteAsset: LedgerAssetKey;
  /** Every limit price must be an exact multiple. In scaled price units. */
  readonly tickSize: Price;
  /** Every quantity must be an exact multiple. In base base-units. */
  readonly lotSize: Qty;
  /** A floor on the TRUNCATED notional, in quote base-units. */
  readonly minNotional: bigint;
  /** How far from the reference price an order may reach. */
  readonly collarBps: number;
  readonly status: MarketStatus;
}

export interface MarketDefinition {
  readonly cluster: Cluster;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly tickSize: string;
  readonly lotSize: string;
  readonly minNotional: string;
  readonly collarBps: number;
  readonly status?: MarketStatus;
}

/**
 * Build a market, refusing an incoherent one at CONSTRUCTION rather than at use.
 *
 * Same reason `buildTransaction` refuses a cross-cluster ledger transaction
 * rather than discovering it later: a market whose two assets are in different
 * clusters cannot be traded, and the moment to say so is the moment it is
 * described.
 */
export function createMarket(definition: MarketDefinition): Market {
  const base = parseLedgerAssetKey(definition.baseAsset);
  const quote = parseLedgerAssetKey(definition.quoteAsset);

  if (base.cluster !== definition.cluster || quote.cluster !== definition.cluster) {
    throw new TypeError(
      `market ${definition.symbol} spans clusters: ${definition.baseAsset} / ${definition.quoteAsset}`,
    );
  }
  if (definition.baseAsset === definition.quoteAsset) {
    throw new TypeError(`market ${definition.symbol} has the same base and quote asset`);
  }

  const tickSize = asPrice(definition.tickSize);
  const lotSize = asQty(definition.lotSize);
  const minNotional = BigInt(definition.minNotional);

  if (BigInt(tickSize) <= 0n) throw new TypeError(`tickSize must be positive: ${tickSize}`);
  if (BigInt(lotSize) <= 0n) throw new TypeError(`lotSize must be positive: ${lotSize}`);
  if (minNotional <= 0n) throw new TypeError(`minNotional must be positive: ${minNotional}`);
  if (!Number.isInteger(definition.collarBps) || definition.collarBps <= 0) {
    throw new TypeError(`collarBps must be a positive integer: ${definition.collarBps}`);
  }

  return Object.freeze({
    id: marketId(definition.cluster, definition.symbol),
    cluster: definition.cluster,
    symbol: definition.symbol,
    baseAsset: definition.baseAsset as LedgerAssetKey,
    quoteAsset: definition.quoteAsset as LedgerAssetKey,
    tickSize,
    lotSize,
    minNotional,
    collarBps: definition.collarBps,
    status: definition.status ?? 'pre_open',
  });
}
