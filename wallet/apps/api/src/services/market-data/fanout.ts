import type { Redis } from 'ioredis';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import type { WalletMetrics } from '../../observability/metrics.js';
import { decodeSettlementEvent } from '../settlement/events.js';
import { parseEngineJson, type EngineDepth } from '../trading/engine-client.js';
import {
  createBookMirror,
  type BookMirror,
  type BookView,
  type LevelChange,
} from './book-mirror.js';

/**
 * The LIVE book and tape for one market (ADR-0036 §§2-3).
 *
 * The third reader of the engine's stream, and the only one with no durable
 * position: it holds an engine sequence in memory, and a restart rebuilds it
 * from a snapshot. It uses no consumer group, because a group hands each
 * entry to one member and EVERY API instance must see every entry.
 *
 * Its book is valid for sequence `S` only if it was built from a snapshot at
 * `S0 ≤ S` and has applied every sequence in `(S0, S]`. On any doubt — a
 * missing sequence, a last entry with no `levels`, an entry it cannot read, a
 * stream that went quiet while the engine moved on — it stops vouching for the
 * book, says so, and takes a new snapshot. It never guesses a level.
 */

export interface FanoutEntry {
  readonly seq: bigint;
  readonly idx: number;
  /** The engine's event JSON, undecoded. */
  readonly raw: string;
  /** The `levels` field: present on the last entry of a sequence. */
  readonly levels: string | null;
}

export interface FanoutSource {
  /** Forget the position: the next read returns only entries added from now. */
  seekToEnd(): Promise<void>;
  read(count: number, blockMs: number): Promise<readonly FanoutEntry[]>;
  close?(): Promise<void>;
}

/** The engine, as the one thing that knows the book. */
export interface BookAuthority {
  depth(): Promise<EngineDepth | null>;
  lastSeq(): Promise<bigint | null>;
}

/** A public trade. Built field by field: no order id exists here to leak. */
export interface PublicTrade {
  readonly id: string;
  readonly seq: bigint;
  readonly price: bigint;
  readonly qty: bigint;
  readonly takerSide: 'buy' | 'sell';
  readonly timestampMs: bigint;
}

export type FanoutMessage =
  /** A book this instance vouches for, after a boot or a resync. */
  | { readonly kind: 'snapshot'; readonly book: BookView }
  /** One engine sequence. `changes` is empty when it moved no level. */
  | { readonly kind: 'delta'; readonly seq: bigint; readonly changes: readonly LevelChange[] }
  /** The book is not trustworthy. Nothing follows until a snapshot. */
  | { readonly kind: 'resync' }
  | { readonly kind: 'trade'; readonly trade: PublicTrade };

export interface MarketFanoutDeps {
  readonly symbol: string;
  readonly source: FanoutSource;
  readonly authority: BookAuthority;
  readonly logger: Logger;
  readonly metrics?: WalletMetrics;
  /** Levels per side handed to a subscriber or a REST caller. */
  readonly maxLevels: number;
  readonly batchSize?: number;
  readonly blockMs?: number;
  /** Idle reads behind the engine before the mirror is distrusted. */
  readonly idleBehindLimit?: number;
}

export interface MarketFanout {
  readonly symbol: string;
  /** One pass: resynchronise if needed, then read and apply. For tests and the loop. */
  runOnce(): Promise<void>;
  /** The current book, or null while it cannot be vouched for. */
  book(): BookView | null;
  subscribe(listener: (message: FanoutMessage) => void): () => void;
  start(): void;
  stop(): Promise<void>;
}

function parseLevels(raw: string): LevelChange[] {
  const value = parseEngineJson(raw);
  if (!Array.isArray(value)) throw new TypeError('levels is not an array');
  return value.map((item: unknown) => {
    const level = item as { side?: unknown; price?: unknown; qty?: unknown };
    if (level.side !== 'buy' && level.side !== 'sell') throw new TypeError('level side');
    const price = toBigInt(level.price);
    const qty = toBigInt(level.qty);
    if (price <= 0n || qty < 0n) throw new RangeError('level out of range');
    return { side: level.side, price, qty };
  });
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new TypeError('not an integer');
}

export function createMarketFanout(deps: MarketFanoutDeps): MarketFanout {
  const label = { market: deps.symbol };
  const batch = deps.batchSize ?? 200;
  const blockMs = deps.blockMs ?? 1_000;
  const idleBehindLimit = deps.idleBehindLimit ?? 2;
  const listeners = new Set<(message: FanoutMessage) => void>();

  let mirror: BookMirror | null = null;
  /** The sequence being assembled: entries seen, waiting for its `levels`. */
  let pending: { seq: bigint; nextIdx: number; trades: PublicTrade[] } | null = null;
  let idleBehind = 0;
  let running = false;
  let loop: Promise<void> | undefined;

  const emit = (message: FanoutMessage): void => {
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // One subscriber failing must not stop the fan-out for the others.
      }
    }
  };

  function invalidate(cause: string): void {
    if (mirror === null) return;
    mirror = null;
    pending = null;
    idleBehind = 0;
    deps.metrics?.bookResyncs.inc({ ...label, cause });
    logSecurityEvent(deps.logger, 'market_data.book_resynced', {
      outcome: 'failure',
      targetType: 'market',
      targetId: deps.symbol,
      reason: cause,
    });
    // Said at once, before the new snapshot exists: subscribers must stop
    // trusting what they hold now, not when a replacement is ready.
    emit({ kind: 'resync' });
  }

  /** Take a new snapshot. The mirror stays invalid if the engine cannot answer. */
  async function resync(): Promise<void> {
    // Position FIRST, snapshot second: everything published after this point
    // is read, and anything at or below the snapshot's sequence is skipped. In
    // the other order, a sequence published between the two would be lost.
    await deps.source.seekToEnd();
    const depth = await deps.authority.depth();
    if (!depth) return;
    mirror = createBookMirror(depth);
    pending = null;
    idleBehind = 0;
    emit({ kind: 'snapshot', book: mirror.view(deps.maxLevels) });
  }

  /** Returns false when the mirror was invalidated and the batch must stop. */
  function process(entry: FanoutEntry): boolean {
    if (mirror === null) return false;
    // Republished after a failed publish, or older than the snapshot.
    if (entry.seq <= mirror.seq) return true;
    if (entry.seq !== mirror.seq + 1n) {
      invalidate('sequence_gap');
      return false;
    }
    pending ??= { seq: entry.seq, nextIdx: 0, trades: [] };
    // A sequence republished from its start after a partial publish.
    if (entry.idx < pending.nextIdx) return true;
    if (entry.idx !== pending.nextIdx) {
      invalidate('event_gap');
      return false;
    }

    let changes: LevelChange[] | null = null;
    try {
      const event = decodeSettlementEvent(entry.raw);
      if (event.seq !== entry.seq) throw new TypeError('key mismatch');
      if (event.kind === 'fill') {
        pending.trades.push({
          id: event.fillId,
          seq: event.seq,
          price: event.price,
          qty: event.qty,
          takerSide: event.takerSide,
          timestampMs: event.timestampMs,
        });
      }
      if (entry.levels !== null) changes = parseLevels(entry.levels);
    } catch {
      // Never a dropped element: a book that skipped what it could not read
      // is a book nobody can vouch for.
      invalidate('undecodable_entry');
      return false;
    }
    pending.nextIdx += 1;

    // `levels` marks the last entry of the sequence. Until it arrives the
    // sequence is incomplete and nothing about it is published.
    if (changes === null) return true;
    const completed = pending;
    pending = null;
    mirror.apply(completed.seq, changes);
    for (const trade of completed.trades) emit({ kind: 'trade', trade });
    emit({ kind: 'delta', seq: completed.seq, changes });
    return true;
  }

  const fanout: MarketFanout = {
    symbol: deps.symbol,

    async runOnce() {
      if (mirror === null) {
        await resync();
        if (mirror === null) return;
      }

      const entries = await deps.source.read(batch, blockMs);
      if (entries.length === 0) {
        // Quiet is only "nothing happened" if the engine agrees. A sequence
        // whose last entry carried no `levels`, or a stream recreated under
        // this reader, looks exactly like a quiet market from here.
        const last = await deps.authority.lastSeq();
        const current = mirror as BookMirror | null;
        if (last !== null && current !== null) {
          deps.metrics?.fanoutLag.set(Number(last - current.seq), label);
          if (last > current.seq) {
            idleBehind += 1;
            if (idleBehind >= idleBehindLimit) invalidate('behind_engine');
          } else {
            idleBehind = 0;
          }
        }
        return;
      }
      idleBehind = 0;
      for (const entry of entries) if (!process(entry)) break;
    },

    book() {
      return mirror === null ? null : mirror.view(deps.maxLevels);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          try {
            await fanout.runOnce();
            // The engine could not be reached for a snapshot: do not spin.
            if (mirror === null && running) await new Promise((r) => setTimeout(r, 1_000));
          } catch (error) {
            deps.logger.error('market-data fan-out cycle failed', {
              targetType: 'market',
              targetId: deps.symbol,
              errorName: error instanceof Error ? error.name : 'unknown',
            });
            invalidate('reader_failed');
            if (running) await new Promise((r) => setTimeout(r, 1_000));
          }
        }
      })();
    },

    async stop() {
      running = false;
      await loop;
      await deps.source.close?.();
    },
  };
  return fanout;
}

/**
 * The engine's stream, read with plain `XREAD` from a remembered id.
 *
 * No consumer group and no acknowledgement: this reader owes the stream
 * nothing, and what it missed it does not ask for — it takes a snapshot. The
 * Redis id is used ONLY to continue this one connection's read; position, for
 * every decision that matters, is the engine sequence each entry carries.
 */
export function createRedisFanoutSource(input: {
  readonly redis: Redis;
  readonly stream: string;
}): FanoutSource {
  const { redis, stream } = input;
  let lastId = '$';

  return {
    async seekToEnd() {
      const newest = (await redis.xrevrange(stream, '+', '-', 'COUNT', 1)) as [string, string[]][];
      lastId = newest[0]?.[0] ?? '0-0';
    },

    async read(count, blockMs) {
      const reply = (await redis.call(
        'XREAD',
        'COUNT',
        count,
        'BLOCK',
        blockMs,
        'STREAMS',
        stream,
        lastId,
      )) as [string, [string, string[]][]][] | null;
      const entries = reply?.[0]?.[1] ?? [];
      const out: FanoutEntry[] = [];
      for (const [id, fields] of entries) {
        lastId = id;
        const map = new Map<string, string>();
        for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
        const seq = map.get('seq');
        const idx = map.get('idx');
        const raw = map.get('event');
        if (!seq || !/^\d+$/.test(seq) || !idx || !/^\d+$/.test(idx) || raw === undefined) {
          throw new TypeError('malformed stream entry');
        }
        out.push({ seq: BigInt(seq), idx: Number(idx), raw, levels: map.get('levels') ?? null });
      }
      return out;
    },

    async close() {
      redis.disconnect();
    },
  };
}
