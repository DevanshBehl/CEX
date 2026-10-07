import {
  compareKeys,
  Prisma,
  createSettlementRepository,
  withTransaction,
  type EventKey,
  type PrismaClient,
} from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import type { WalletMetrics } from '../../observability/metrics.js';
import { createSettlementApplier, SettlementHaltError, type SettlementMarket } from './applier.js';
import {
  decodeSettlementEvent,
  formatKey,
  keyByPosition,
  UndecodableEventError,
  type KeyedRaw,
} from './events.js';
import { HoldInvariantError } from './holds.js';
import { MalformedStreamEntryError, type SettlementEventSource, type StreamEntry } from './source.js';

/**
 * The settlement worker for ONE market (ADR-0034, prompt_phase_s4.md §§6, 9, 12).
 *
 * The only writer of state that engine events drive. For each event, in
 * `(seq, idx)` order:
 *
 *   1. skip it if the offset is already at or past its key;
 *   2. if it is not the very next key, recover the gap from the engine's
 *      journal (`GET /v1/events`) before going further;
 *   3. in ONE serializable transaction: apply it, then advance the offset;
 *   4. only after that commits, `XACK` it.
 *
 * Crash anywhere and nothing is lost or doubled. Before the commit: the offset
 * did not move, the entry is still pending, and it is redelivered. After the
 * commit and before the ack: it is redelivered and skipped by the offset.
 *
 * An event that cannot be settled HALTS this market at that key. It is not
 * skipped, not parked, and the offset does not pass it. Other markets are
 * unaffected: each has its own stream, offset and worker.
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

export interface SettlementWorkerDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly metrics?: WalletMetrics;
  readonly market: SettlementMarket & { readonly symbol: string };
  readonly source: SettlementEventSource;
  readonly reemitter: Reemitter;
  /** Names this worker's row in `engine_offsets`. */
  readonly consumer: string;
  /**
   * Where to start when there is no offset row. Required then: the worker
   * never assumes `(0, 0)` and never assumes "latest" (rule 70a).
   */
  readonly startKey?: EventKey;
  readonly batchSize?: number;
  readonly blockMs?: number;
  readonly pageSize?: number;
  /** Attempts at one event before a transient failure ends the cycle. */
  readonly transientRetries?: number;
  readonly intervalMs?: number;
  readonly clock?: () => Date;
}

export interface SettlementWorkerStatus {
  readonly market: string;
  readonly offset: EventKey | null;
  readonly halted: { readonly key: string; readonly reason: string } | null;
}

export interface SettlementWorker {
  /** Load the offset. Throws if there is none and no start key is configured. */
  init(): Promise<void>;
  /** One read-and-apply pass. Returns how many events it applied, recovered ones included. */
  runOnce(): Promise<number>;
  status(): SettlementWorkerStatus;
  start(): void;
  stop(): Promise<void>;
}

/** Raised by `init` when the worker has neither an offset nor a start key. */
export class SettlementStartRefusedError extends Error {
  constructor(readonly market: string) {
    super(
      `settlement for ${market} has no offset and no configured start key ` +
        '(TRADING_SETTLEMENT_START). Refusing to guess where settlement begins.',
    );
    this.name = 'SettlementStartRefusedError';
  }
}

/** Halts: the event cannot be settled, and retrying will not change that. */
function haltReason(error: unknown): string | null {
  if (error instanceof SettlementHaltError) return error.reason;
  if (error instanceof HoldInvariantError) return error.reason;
  if (error instanceof UndecodableEventError) return 'undecodable_event';
  if (error instanceof MalformedStreamEntryError) return 'malformed_stream_entry';
  // A constraint refused the commit: the non-negative trading balance trigger,
  // a ledger balance check, a unique index. A bug the database caught, not a
  // condition that will pass.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const code = (error.meta as { code?: string } | undefined)?.code;
    if (code === '23514' || code === '23505' || code === '23503') return `constraint_${code}`;
  }
  const message = error instanceof Error ? error.message : '';
  const pg = /Code: `(23514|23505|23503)`/.exec(message);
  if (pg) return `constraint_${pg[1]!}`;
  return null;
}

/** The key that must come next after `offset`, if the stream is contiguous. */
function follows(offset: EventKey, key: EventKey): boolean {
  if (key.seq === offset.seq) return key.idx === offset.idx + 1;
  // Sequences are contiguous: every command emits at least one event.
  return key.seq === offset.seq + 1n && key.idx === 0;
}

export function createSettlementWorker(deps: SettlementWorkerDeps): SettlementWorker {
  const applier = createSettlementApplier();
  const settlement = createSettlementRepository(deps.db);
  const now = deps.clock ?? (() => new Date());
  const batch = deps.batchSize ?? 100;
  const blockMs = deps.blockMs ?? 1_000;
  const pageSize = deps.pageSize ?? 500;
  const retries = deps.transientRetries ?? 5;
  const label = { market: deps.market.symbol };

  let offset: EventKey | null = null;
  let halted: { key: string; reason: string } | null = null;
  let appliedThisRun = 0;
  let running = false;
  let loop: Promise<void> | undefined;

  function doHalt(key: EventKey, reason: string): void {
    halted = { key: formatKey(key), reason };
    deps.metrics?.settlementHalts.inc(label);
    deps.metrics?.settlementEvents.inc({ ...label, outcome: 'halted' });
    // Loud, and by KEY: the key carries no user, order, amount or price.
    deps.logger.error('settlement halted at an event it cannot settle', {
      event: 'settlement.halted',
      outcome: 'failure',
      targetType: 'market',
      targetId: deps.market.symbol,
      reason: `${formatKey(key)}:${reason}`,
    });
    logSecurityEvent(deps.logger, 'settlement.halted', {
      outcome: 'failure',
      targetType: 'market',
      targetId: deps.market.symbol,
      reason,
    });
  }

  /**
   * Apply one event and advance the offset to its key, atomically. Returns
   * false if this market is now halted, or a transient failure outlasted its
   * retries (the event will be tried again next cycle).
   */
  async function applyOne(item: KeyedRaw): Promise<boolean> {
    const current = offset;
    if (current === null) throw new Error('worker used before init');
    if (compareKeys(item.key, current) <= 0) return true;

    let event;
    try {
      event = decodeSettlementEvent(item.raw);
    } catch (error) {
      doHalt(item.key, haltReason(error) ?? 'undecodable_event');
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
        await applier.prepare(deps.db, deps.market, event);
        const correlationId = `settlement:${deps.market.symbol}:${formatKey(item.key)}`;
        const outcome = await withTransaction(deps.db, async (tx) => {
          const result = await applier.apply({
            tx,
            market: deps.market,
            key: item.key,
            event,
            correlationId,
          });
          // In the SAME transaction as the work it records (rule 65).
          await createSettlementRepository(tx).advanceOffset(
            deps.consumer,
            deps.market.id,
            item.key,
            tx,
          );
          return result;
        });

        offset = item.key;
        appliedThisRun += 1;
        deps.metrics?.settlementEvents.inc({
          ...label,
          outcome: outcome.kind === 'duplicate' ? 'duplicate' : 'applied',
        });
        if (outcome.kind === 'fill_settled') {
          deps.metrics?.fillsSettled.inc(label);
          if (outcome.fees > 0n) {
            deps.metrics?.feesAccrued.inc({ asset: outcome.quoteAsset }, Number(outcome.fees));
          }
          const latency = (now().getTime() - Number(outcome.timestampMs)) / 1000;
          if (latency >= 0) deps.metrics?.settlementLatency.observe(latency, label);
        }
        return true;
      } catch (error) {
        const reason = haltReason(error);
        if (reason !== null) {
          doHalt(item.key, reason);
          return false;
        }
        // Transient: a lost connection, a timeout. withTransaction already
        // retried serialization conflicts; a 40001 is never a halt (rule 91).
        if (attempt >= retries) {
          deps.logger.warn('settlement could not apply an event this cycle; retrying later', {
            outcome: 'failure',
            targetType: 'market',
            targetId: deps.market.symbol,
            reason: formatKey(item.key),
            errorName: error instanceof Error ? error.name : 'unknown',
          });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 50 * 2 ** attempt)));
      }
    }
  }

  /**
   * Re-derive everything after the offset from the engine's journal (rule 69).
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
        doHalt({ seq: after + 1n, idx: 0 }, haltReason(error) ?? 'undecodable_event');
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
    logSecurityEvent(deps.logger, 'settlement.recovered', {
      outcome: 'success',
      targetType: 'market',
      targetId: deps.market.symbol,
      reason: cause,
      count: applied,
    });
    return true;
  }

  async function refreshLag(): Promise<void> {
    const last = await deps.reemitter.lastSeq();
    if (last !== null && offset !== null) {
      deps.metrics?.settlementLag.set(Number(last - offset.seq), label);
    }
  }

  return {
    async init() {
      const stored = await settlement.getOffset(deps.consumer, deps.market.id);
      if (stored) {
        offset = stored;
        return;
      }
      if (!deps.startKey) {
        logSecurityEvent(deps.logger, 'settlement.start_refused', {
          outcome: 'failure',
          targetType: 'market',
          targetId: deps.market.symbol,
        });
        throw new SettlementStartRefusedError(deps.market.symbol);
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
        // AFTER the commits that cover them (rule 66).
        await deps.source.ack(done);
      }

      await refreshLag().catch(() => undefined);
      return appliedThisRun;
    },

    status() {
      return { market: deps.market.symbol, offset, halted };
    },

    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          try {
            await this.runOnce();
          } catch (error) {
            deps.logger.error('settlement cycle failed', {
              targetType: 'market',
              targetId: deps.market.symbol,
              errorName: error instanceof Error ? error.name : 'unknown',
            });
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
}

function entryToKeyed(entry: StreamEntry): KeyedRaw {
  return { key: entry.key, raw: entry.raw };
}
