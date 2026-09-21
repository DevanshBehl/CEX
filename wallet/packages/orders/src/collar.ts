import { BPS_DENOMINATOR, type Market } from '@wallet/types';

/**
 * The collar band (ADR-0027).
 *
 * The collar bounds how far a single order may move the price, and it is the
 * reason a market order cannot walk a thin book into an absurd fill. It is a
 * MARKET property and never a client parameter — a client-supplied collar is
 * not a safety band, it is a field an attacker sets to the value that removes
 * the band.
 */

export interface CollarBand {
  readonly lower: bigint;
  readonly upper: bigint;
}

/**
 * The reference price, in the order ADR-0027 fixes: the last trade, then the
 * mid of a two-sided quote, then nothing.
 *
 * `null` for the third case is load-bearing. An empty book has no opinion about
 * what anything is worth, and a market order is a request to trade at whatever
 * the market says. When the market says nothing, the honest answer is a
 * rejection — not a fill at a price nobody quoted.
 */
export interface BookReference {
  readonly lastTradePrice: bigint | null;
  readonly bestBid: bigint | null;
  readonly bestAsk: bigint | null;
}

export function referencePrice(reference: BookReference): bigint | null {
  if (reference.lastTradePrice !== null) return reference.lastTradePrice;
  if (reference.bestBid !== null && reference.bestAsk !== null) {
    return (reference.bestBid + reference.bestAsk) / 2n;
  }
  return null;
}

export function collarBand(reference: bigint, market: Market): CollarBand {
  if (reference < 0n) throw new RangeError(`reference price must be non-negative: ${reference}`);
  const deviation = (reference * BigInt(market.collarBps)) / BPS_DENOMINATOR;
  const lower = reference - deviation;
  return { lower: lower < 0n ? 0n : lower, upper: reference + deviation };
}

export function withinCollar(price: bigint, band: CollarBand): boolean {
  return price >= band.lower && price <= band.upper;
}
