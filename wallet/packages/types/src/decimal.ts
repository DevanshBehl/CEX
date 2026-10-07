import { MAX_U64, PRICE_SCALE_EXP } from './price.js';

/**
 * Human decimals to integers and back, WITHOUT a float (ADR-0026).
 *
 * A trading form takes "150.25" from a person and must hand the gateway a
 * scaled integer. `Number("150.25") * 1e6` is the obvious way and puts a
 * double into the one path fixed-point exists to keep doubles out of:
 * `0.1 + 0.2`, `1.005 * 1000`, and every price with more significant digits
 * than a double carries. Everything here is string and `bigint` arithmetic.
 *
 * Parsing REFUSES rather than rounds. Rounding a price a person typed is
 * changing their order; the form says what was wrong instead.
 */

export type DecimalParse =
  | { readonly ok: true; readonly value: bigint }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'malformed' | 'too_precise' | 'too_large';
    };

/** Digits, optionally a point and more digits. No sign, no exponent, no separators. */
const DECIMAL = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/;

/**
 * `"150.25"` with 6 decimals is `150250000n`.
 *
 * Trailing zeros beyond `decimals` are accepted — `"1.500000000"` is the same
 * number — and any other excess digit is `too_precise`.
 */
export function parseDecimal(input: string, decimals: number): DecimalParse {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer: ${String(decimals)}`);
  }
  const text = input.trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  const match = DECIMAL.exec(text);
  if (!match) return { ok: false, reason: 'malformed' };

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? match[3] ?? '';
  const kept = fraction.slice(0, decimals);
  if (/[1-9]/.test(fraction.slice(decimals))) return { ok: false, reason: 'too_precise' };

  const value = BigInt(whole + kept.padEnd(decimals, '0'));
  if (value > MAX_U64) return { ok: false, reason: 'too_large' };
  return { ok: true, value };
}

/**
 * `150250000n` with 6 decimals is `"150.25"`.
 *
 * Trailing fractional zeros are dropped unless `minFractionDigits` keeps them,
 * so a column of prices can share a width.
 */
export function formatDecimal(value: bigint, decimals: number, minFractionDigits = 0): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer: ${String(decimals)}`);
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  if (fraction.length < minFractionDigits) fraction = fraction.padEnd(minFractionDigits, '0');
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

/**
 * How many decimal places a HUMAN price has in a market's scaled units.
 *
 *   price_int = (quote base units / base base units) × PRICE_SCALE
 *
 * so one whole quote per one whole base is `10^(quoteDecimals + 9 −
 * baseDecimals)`. For SOL/USDC that is 10^6: 150 USDC per SOL is 150_000_000.
 *
 * Negative when the base has more than `quoteDecimals + 9` decimals — a market
 * ADR-0026 says needs a wider scale, and one this refuses rather than misprice.
 */
export function priceDecimals(market: {
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
}): number {
  const decimals = market.quoteDecimals + PRICE_SCALE_EXP - market.baseDecimals;
  if (decimals < 0) {
    throw new RangeError(
      'this market cannot be priced at PRICE_SCALE: its base asset has too many decimals',
    );
  }
  return decimals;
}

/** A price a person typed, as the scaled integer the gateway takes. */
export function parseHumanPrice(
  input: string,
  market: { readonly baseDecimals: number; readonly quoteDecimals: number },
): DecimalParse {
  return parseDecimal(input, priceDecimals(market));
}

/** A scaled price, as a person reads it. */
export function formatScaledPrice(
  price: bigint,
  market: { readonly baseDecimals: number; readonly quoteDecimals: number },
  minFractionDigits = 0,
): string {
  return formatDecimal(price, priceDecimals(market), minFractionDigits);
}
