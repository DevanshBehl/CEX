import { z } from 'zod';
import type { Brand } from './brands.js';

/**
 * Fixed-point price and quantity (ADR-0026).
 *
 * A quantity is an integer count of the BASE asset's base units — the unit the
 * ledger already uses, so a fill's quantity becomes a ledger entry with no
 * conversion, and no conversion is a place a conversion bug can live.
 *
 * A price is not money. It is a ratio, and a ratio has no smallest indivisible
 * unit handed to it by the chain, so one is chosen here: quote base units per
 * one base base-unit, multiplied by PRICE_SCALE.
 *
 * Both are decimal strings at every boundary, for the reason `money.ts` already
 * gives: 2^53 is not enough, and bigint does not survive JSON.
 */

/** ADR-0026. Nine digits survives a 9-decimal base against a 6-decimal quote. */
export const PRICE_SCALE_EXP = 9;
export const PRICE_SCALE = 1_000_000_000n;

/** Basis points denominator, for fee arithmetic (ADR-0029). */
export const BPS_DENOMINATOR = 10_000n;

/**
 * The engine stores price and quantity in u64. Every result that crosses back
 * into engine territory is checked against this, because an overflow must be an
 * error and never a wrap.
 */
export const MAX_U64 = 18_446_744_073_709_551_615n;

/** A price, scaled by PRICE_SCALE, as a decimal integer string. */
export type Price = Brand<string, 'Price'>;

/** A quantity in the base asset's base units, as a decimal integer string. */
export type Qty = Brand<string, 'Qty'>;

const UNSIGNED_INTEGER = /^(0|[1-9]\d*)$/;

function parseUnsigned(value: string, what: string): bigint {
  if (!UNSIGNED_INTEGER.test(value)) {
    throw new TypeError(`${what} must be a non-negative integer string: ${value}`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64) {
    throw new RangeError(`${what} exceeds u64: ${value}`);
  }
  return parsed;
}

/**
 * Shape and bound in ONE refinement, with an early return.
 *
 * Not `.regex(...).refine(v => BigInt(v) <= MAX_U64)`: zod runs a refinement
 * even after an earlier check has failed, so `BigInt('1.5')` THROWS out of
 * `safeParse` instead of producing a validation issue. At an API boundary that
 * is a 500 where a 400 belongs. The early return is what makes the bound check
 * unreachable for input that is not already an integer string.
 */
function boundedIntegerString(what: string) {
  return z.string().superRefine((value, ctx) => {
    if (!UNSIGNED_INTEGER.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${what} must be a non-negative integer string`,
      });
      return;
    }
    if (BigInt(value) > MAX_U64) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${what} exceeds u64` });
    }
  });
}

export const priceSchema = boundedIntegerString('price').transform((v): Price => v as Price);

export const qtySchema = boundedIntegerString('quantity').transform((v): Qty => v as Qty);

/** Throws on malformed input. Use at trust boundaries only. */
export function asPrice(value: string): Price {
  parseUnsigned(value, 'price');
  return value as Price;
}

/** Throws on malformed input. Use at trust boundaries only. */
export function asQty(value: string): Qty {
  parseUnsigned(value, 'quantity');
  return value as Qty;
}

export const priceToBigInt = (price: Price): bigint => BigInt(price);
export const qtyToBigInt = (qty: Qty): bigint => BigInt(qty);
export const priceFromBigInt = (value: bigint): Price => checked(value, 'price') as Price;
export const qtyFromBigInt = (value: bigint): Qty => checked(value, 'quantity') as Qty;

function checked(value: bigint, what: string): string {
  if (value < 0n) throw new RangeError(`${what} is negative: ${value}`);
  if (value > MAX_U64) throw new RangeError(`${what} exceeds u64: ${value}`);
  return value.toString();
}

/**
 * The notional of a fill, in QUOTE base units (ADR-0026).
 *
 *   floor( price * qty / PRICE_SCALE )
 *
 * The multiplication is performed at full width. With a price near 1e8 and a
 * quantity near 1e15 the product is about 1e23, and u64 tops out near 1.8e19 —
 * so the intermediate overflowing is not a theoretical concern, it is the
 * ordinary case. TypeScript gets this for free from bigint; Rust must use u128.
 *
 * Truncation is toward zero and is applied ONCE. Both legs of the fill use the
 * identical result: the buyer pays exactly it and the seller receives exactly
 * it. The residual is at most one quote base unit and is not charged, because a
 * residual accounted for on only one leg is an unbalanced ledger transaction.
 */
export function notional(price: bigint, qty: bigint): bigint {
  if (price < 0n || qty < 0n) {
    throw new RangeError('notional operands must be non-negative');
  }
  const value = (price * qty) / PRICE_SCALE;
  if (value > MAX_U64) {
    throw new RangeError(`notional exceeds u64: price=${price} qty=${qty}`);
  }
  return value;
}

/**
 * A fee in quote base units (ADR-0029): floor(notional * bps / 10_000).
 *
 * Same truncation direction as `notional`, so a fee is never larger than the
 * schedule says.
 */
export function feeAmount(notionalValue: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(`fee basis points must be a non-negative integer: ${bps}`);
  }
  if (notionalValue < 0n) {
    throw new RangeError('fee notional must be non-negative');
  }
  return (notionalValue * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Whether `value` is an exact multiple of `step`. A tick and a lot check. */
export function isMultipleOf(value: bigint, step: bigint): boolean {
  if (step <= 0n) throw new RangeError(`step must be positive: ${step}`);
  return value % step === 0n;
}
