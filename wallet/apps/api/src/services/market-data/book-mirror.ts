/**
 * A copy of one market's aggregated book (ADR-0036 §3).
 *
 * A MIRROR, never an authority. It is one snapshot from the engine at sequence
 * `S0`, plus the level changes of every sequence in `(S0, S]`, and it holds no
 * opinion of its own: a level change is the engine's absolute quantity for
 * that level, set — not added — so there is no arithmetic here that could
 * drift from the engine's.
 *
 * Whoever owns one decides when it is no longer trustworthy and throws it
 * away. Nothing in this file can tell.
 */

export type BookSide = 'buy' | 'sell';

export interface LevelChange {
  readonly side: BookSide;
  readonly price: bigint;
  /** The level's total quantity NOW. Zero removes the level. */
  readonly qty: bigint;
}

export interface BookLevel {
  readonly price: bigint;
  readonly qty: bigint;
}

export interface BookView {
  readonly seq: bigint;
  /** Best first: descending. */
  readonly bids: readonly BookLevel[];
  /** Best first: ascending. */
  readonly asks: readonly BookLevel[];
  /** True when a side held more levels than were asked for. */
  readonly truncated: boolean;
}

export interface BookMirror {
  readonly seq: bigint;
  /** Apply ONE sequence's changes. The caller has established it is the next. */
  apply(seq: bigint, changes: readonly LevelChange[]): void;
  view(maxLevels: number): BookView;
}

export function createBookMirror(snapshot: {
  readonly seq: bigint;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}): BookMirror {
  const bids = new Map<bigint, bigint>();
  const asks = new Map<bigint, bigint>();
  for (const level of snapshot.bids) if (level.qty > 0n) bids.set(level.price, level.qty);
  for (const level of snapshot.asks) if (level.qty > 0n) asks.set(level.price, level.qty);
  let seq = snapshot.seq;

  const sorted = (side: Map<bigint, bigint>, descending: boolean, max: number) => {
    const prices = [...side.keys()].sort((a, b) =>
      a === b ? 0 : a < b !== descending ? -1 : 1,
    );
    return prices.slice(0, max).map((price) => ({ price, qty: side.get(price)! }));
  };

  return {
    get seq() {
      return seq;
    },

    apply(next, changes) {
      for (const change of changes) {
        const side = change.side === 'buy' ? bids : asks;
        if (change.qty === 0n) side.delete(change.price);
        else side.set(change.price, change.qty);
      }
      seq = next;
    },

    view(maxLevels) {
      return {
        seq,
        bids: sorted(bids, true, maxLevels),
        asks: sorted(asks, false, maxLevels),
        truncated: bids.size > maxLevels || asks.size > maxLevels,
      };
    },
  };
}
