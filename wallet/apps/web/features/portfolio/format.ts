/**
 * Rendering money and percentages (Task 3).
 *
 * Every value arrives as a string or an integer, and none of it is arithmetic
 * — these turn a value into text and nothing else. `Number()` appears only at
 * the last step, on a value already rounded to cents, because
 * `Intl.NumberFormat` needs one and a dollar figure below 2^53 cents survives
 * it exactly.
 */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `"1234.560000"` → `"$1,234.56"`. */
export function formatUsd(value: string): string {
  const [whole = '0', fraction = '0'] = value.split('.');
  // Rounded to cents in integer arithmetic, then handed to the formatter.
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  return USD.format(Number(cents) / 100);
}

/** Basis points as a signed percentage: `1234` → `"+12.34%"`. */
export function formatBps(bps: number): string {
  const sign = bps > 0 ? '+' : '';
  return `${sign}${(bps / 100).toFixed(2)}%`;
}

/** A signed USD delta: `"-12.500000"` → `"-$12.50"`. */
export function formatDelta(value: string): string {
  const negative = value.startsWith('-');
  const magnitude = formatUsd(negative ? value.slice(1) : value);
  return `${negative ? '−' : '+'}${magnitude}`;
}

/** Base units to a human amount, using the asset's decimals. */
export function formatAmount(baseUnits: string, decimals: number): string {
  const negative = baseUnits.startsWith('-');
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');

  const grouped = BigInt(whole).toLocaleString('en-US');
  const rendered = fraction.length > 0 ? `${grouped}.${fraction.slice(0, 6)}` : grouped;
  return `${negative ? '−' : ''}${rendered}`;
}

/** A chart axis label, at a resolution that suits the range. */
export function formatAxisTime(iso: string, range: string): string {
  const date = new Date(iso);
  if (range === '24h') {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A tooltip label: enough to say exactly which moment this is. */
export function formatPointTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
