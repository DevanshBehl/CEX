import {
  feeAmount,
  notional,
  type LedgerAssetKey,
  type Market,
  type OrderRequest,
} from '@wallet/types';
import { collarBand } from './collar.js';
import { WORST_CASE_TAKER_BPS } from './fees.js';

/**
 * What an order reserves (ADR-0025 §5, prompt_phase_s1.md rules 62-67).
 *
 * Written in S1 and called by nobody until S3. That is deliberate: the hold is
 * the ledger's requirement, and it belongs beside the validation that shares
 * its inputs rather than in the gateway that happens to apply it.
 *
 * THE HELD ASSET FOLLOWS THE SIDE, NOT THE QUOTE ASSET. A buy reserves quote; a
 * sell reserves base. Getting this backwards reserves an asset the order does
 * not spend, which passes every balance check and still cannot settle.
 */

export interface Hold {
  readonly asset: LedgerAssetKey;
  readonly amount: bigint;
  /**
   * The portion that is fee headroom rather than notional.
   *
   * S4 refunds whatever of this the actual tier did not consume, so it is
   * carried explicitly rather than folded into `amount` and forgotten.
   */
  readonly feeHeadroom: bigint;
}

export interface HoldInput {
  readonly request: OrderRequest;
  readonly market: Market;
  /** Required for a market buy, which has no price of its own to reserve against. */
  readonly reference: bigint | null;
}

/**
 * A market buy reserves against the TOP of the collar band.
 *
 * It is the most the order can possibly pay, because the collar is what stops
 * it paying more. Reserving against the reference price instead would under-hold
 * exactly when the book is thin, which is when a market order costs the most.
 */
export function computeHold(input: HoldInput): Hold {
  const { request, market, reference } = input;
  const qty = BigInt(request.qty);
  if (qty <= 0n) throw new RangeError(`hold quantity must be positive: ${request.qty}`);

  if (request.side === 'sell') {
    // The fee comes out of the proceeds, so a sell holds bare quantity. Holding
    // a fee in base as well would reserve an asset the fee is not charged in.
    return { asset: market.baseAsset, amount: qty, feeHeadroom: 0n };
  }

  let priceToReserveAt: bigint;
  if (request.type === 'limit') {
    if (request.price === null) throw new TypeError('a limit order must carry a price');
    priceToReserveAt = BigInt(request.price);
  } else {
    if (reference === null) {
      throw new TypeError('a market buy needs a reference price to reserve against');
    }
    priceToReserveAt = collarBand(reference, market).upper;
  }

  const value = notional(priceToReserveAt, qty);
  const feeHeadroom = feeAmount(value, WORST_CASE_TAKER_BPS);
  return { asset: market.quoteAsset, amount: value + feeHeadroom, feeHeadroom };
}
