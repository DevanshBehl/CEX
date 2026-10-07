import { feeAmount, notional } from '@wallet/types';
import type { FeeTier } from './fees.js';

/**
 * What one fill costs each side (ADR-0029, ADR-0034 §§3, 9).
 *
 * Pure: the same fill and the same two tiers produce the same numbers on any
 * machine, years later. Nothing here reads a clock or a balance.
 *
 * The one decision that balances whichever way it is made is WHO IS THE BUYER.
 * The taker is the buyer when `takerSide` is `buy`; otherwise the maker is.
 * Getting it backwards charges the taker rate to the maker and still balances,
 * which is why it is derived here, once, and tested in both directions.
 */

export interface FillTerms {
  /** Scaled price (ADR-0026). */
  readonly price: bigint;
  /** Base units. */
  readonly qty: bigint;
  readonly takerSide: 'buy' | 'sell';
  /**
   * The RATES only. A settlement prices a fill from the rates recorded in its
   * day's tier snapshot, not from today's schedule (ADR-0034 §9).
   */
  readonly takerTier: Pick<FeeTier, 'takerBps'>;
  readonly makerTier: Pick<FeeTier, 'makerBps'>;
}

export interface FillAmounts {
  /** `floor(price × qty / PRICE_SCALE)`, computed once for both legs. */
  readonly notional: bigint;
  readonly buyerIsTaker: boolean;
  readonly buyerBps: number;
  readonly sellerBps: number;
  readonly buyerFee: bigint;
  readonly sellerFee: bigint;
  readonly takerBps: number;
  readonly makerBps: number;
  readonly takerFee: bigint;
  readonly makerFee: bigint;
}

export function fillAmounts(terms: FillTerms): FillAmounts {
  if (terms.price <= 0n) throw new RangeError(`fill price must be positive: ${terms.price}`);
  if (terms.qty <= 0n) throw new RangeError(`fill quantity must be positive: ${terms.qty}`);

  const value = notional(terms.price, terms.qty);
  const takerBps = terms.takerTier.takerBps;
  const makerBps = terms.makerTier.makerBps;
  // Floored, from the SAME notional both legs settle at.
  const takerFee = feeAmount(value, takerBps);
  const makerFee = feeAmount(value, makerBps);

  const buyerIsTaker = terms.takerSide === 'buy';
  return {
    notional: value,
    buyerIsTaker,
    buyerBps: buyerIsTaker ? takerBps : makerBps,
    sellerBps: buyerIsTaker ? makerBps : takerBps,
    buyerFee: buyerIsTaker ? takerFee : makerFee,
    sellerFee: buyerIsTaker ? makerFee : takerFee,
    takerBps,
    makerBps,
    takerFee,
    makerFee,
  };
}

/**
 * What a fill consumes from each side's hold.
 *
 * The buyer's hold is quote: the notional plus their fee. The seller's is base:
 * the bare quantity, because their fee comes out of the quote they receive.
 */
export function holdConsumption(
  amounts: FillAmounts,
  qty: bigint,
): {
  readonly buyerQuote: bigint;
  readonly sellerBase: bigint;
} {
  return { buyerQuote: amounts.notional + amounts.buyerFee, sellerBase: qty };
}
