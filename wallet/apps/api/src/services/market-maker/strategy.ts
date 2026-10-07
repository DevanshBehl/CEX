import { collarBand, WORST_CASE_TAKER_BPS } from '@wallet/orders';
import { feeAmount, notional, type Market } from '@wallet/types';

/**
 * What the demo market maker WANTS resting (ADR-0038 §5).
 *
 * Pure. A reference price, a budget and a configuration in; quotes out. No
 * clock, no network, no randomness it was not handed, no order service. It can
 * be tested to exhaustion without infrastructure, which is the point of
 * keeping the decision apart from the acting on it.
 */

export interface QuoteConfig {
  /** Levels per side. */
  readonly levels: number;
  /** Half the distance between the best bid and the best ask. */
  readonly halfSpreadBps: number;
  /** Distance between successive levels on one side. */
  readonly levelStepBps: number;
  /** Base units at each level. Rounded DOWN to a lot. */
  readonly levelQty: bigint;
}

export interface Quote {
  readonly side: 'buy' | 'sell';
  /** 0 is the best level on its side. */
  readonly level: number;
  readonly price: bigint;
  readonly qty: bigint;
}

const BPS = 10_000n;

const floorTo = (value: bigint, step: bigint): bigint => (value / step) * step;
const ceilTo = (value: bigint, step: bigint): bigint => ((value + step - 1n) / step) * step;

/**
 * The ladder, best level first on each side — before asking whether it can be
 * afforded.
 *
 * Every quote is on a tick, a whole number of lots, at or above the minimum
 * notional, and inside the engine's collar band around ITS reference. A quote
 * outside any of those would be rejected by the engine after taking a hold and
 * releasing it for nothing, so it is not made.
 */
export function ladder(input: {
  readonly reference: bigint;
  readonly market: Market;
  /** The ENGINE's reference price, which the collar is centred on. Null: no trade yet. */
  readonly collarReference: bigint | null;
  readonly config: QuoteConfig;
}): Quote[] {
  const { reference, market, config } = input;
  const tick = BigInt(market.tickSize);
  const lot = BigInt(market.lotSize);
  if (reference <= 0n || config.levels <= 0) return [];

  const qty = floorTo(config.levelQty, lot);
  if (qty <= 0n) return [];
  const band = input.collarReference === null ? null : collarBand(input.collarReference, market);
  const within = (price: bigint) => band === null || (price >= band.lower && price <= band.upper);

  const quotes: Quote[] = [];
  let lastBid: bigint | null = null;
  let lastAsk: bigint | null = null;
  for (let level = 0; level < config.levels; level += 1) {
    const away = BigInt(config.halfSpreadBps + level * config.levelStepBps);
    // Bids round DOWN and asks UP: rounding never narrows the spread.
    let bid = floorTo((reference * (BPS - away)) / BPS, tick);
    let ask = ceilTo((reference * (BPS + away)) / BPS, tick);
    // Rounding to a coarse tick can stack two levels on one price. Each level
    // is strictly further out than the one before it.
    if (lastBid !== null && bid >= lastBid) bid = lastBid - tick;
    if (lastAsk !== null && ask <= lastAsk) ask = lastAsk + tick;
    // Never crossed, and never locked: an ask at the bid would trade with itself.
    if (ask <= bid) ask = bid + tick;
    lastBid = bid;
    lastAsk = ask;

    if (bid > 0n && within(bid) && notional(bid, qty) >= market.minNotional) {
      quotes.push({ side: 'buy', level, price: bid, qty });
    }
    if (within(ask) && notional(ask, qty) >= market.minNotional) {
      quotes.push({ side: 'sell', level, price: ask, qty });
    }
  }
  return quotes;
}

/** What a quote will HOLD: exactly what the gateway's `computeHold` reserves. */
export function holdFor(quote: Quote): bigint {
  if (quote.side === 'sell') return quote.qty;
  const value = notional(quote.price, quote.qty);
  return value + feeAmount(value, WORST_CASE_TAKER_BPS);
}

/**
 * The quotes the budget covers, best level first.
 *
 * `budget` is what may be held on each side: quote asset for bids, base asset
 * for asks. A side with nothing gets no quotes — that is not an error, it is a
 * maker that has run out of that asset, and it says so in a log.
 */
export function affordable(
  quotes: readonly Quote[],
  budget: { readonly base: bigint; readonly quote: bigint },
): Quote[] {
  let base = budget.base;
  let quote = budget.quote;
  const out: Quote[] = [];
  for (const candidate of [...quotes].sort((a, b) => a.level - b.level)) {
    const cost = holdFor(candidate);
    if (candidate.side === 'buy') {
      if (cost > quote) continue;
      quote -= cost;
    } else {
      if (cost > base) continue;
      base -= cost;
    }
    out.push(candidate);
  }
  return out;
}

/**
 * Whether the reference has moved far enough from where the ladder was last
 * anchored to be worth requoting. Without it a walk that moves a hair every
 * step would cancel and replace the whole ladder every cycle, and spend the
 * order-rate limit every user lives within on nothing.
 */
export function shouldReanchor(anchor: bigint | null, reference: bigint, thresholdBps: number): boolean {
  if (anchor === null) return true;
  const moved = reference > anchor ? reference - anchor : anchor - reference;
  return moved * BPS >= anchor * BigInt(thresholdBps);
}
