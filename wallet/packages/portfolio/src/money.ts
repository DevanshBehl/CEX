/**
 * USD arithmetic, in integers.
 *
 * # Why micro-dollars and not a float
 *
 * The ledger has been integer base units since Phase 2 for the obvious reason:
 * `0.1 + 0.2 !== 0.3`. A valuation layer that converted to `number` to
 * multiply by a price would reintroduce exactly what the ledger spent that
 * effort avoiding — and the error would appear in the one number a user reads
 * most often.
 *
 * So a price is parsed to micro-dollars (6 decimal places, matching
 * `NUMERIC(18,6)`) and every product stays a bigint.
 */

/** One US dollar, in micro-dollars. */
export const USD_MICROS = 1_000_000n;

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Parse a decimal string to micro-dollars, exactly.
 *
 * Never `Number(value) * 1e6`: at four significant figures that is fine and at
 * eighteen it is not, and a price feed is free to return either.
 *
 * More than six decimal places are TRUNCATED rather than rounded, matching
 * what `NUMERIC(18,6)` would have stored had the value gone through the
 * column. Two different answers for the same input would be worse than a
 * slightly lossy one.
 */
export function parseUsd(value: string): bigint {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new TypeError(`not a decimal price: ${value}`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  const micros = BigInt(whole) * USD_MICROS + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  return negative ? -micros : micros;
}

/** Micro-dollars as a plain decimal string, for the wire. */
export function formatUsd(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / USD_MICROS;
  const fraction = (absolute % USD_MICROS).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * What a holding is worth, in micro-dollars.
 *
 * `amount` is base units and `decimals` converts it to whole units, so the
 * product is `amount × price ÷ 10^decimals`. Integer division truncates toward
 * zero, which under-reports a positive holding by less than one micro-dollar —
 * a millionth of a cent, and always in the direction that does not overstate
 * what someone owns.
 */
export function valueOf(amount: bigint, priceMicros: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new TypeError(`implausible decimals: ${decimals}`);
  }
  return (amount * priceMicros) / 10n ** BigInt(decimals);
}

/**
 * A share of a total, in basis points (1/100th of a percent).
 *
 * Integers again, for the same reason: an allocation that sums to 99.99999%
 * because of floating point is the kind of detail that makes a user distrust
 * everything else on the page.
 */
export function shareBps(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((part * 10_000n) / total);
}
