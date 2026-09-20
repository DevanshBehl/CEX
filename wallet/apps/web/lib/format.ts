/**
 * Display formatting.
 *
 * THE ONLY PLACE base units become something a person reads
 * (prompt_phase2.md rules 64, 169-170).
 *
 * The server sends integer base-unit strings and never a formatted value,
 * because formatting is a client concern: it depends on the asset's decimals
 * and the viewer's locale, and a server that pre-formats has made a decision
 * it cannot un-make.
 *
 * Everything here works on strings and bigints. A JSON number above 2^53 has
 * already lost precision by the time it reaches JavaScript, which for lamports
 * is about 9 million SOL.
 */

export function formatAmount(baseUnits: string, decimals: number): string {
  const negative = baseUnits.startsWith('-');
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : '';

  const groupedWhole = BigInt(whole).toLocaleString('en-US');
  const trimmed = fraction.replace(/0+$/, '');
  const rendered = trimmed.length > 0 ? `${groupedWhole}.${trimmed}` : groupedWhole;

  return negative ? `-${rendered}` : rendered;
}

/** True when the amount is exactly zero, without parsing it as a number. */
export function isZeroAmount(baseUnits: string): boolean {
  return /^-?0+$/.test(baseUnits);
}

export function shortenAddress(address: string, visible = 6): string {
  if (address.length <= visible * 2 + 3) return address;
  return `${address.slice(0, visible)}…${address.slice(-visible)}`;
}

/**
 * The inverse of `formatAmount`: what a person typed, as base units.
 *
 * Here rather than in the withdrawal form because it is the same boundary,
 * crossed the other way, and it has the same rule — no JS number touches the
 * value. `Number.parseFloat('0.1') * 1e9` is 100000000.00000001, and
 * `Math.round` hides that for small amounts and not for large ones.
 *
 * Returns a discriminated result rather than throwing, because every failure
 * here is something to say to the user in a form, not an exception.
 */
export type ParsedAmount =
  | { readonly ok: true; readonly baseUnits: string }
  | { readonly ok: false; readonly reason: 'empty' | 'malformed' | 'too_precise' | 'not_positive' };

export function parseAmount(input: string, decimals: number): ParsedAmount {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // Digits, at most one point. No sign, no exponent, no separators: this is a
  // wallet field, and `1e9` typed into it is far more likely a mistake than an
  // intent we should honour.
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
    return { ok: false, reason: 'malformed' };
  }

  const [whole = '', fraction = ''] = trimmed.split('.');
  // More decimal places than the asset has is NOT rounded down silently — that
  // would send a different amount than the one on screen.
  if (fraction.length > decimals) return { ok: false, reason: 'too_precise' };

  const baseUnits = `${whole}${fraction.padEnd(decimals, '0')}`;
  // `BigInt('')` throws; an all-empty input is already caught above, but
  // `.5` leaves `whole` empty and is perfectly valid.
  const value = BigInt(baseUnits === '' ? '0' : baseUnits);
  if (value <= 0n) return { ok: false, reason: 'not_positive' };

  return { ok: true, baseUnits: value.toString() };
}
