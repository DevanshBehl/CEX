import { formatDecimal, priceDecimals, type MarketView } from '@wallet/types';

/**
 * Prices and quantities, for reading (prompt_phase_s5.md rule 149).
 *
 * Everything in is a `bigint` or an integer string, and everything out is a
 * string. Nothing here passes through a `number`: a double carries about
 * fifteen significant digits, and a quantity in base units routinely has more.
 */

type Decimals = Pick<MarketView, 'baseDecimals' | 'quoteDecimals'>;

const grouped = (text: string): string => {
  const [whole = '0', fraction] = text.split('.');
  const negative = whole.startsWith('-');
  const digits = (negative ? whole.slice(1) : whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${digits}${fraction === undefined ? '' : `.${fraction}`}`;
};

/** A scaled price in the market's own terms: quote per whole base. */
export function formatPrice(
  price: bigint | string,
  market: Decimals,
  minFractionDigits = 2,
): string {
  const decimals = priceDecimals(market);
  return grouped(formatDecimal(BigInt(price), decimals, Math.min(minFractionDigits, decimals)));
}

export function formatBase(qty: bigint | string, market: Decimals, minFractionDigits = 0): string {
  return grouped(formatDecimal(BigInt(qty), market.baseDecimals, minFractionDigits));
}

export function formatQuote(
  amount: bigint | string,
  market: Decimals,
  minFractionDigits = 2,
): string {
  return grouped(
    formatDecimal(
      BigInt(amount),
      market.quoteDecimals,
      Math.min(minFractionDigits, market.quoteDecimals),
    ),
  );
}

/** The change between two prices in hundredths of a percent, as text. Null if unknowable. */
export function formatChange(from: bigint | null, to: bigint | null): string | null {
  if (from === null || to === null || from === 0n) return null;
  // Basis points, in integers; the sign is carried separately so -0.05% reads right.
  const bps = ((to - from) * 10_000n) / from;
  const sign = to > from ? '+' : to < from ? '−' : '';
  const magnitude = bps < 0n ? -bps : bps;
  return `${sign}${formatDecimal(magnitude, 2, 2)}%`;
}

export const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour12: false });
