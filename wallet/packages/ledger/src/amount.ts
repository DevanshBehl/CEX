import { asBaseUnits, type BaseUnits } from '@wallet/types';

/**
 * Money arithmetic (prompt_phase2.md rules 59-64).
 *
 * `bigint` in memory, `BaseUnits` (a decimal string) at every boundary.
 *
 * Not `number`, anywhere, ever — including in a test fixture. 2^53 lamports is
 * about 9 million SOL, which is a plausible institutional balance, and above it
 * IEEE-754 silently cannot represent every integer. The failure is not an
 * exception; it is a balance that is quietly wrong.
 *
 * Not `number` even for small values, because the guarantee has to be
 * structural: a codebase where `number` is acceptable "when the value is small"
 * is one where the check for smallness is the thing that eventually fails.
 */

export type Amount = bigint;

export function toAmount(value: BaseUnits | string): Amount {
  return BigInt(asBaseUnits(typeof value === 'string' ? value : value));
}

export function toBaseUnits(value: Amount): BaseUnits {
  return asBaseUnits(value.toString());
}

export const ZERO: Amount = 0n;

export function add(a: Amount, b: Amount): Amount {
  return a + b;
}

export function subtract(a: Amount, b: Amount): Amount {
  return a - b;
}

export function negate(a: Amount): Amount {
  return -a;
}

export function isZero(a: Amount): boolean {
  return a === 0n;
}

export function isPositive(a: Amount): boolean {
  return a > 0n;
}

export function isNegative(a: Amount): boolean {
  return a < 0n;
}

export function sum(amounts: readonly Amount[]): Amount {
  return amounts.reduce<Amount>((total, value) => total + value, 0n);
}

export function compare(a: Amount, b: Amount): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Display only (prompt_phase2.md rule 64).
 *
 * Decimals are metadata about how to render an amount. They never participate
 * in arithmetic — the ledger deals exclusively in indivisible base units, and
 * a system that divides by 10^decimals internally has reintroduced the rounding
 * question it was designed to avoid.
 */
export function formatForDisplay(value: Amount, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new TypeError(`decimals must be a non-negative integer, got ${decimals}`);
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : '';
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}
