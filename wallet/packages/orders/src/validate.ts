import {
  isMultipleOf,
  MAX_U64,
  notional,
  PLACEABLE_STATUSES,
  type Market,
  type OrderRequest,
  type RejectReason,
} from '@wallet/types';
import { collarBand, withinCollar, type CollarBand } from './collar.js';
import { WORST_CASE_TAKER_BPS } from './fees.js';

/**
 * `notional`, but an overflow is a value rather than an exception.
 *
 * Validation is handed input from the wire, and input from the wire must not be
 * able to throw its way out of a validator.
 */
function safeNotional(price: bigint, qty: bigint): bigint | null {
  try {
    return notional(price, qty);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * Pure order validation (prompt_phase_s1.md §6).
 *
 * No database, no chain, no framework, no clock, no configuration read — held
 * to exactly the standard `packages/risk` set. The reference price is an
 * argument, not a lookup, for the same reason the risk engine takes `now` as an
 * argument: a decision that reads the world cannot be replayed.
 */

export interface ValidationInput {
  readonly request: OrderRequest;
  readonly market: Market;
  /** From `referencePrice()`. Null when the book has nothing to say. */
  readonly reference: bigint | null;
}

export interface OrderValidation {
  readonly ok: boolean;
  readonly reasons: readonly RejectReason[];
  /** The band the order was judged against, when one could be computed. */
  readonly band: CollarBand | null;
  /** The truncated notional, when one could be computed. */
  readonly notional: bigint | null;
}

/**
 * Every check runs on every order. No short-circuit.
 *
 * Same reason `packages/risk` evaluates every rule: a stored decision should
 * show the whole picture, not the first problem found. An order rejected for a
 * tick violation that is ALSO below the minimum notional should say both, or
 * the client fixes one and is rejected again.
 */
export function validateOrder(input: ValidationInput): OrderValidation {
  const { request, market, reference } = input;
  const reasons: RejectReason[] = [];

  // --- market status ---
  if (!PLACEABLE_STATUSES.has(market.status)) {
    reasons.push('MARKET_NOT_OPEN');
  } else if (market.status === 'post_only' && !request.postOnly) {
    reasons.push('MARKET_NOT_OPEN');
  }

  // --- input coherence ---
  const qty = BigInt(request.qty);
  if (qty <= 0n) reasons.push('QUANTITY_NOT_POSITIVE');

  const isLimit = request.type === 'limit';
  if (isLimit && request.price === null) reasons.push('PRICE_REQUIRED');
  if (!isLimit && request.price !== null) reasons.push('PRICE_NOT_ALLOWED');
  if (request.postOnly && !isLimit) reasons.push('POST_ONLY_REQUIRES_LIMIT');

  const limitPrice = isLimit && request.price !== null ? BigInt(request.price) : null;

  // --- tick ---
  if (limitPrice !== null && !isMultipleOf(limitPrice, BigInt(market.tickSize))) {
    reasons.push('TICK_VIOLATION');
  }

  // --- lot ---
  if (qty > 0n && !isMultipleOf(qty, BigInt(market.lotSize))) {
    reasons.push('LOT_VIOLATION');
  }

  // --- the price this order is judged at ---
  // A limit order is judged at its own price. A market order has none, so it is
  // judged at the reference — and if there is no reference it cannot be judged
  // at all, which is itself the rejection.
  const judgedAt = limitPrice ?? reference;
  if (!isLimit && reference === null) {
    reasons.push('NO_REFERENCE_PRICE');
  }

  // --- collar ---
  // A limit order with no reference is not judged: there is nothing for it to
  // be outside of. A market order with no reference was already rejected above.
  let band: CollarBand | null = null;
  if (reference !== null) {
    band = collarBand(reference, market);
    if (limitPrice !== null && !withinCollar(limitPrice, band)) {
      reasons.push('OUTSIDE_COLLAR');
    }
  }

  // --- minimum notional, against the TRUNCATED value ---
  // Checked against the truncated notional, not a recomputed one, so an order
  // can never pass validation at a value it will not settle at.
  let truncated: bigint | null = null;
  let overflowed = false;
  if (judgedAt !== null && qty > 0n) {
    truncated = safeNotional(judgedAt, qty);
    if (truncated === null) {
      overflowed = true;
    } else if (truncated < market.minNotional) {
      reasons.push('BELOW_MIN_NOTIONAL');
    }
  }

  // A buy must also be able to RESERVE. A market buy reserves at the top of the
  // collar band, which is strictly above the reference it was judged at — so an
  // order can clear the notional check and still have an unrepresentable hold.
  if (!overflowed && request.side === 'buy' && qty > 0n) {
    const reservePrice = limitPrice ?? (band !== null ? band.upper : null);
    if (reservePrice !== null) {
      const reserve = safeNotional(reservePrice, qty);
      if (
        reserve === null ||
        reserve + (reserve * BigInt(WORST_CASE_TAKER_BPS)) / 10_000n > MAX_U64
      ) {
        overflowed = true;
      }
    }
  }

  if (overflowed) reasons.push('NOTIONAL_OVERFLOW');

  return { ok: reasons.length === 0, reasons, band, notional: truncated };
}
