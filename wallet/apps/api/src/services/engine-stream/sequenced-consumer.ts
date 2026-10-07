import {
  compareKeys,
  createSettlementRepository,
  withTransaction,
  type EventKey,
  type Executor,
  type PrismaClient,
} from '@wallet/db';
import { formatKey, keyByPosition, type KeyedRaw } from '../settlement/events.js';
import type { SettlementEventSource, StreamEntry } from '../settlement/source.js';

/**
 * A durable, in-order, exactly-once-by-position reader of one market's engine
 * events (ADR-0034 §5, ADR-0036 §2).
 *
 * What settlement and the market-data tape share, and nothing either does with
 * an event. For each event, in `(seq, idx)` order:
 *
 *   1. skip it if the offset is already at or past its key;
 *   2. if it is not the very next key, recover the gap from the engine's
 *      journal (`GET /v1/events`) before going further;
 *   3. in ONE serializable transaction: apply it, then advance the offset;
 *   4. only after that commits, acknowledge it.
 *
 * Crash anywhere and nothing is lost or doubled. Before the commit: the offset
 * did not move, the entry is still pending, and it is redelivered. After the
 * commit and before the ack: it is redelivered and skipped by the offset.
 *
 * An event that cannot be applied HALTS this consumer at that key. It is not
 * skipped, not parked, and the offset does not pass it. Each (consumer,
 * market) pair has its own offset, so a halt stops exactly one of them.
 *
 * Position is `engine_offsets`, keyed by consumer name and market. It is never
 * a Redis id and never another consumer's row.
 */

export interface Reemitter {
  /**
   * Raw events after `afterSeq`, in emission order, in pages that end only at
   * sequence boundaries. Null when the engine cannot be reached.
   */
  eventsAfter(afterSeq: bigint, limit: number): Promise<readonly unknown[] | null>;
  /** The engine's last journaled sequence, or null when unreachable. */
  lastSeq(): Promise<bigint | null>;
}

export interface SequencedConsumerDeps<TEvent extends { readonly seq: bigint }, TOutcome> {
  readonly db: PrismaClient;
  /** Cluster-qualified market id: the offset's key. */
  readonly marketId: string;
  readonly source: SettlementEventSource;
  readonly reemitter: Reemitter;
  /** Names this consumer's row in `engine_offsets`. */
  readonly consumer: string;
  /**
   * Where to start when there is no offset row. Required then: a consumer
   * never assumes `(0, 0)` and never assumes "latest".
   */
  readonly startKey?: EventKey;
  readonly batchSize?: number;
  readonly blockMs?: number;
  readonly pageSize?: number;
  /** Attempts at one event before a transient failure ends the cycle. */
  readonly transientRetries?: number;
  readonly intervalMs?: number;

  /** Decode one event, or throw. A throw is a halt at that key, never a skip. */
  decode(raw: unknown): TEvent;
  /** Work that must happen OUTSIDE the transaction, before it. */
  prepare?(event: TEvent): Promise<void>;
  /** Apply one event inside the transaction that also advances the offset. */
  apply(input: { tx: Executor; key: EventKey; event: TEvent }): Promise<TOutcome>;
  /** A reason code if this error means "halt", or null if it is transient. */
  haltReason(error: unknown): string | null;

  onApplied?(outcome: TOutcome, key: EventKey, event: TEvent): void;
  onHalt(key: EventKey, reason: string): void;
  onRecovered(cause: string, applied: number): void;
  onTransient(key: EventKey, error: unknown): void;
  onStartRefused(): void;
  onCycleFailed(error: unknown): void;
  onLag?(sequences: number): void;
  /** What `init` throws with neither an offset nor a start key. */
  startRefused(): Error;
}

export interface SequencedConsumerStatus {
  readonly offset: EventKey | null;
  /** Engine sequences not yet applied, as last measured. Null before the first measure. */
  readonly lag: number | null;
  readonly halted: { readonly key: string; readonly reason: string } | null;
}

export interface SequencedConsumer {
  /** Load the offset. Throws if there is none and no start key is configured. */
  init(): Promise<void>;
  /** One read-and-apply pass. Returns how many events it applied, recovered ones included. */
  runOnce(): Promise<number>;
  status(): SequencedConsumerStatus;
  start(): void;
  stop(): Promise<void>;
}

/** The key that must come next after `offset`, if the stream is contiguous. */
function follows(offset: EventKey, key: EventKey): boolean {
  if (key.seq === offset.seq) return key.idx === offset.idx + 1;
  // Sequences are contiguous: every command emits at least one event.
  return key.seq === offset.seq + 1n && key.idx === 0;
}

export function createSequencedConsumer<TEvent extends { readonly seq: bigint }, TOutcome>(
  deps: SequencedConsumerDeps<TEvent, TOutcome>,
): SequencedConsumer {
  const offsets = createSettlementRepository(deps.db);
  const batch = deps.batchSize ?? 100;
  const blockMs = deps.blockMs ?? 1_000;
  const pageSize = deps.pageSize ?? 500;
  const retries = deps.transientRetries ?? 5;

  let offset: EventKey | null = null;
  let halted: { key: string; reason: string } | null = null;
  let lag: number | null = null;
  let appliedThisRun = 0;
  let running = false;
  let loop: Promise<void> | undefined;

  function doHalt(key: EventKey, reason: string): void {
    halted = { key: formatKey(key), reason };
    deps.onHalt(key, reason);
  }

  /**
   * Apply one event and advance the offset to its key, atomically. Returns
   * false if this consumer is now halted, or a transient failure outlasted its
   * retries (the event will be tried again next cycle).
   */
  async function applyOne(item: KeyedRaw): Promise<boolean> {
    const current = offset;
    if (current === null) throw new Error('consumer used before init');
    if (compareKeys(item.key, current) <= 0) return true;

    let event: TEvent;
    try {
      event = deps.decode(item.raw);
    } catch (error) {
      doHalt(item.key, deps.haltReason(error) ?? 'undecodable_event');
      return false;
    }
    // The stream entry's `seq` field and the event's own must agree, or the
    // key this would be recorded under is not the event's key.
    if (event.seq !== item.key.seq) {
      doHalt(item.key, 'key_mismatch');
      return false;
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        await deps.prepare?.(event);
        const outcome = await withTransaction(deps.db, async (tx) => {
          const result = await deps.apply({ tx, key: item.key, event });
          // In the SAME transaction as the work it records.
          await createSettlementRepository(tx).advanceOffset(
            deps.consumer,
            deps.marketId,
            item.key,
            tx,
          );
          return result;
        });

        offset = item.key;
        appliedThisRun += 1;
        deps.onApplied?.(outcome, item.key, event);
        return true;
      } catch (error) {
        const reason = deps.haltReason(error);
        if (reason !== null) {
          doHalt(item.key, reason);
          return false;
        }
        // Transient: a lost connection, a timeout. withTransaction already
        // retried serialization conflicts; a 40001 is never a halt.
        if (attempt >= retries) {
          deps.onTransient(item.key, error);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 50 * 2 ** attempt)));
      }
    }
  }

  /**
   * Re-derive everything after the offset from the engine's journal.
   *
   * Asks from the sequence BEFORE the offset's, because the offset may sit in
   * the middle of a sequence: `idx` is assigned by position, so the whole of
   * that sequence must be in hand to key its later events correctly.
   */
  async function recover(cause: string): Promise<boolean> {
    let after = offset!.seq > 0n ? offset!.seq - 1n : 0n;
    let applied = 0;
    for (;;) {
      const page = await deps.reemitter.eventsAfter(after, pageSize);
      if (page === null) return false; // engine unreachable: try again next cycle
      if (page.length === 0) break;
      let keyed: KeyedRaw[];
      try {
        keyed = keyByPosition(page);
      } catch (error) {
        doHalt({ seq: after + 1n, idx: 0 }, deps.haltReason(error) ?? 'undecodable_event');
        return false;
      }
      for (const item of keyed) {
        if (compareKeys(item.key, offset!) <= 0) continue;
        if (!follows(offset!, item.key)) {
          // Re-emission itself has a hole. Nothing below can fill it.
          doHalt(item.key, 'reemission_gap');
          return false;
        }
        if (!(await applyOne(item))) return false;
        applied += 1;
      }
      after = keyed[keyed.length - 1]!.key.seq;
    }
    deps.onRecovered(cause, applied);
    return true;
  }

  async function refreshLag(): Promise<void> {
    const last = await deps.reemitter.lastSeq();
    if (last !== null && offset !== null) {
      lag = Number(last - offset.seq);
      deps.onLag?.(lag);
    }
  }

  const consumer: SequencedConsumer = {
    async init() {
      const stored = await offsets.getOffset(deps.consumer, deps.marketId);
      if (stored) {
        offset = stored;
        return;
      }
      if (!deps.startKey) {
        deps.onStartRefused();
        throw deps.startRefused();
      }
      offset = deps.startKey;
    },

    async runOnce() {
      if (halted || offset === null) return 0;
      appliedThisRun = 0;

      const read = await deps.source.read(batch, blockMs);
      if (read === 'reset') {
        await recover('stream_reset');
      } else if (read.length === 0) {
        // Nothing new on the stream. That is only "nothing happened" if the
        // engine agrees: a wiped stream with an idle engine looks exactly like
        // this, and its fills would otherwise wait for the next command.
        const last = await deps.reemitter.lastSeq();
        if (last !== null && last > offset.seq) await recover('stream_behind_engine');
      } else {
        const sorted = [...read].sort((a, b) => compareKeys(a.key, b.key));
        const done: string[] = [];
        for (const entry of sorted) {
          if (halted) break;
          if (compareKeys(entry.key, offset!) <= 0) {
            // Already applied — redelivered, republished, or recovered.
            done.push(entry.id);
            continue;
          }
          if (!follows(offset!, entry.key)) {
            // A gap: the stream skipped something, or was trimmed. The journal
            // has it.
            if (!(await recover('sequence_gap'))) break;
            if (compareKeys(entry.key, offset!) <= 0) {
              done.push(entry.id);
              continue;
            }
            if (!follows(offset!, entry.key)) {
              doHalt(entry.key, 'unrecoverable_gap');
              break;
            }
          }
          if (!(await applyOne(entryToKeyed(entry)))) break;
          done.push(entry.id);
        }
        // AFTER the commits that cover them.
        await deps.source.ack(done);
      }

      await refreshLag().catch(() => undefined);
      return appliedThisRun;
    },

    status() {
      return { offset, lag, halted };
    },

    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          try {
            await consumer.runOnce();
          } catch (error) {
            deps.onCycleFailed(error);
          }
          if (halted || !running) {
            // Halted: stay up and visible, but do nothing until an operator
            // restarts the process after fixing the cause (runbook).
            if (halted) await new Promise((r) => setTimeout(r, deps.intervalMs ?? 5_000));
            continue;
          }
          if (deps.intervalMs) await new Promise((r) => setTimeout(r, deps.intervalMs));
        }
      })();
    },

    async stop() {
      running = false;
      await loop;
      await deps.source.close?.();
    },
  };
  return consumer;
}

function entryToKeyed(entry: StreamEntry): KeyedRaw {
  return { key: entry.key, raw: entry.raw };
}
