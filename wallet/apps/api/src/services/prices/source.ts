/**
 * Where a USD price comes from (Task 3).
 *
 * # Why an interface with several implementations
 *
 * A price is the only input to a valuation that does not come from the ledger,
 * so it is the only place a number on the dashboard depends on someone else's
 * uptime and someone else's idea of what a token is worth. Making the source
 * swappable is what lets a deployment choose its own trust: a public
 * aggregator, an oracle it runs itself, or — in a test — a fixed number that
 * makes an assertion possible at all.
 */

/** What the platform asks for: a symbol, because that is what a feed knows. */
export interface PriceRequest {
  /** `SOL`, `USDC`, `USDT`. Never a mint address — no feed indexes those. */
  readonly symbol: string;
}

export interface Quote {
  readonly symbol: string;
  /** Decimal string. A `number` here would lose precision before storage. */
  readonly priceUsd: string;
  /** When the SOURCE observed it, which is not when we recorded it. */
  readonly observedAt: Date;
}

export interface PriceSource {
  /** A short, stable name. Recorded on every tick for the audit trail. */
  readonly name: string;
  /**
   * Quotes for whatever it can price.
   *
   * A partial answer is expected and fine: an asset the feed does not carry is
   * simply absent, and the valuation marks that point incomplete rather than
   * pretending the holding is worth nothing.
   *
   * It may throw. The worker treats a failure as "no prices this cycle", which
   * is correct — the last tick stays the most recent one, and a chart that
   * stops advancing is far better than one that invents a value.
   */
  fetch(requests: readonly PriceRequest[]): Promise<Quote[]>;
}

/**
 * Turn whatever a feed returned into a decimal string, exactly.
 *
 * Feeds return numbers in JSON, and by the time `JSON.parse` has run the value
 * is already a double — so this is about not making it WORSE. `toFixed(8)`
 * pins the representation instead of letting `String(0.000001)` become
 * `"1e-6"`, which `NUMERIC` would reject and which would take the whole cycle
 * down.
 */
export function toDecimalString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`implausible price: ${String(value)}`);
  }
  return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0');
}
