import type { WsServerMessage } from '@wallet/types';

/**
 * The order book the screen draws, as a pure function of the messages it was
 * sent (prompt_phase_s5.md rules 140-141).
 *
 * No React, no socket, no clock. A snapshot replaces everything; a delta is
 * applied only if it is for exactly the next sequence. Anything else — a gap,
 * a `book.resync`, a delta before any snapshot — leaves the book STALE, and a
 * stale book is never repaired by applying later messages to it: a level
 * change is the engine's absolute quantity for one level at one sequence, and
 * across a missed sequence there are levels this book is wrong about and
 * cannot know which.
 */

export interface BookState {
  /**
   * `live` only while every sequence since the snapshot has been applied.
   * `stale` means do not present this as the market (rule 143).
   */
  readonly status: 'empty' | 'live' | 'stale';
  /** The engine sequence this book reflects. Null before any snapshot. */
  readonly seq: bigint | null;
  /** price -> total quantity. Never contains a zero. */
  readonly bids: ReadonlyMap<bigint, bigint>;
  readonly asks: ReadonlyMap<bigint, bigint>;
  /** The server sent fewer levels than the book has (ADR-0037 §6). */
  readonly truncated: boolean;
  /** Set when a gap was detected: the caller must ask for a new snapshot. */
  readonly needsSnapshot: boolean;
}

export const EMPTY_BOOK: BookState = {
  status: 'empty',
  seq: null,
  bids: new Map(),
  asks: new Map(),
  truncated: false,
  needsSnapshot: false,
};

type BookMessage = Extract<
  WsServerMessage,
  { type: 'book.snapshot' | 'book.delta' | 'book.resync' }
>;

export function applyBookMessage(state: BookState, message: BookMessage): BookState {
  switch (message.type) {
    case 'book.snapshot': {
      const side = (levels: readonly (readonly [string, string])[]) => {
        const map = new Map<bigint, bigint>();
        for (const [price, qty] of levels) {
          const quantity = BigInt(qty);
          if (quantity > 0n) map.set(BigInt(price), quantity);
        }
        return map;
      };
      return {
        status: 'live',
        seq: BigInt(message.seq),
        bids: side(message.bids),
        asks: side(message.asks),
        truncated: message.truncated,
        needsSnapshot: false,
      };
    }

    case 'book.resync':
      // The server cannot vouch for its book. Keep what is drawn — hiding it
      // would be a different lie — and mark it. The server sends the next
      // snapshot itself; nothing needs asking for.
      return state.status === 'empty' ? state : { ...state, status: 'stale' };

    case 'book.delta': {
      const seq = BigInt(message.seq);
      // Nothing to apply it to, or already waiting for a snapshot.
      if (state.seq === null || state.status !== 'live') return state;
      // A duplicate, or older than the snapshot: already reflected.
      if (seq <= state.seq) return state;
      if (seq !== state.seq + 1n) {
        // A sequence is missing. Discard nothing on screen, trust nothing:
        // the caller resubscribes for a snapshot.
        return { ...state, status: 'stale', needsSnapshot: true };
      }
      if (message.changes.length === 0) return { ...state, seq };
      const bids = new Map(state.bids);
      const asks = new Map(state.asks);
      for (const [which, price, qty] of message.changes) {
        const side = which === 'buy' ? bids : asks;
        const quantity = BigInt(qty);
        // Absolute: SET, never add. Zero removes the level.
        if (quantity === 0n) side.delete(BigInt(price));
        else side.set(BigInt(price), quantity);
      }
      return { ...state, seq, bids, asks };
    }
  }
}

export interface BookRow {
  readonly price: bigint;
  readonly qty: bigint;
  /** Running total from the best price outward. A `bigint`, like its parts. */
  readonly cumulative: bigint;
}

/** One side, best price first, with cumulative depth. */
export function bookRows(
  levels: ReadonlyMap<bigint, bigint>,
  side: 'buy' | 'sell',
  limit: number,
): BookRow[] {
  const prices = [...levels.keys()].sort((a, b) =>
    a === b ? 0 : (side === 'buy' ? a > b : a < b) ? -1 : 1,
  );
  let cumulative = 0n;
  return prices.slice(0, limit).map((price) => {
    const qty = levels.get(price)!;
    cumulative += qty;
    return { price, qty, cumulative };
  });
}

/** Best bid, best ask and the mid between them. Null where a side is empty. */
export function topOfBook(state: BookState): {
  readonly bid: bigint | null;
  readonly ask: bigint | null;
  readonly mid: bigint | null;
} {
  let bid: bigint | null = null;
  let ask: bigint | null = null;
  for (const price of state.bids.keys()) if (bid === null || price > bid) bid = price;
  for (const price of state.asks.keys()) if (ask === null || price < ask) ask = price;
  return { bid, ask, mid: bid !== null && ask !== null ? (bid + ask) / 2n : null };
}
