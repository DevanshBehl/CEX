import { describe, expect, it } from 'vitest';
import type { WsServerMessage } from '@wallet/types';
import { applyBookMessage, bookRows, EMPTY_BOOK, topOfBook, type BookState } from './book-state';

const scope = { cluster: 'devnet', market: 'SOL-USDC' } as const;
const snapshot = (seq: number, bids: string[][], asks: string[][], truncated = false) =>
  ({
    type: 'book.snapshot',
    ...scope,
    seq: String(seq),
    bids,
    asks,
    truncated,
  }) as unknown as Extract<WsServerMessage, { type: 'book.snapshot' }>;
const delta = (seq: number, changes: string[][]) =>
  ({ type: 'book.delta', ...scope, seq: String(seq), changes }) as unknown as Extract<
    WsServerMessage,
    { type: 'book.delta' }
  >;
const resync = { type: 'book.resync', ...scope } as const;

const run = (messages: Parameters<typeof applyBookMessage>[1][], from: BookState = EMPTY_BOOK) =>
  messages.reduce(applyBookMessage, from);
const levels = (map: ReadonlyMap<bigint, bigint>) =>
  [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, q]) => `${String(p)}x${String(q)}`);

describe('the book reducer', () => {
  it('a snapshot is the whole book, live at its sequence', () => {
    const book = run([
      snapshot(
        7,
        [['149', '5']],
        [
          ['151', '3'],
          ['152', '4'],
        ],
      ),
    ]);
    expect(book.status).toBe('live');
    expect(book.seq).toBe(7n);
    expect(levels(book.bids)).toEqual(['149x5']);
    expect(levels(book.asks)).toEqual(['151x3', '152x4']);
  });

  it('applies the next sequence: a level set, a level changed, a level emptied', () => {
    const book = run([
      snapshot(7, [['149', '5']], [['151', '3']]),
      delta(8, [
        ['buy', '148', '2'],
        ['sell', '151', '1'],
      ]),
      delta(9, [['sell', '151', '0']]),
    ]);
    expect(book.seq).toBe(9n);
    expect(levels(book.bids)).toEqual(['148x2', '149x5']);
    // Zero removed the level: it is not kept at quantity zero.
    expect(levels(book.asks)).toEqual([]);
    expect(book.status).toBe('live');
  });

  it('a level change is absolute: it sets, and applying it twice changes nothing', () => {
    const once = run([snapshot(1, [['149', '5']], []), delta(2, [['buy', '149', '9']])]);
    expect(levels(once.bids)).toEqual(['149x9']);
    // The same sequence again is a duplicate and is ignored outright.
    expect(run([delta(2, [['buy', '149', '9']])], once)).toBe(once);
  });

  it('a sequence that changed nothing still advances the book', () => {
    const book = run([snapshot(1, [], []), delta(2, []), delta(3, [])]);
    expect(book.seq).toBe(3n);
    expect(book.status).toBe('live');
  });

  it('a gap makes it stale and asks for a snapshot — it never applies across the hole', () => {
    const before = run([snapshot(1, [['149', '5']], [])]);
    const gapped = run([delta(3, [['buy', '149', '1']])], before);
    expect(gapped.status).toBe('stale');
    expect(gapped.needsSnapshot).toBe(true);
    // What was drawn is untouched: sequence 3's change was not applied.
    expect(levels(gapped.bids)).toEqual(['149x5']);
    expect(gapped.seq).toBe(1n);

    // And nothing after the hole is applied either, however well it follows.
    const later = run([delta(4, [['buy', '149', '0']]), delta(2, [['buy', '149', '7']])], gapped);
    expect(levels(later.bids)).toEqual(['149x5']);
    expect(later.status).toBe('stale');

    // Only a snapshot repairs it.
    const healed = run([snapshot(9, [['150', '2']], [])], later);
    expect(healed.status).toBe('live');
    expect(healed.needsSnapshot).toBe(false);
    expect(levels(healed.bids)).toEqual(['150x2']);
  });

  it('a resync marks the book stale and keeps it on screen, marked', () => {
    const book = run([snapshot(1, [['149', '5']], []), resync]);
    expect(book.status).toBe('stale');
    // The server sends the snapshot itself; the client does not ask.
    expect(book.needsSnapshot).toBe(false);
    expect(levels(book.bids)).toEqual(['149x5']);
    // A delta while stale is not applied.
    expect(run([delta(2, [['buy', '149', '0']])], book)).toBe(book);
  });

  it('ignores a delta that arrives before any snapshot', () => {
    expect(run([delta(5, [['buy', '149', '1']])])).toBe(EMPTY_BOOK);
    expect(run([resync])).toBe(EMPTY_BOOK);
  });

  it('carries the truncated flag, and drops zero levels from a snapshot', () => {
    const book = run([
      snapshot(
        1,
        [
          ['149', '0'],
          ['148', '2'],
        ],
        [],
        true,
      ),
    ]);
    expect(book.truncated).toBe(true);
    expect(levels(book.bids)).toEqual(['148x2']);
  });

  it('keeps quantities past 2^53 exact', () => {
    const big = '9007199254740993';
    const book = run([snapshot(1, [['149', big]], []), delta(2, [['buy', '148', big]])]);
    expect(book.bids.get(149n)).toBe(9_007_199_254_740_993n);
    expect(bookRows(book.bids, 'buy', 10)[1]!.cumulative).toBe(18_014_398_509_481_986n);
  });
});

describe('rows and the top of the book', () => {
  const book = run([
    snapshot(
      1,
      [
        ['149', '5'],
        ['148', '2'],
        ['147', '1'],
      ],
      [
        ['152', '4'],
        ['151', '3'],
      ],
    ),
  ]);

  it('orders each side best first, with cumulative depth', () => {
    expect(bookRows(book.bids, 'buy', 10).map((r) => [r.price, r.qty, r.cumulative])).toEqual([
      [149n, 5n, 5n],
      [148n, 2n, 7n],
      [147n, 1n, 8n],
    ]);
    expect(bookRows(book.asks, 'sell', 10).map((r) => [r.price, r.cumulative])).toEqual([
      [151n, 3n],
      [152n, 7n],
    ]);
  });

  it('bounds what is drawn without changing what is held', () => {
    expect(bookRows(book.bids, 'buy', 2)).toHaveLength(2);
    expect(book.bids.size).toBe(3);
  });

  it('finds the best bid, the best ask and the mid', () => {
    expect(topOfBook(book)).toEqual({ bid: 149n, ask: 151n, mid: 150n });
    expect(topOfBook(EMPTY_BOOK)).toEqual({ bid: null, ask: null, mid: null });
  });
});
