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
