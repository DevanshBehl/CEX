import { Prisma, type EventKey, type PrismaClient } from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import type { WalletMetrics } from '../../observability/metrics.js';
import {
  createSequencedConsumer,
  type Reemitter,
  type SequencedConsumer,
} from '../engine-stream/sequenced-consumer.js';
import { createSettlementApplier, SettlementHaltError, type SettlementMarket } from './applier.js';
import { decodeSettlementEvent, formatKey, UndecodableEventError } from './events.js';
import { HoldInvariantError } from './holds.js';
import { MalformedStreamEntryError, type SettlementEventSource } from './source.js';

/**
 * The settlement worker for ONE market (ADR-0034, prompt_phase_s4.md §§6, 9, 12).
 *
 * The only writer of state that engine events drive. HOW it reads — in order,
 * exactly once by position, recovering gaps from the journal, halting rather
 * than skipping — is the sequenced consumer it shares with the market-data
 * tape (`engine-stream/sequenced-consumer.ts`). WHAT it does with an event is
 * here and in the applier, and nothing else does it.
 *
 * An event that cannot be settled HALTS this market at that key. It is not
 * skipped, not parked, and the offset does not pass it. Other markets are
 * unaffected: each has its own stream, offset and worker.
 */

export type { Reemitter };

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
  readonly lag: number | null;
  readonly halted: { readonly key: string; readonly reason: string } | null;
}

export interface SettlementWorker extends Omit<SequencedConsumer, 'status'> {
  status(): SettlementWorkerStatus;
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

/** A constraint the database refused: a bug it caught, not a condition that will pass. */
export function constraintHaltReason(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const code = (error.meta as { code?: string } | undefined)?.code;
    if (code === '23514' || code === '23505' || code === '23503') return `constraint_${code}`;
  }
  const message = error instanceof Error ? error.message : '';
  const pg = /Code: `(23514|23505|23503)`/.exec(message);
  return pg ? `constraint_${pg[1]!}` : null;
}

/** Halts: the event cannot be settled, and retrying will not change that. */
function haltReason(error: unknown): string | null {
  if (error instanceof SettlementHaltError) return error.reason;
  if (error instanceof HoldInvariantError) return error.reason;
  if (error instanceof UndecodableEventError) return 'undecodable_event';
  if (error instanceof MalformedStreamEntryError) return 'malformed_stream_entry';
  // The non-negative trading balance trigger, a ledger balance check, a
  // unique index.
  return constraintHaltReason(error);
}

export function createSettlementWorker(deps: SettlementWorkerDeps): SettlementWorker {
  const applier = createSettlementApplier();
  const now = deps.clock ?? (() => new Date());
  const label = { market: deps.market.symbol };

  const consumer = createSequencedConsumer({
    db: deps.db,
    marketId: deps.market.id,
    source: deps.source,
    reemitter: deps.reemitter,
    consumer: deps.consumer,
    ...(deps.startKey === undefined ? {} : { startKey: deps.startKey }),
    ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
    ...(deps.blockMs === undefined ? {} : { blockMs: deps.blockMs }),
    ...(deps.pageSize === undefined ? {} : { pageSize: deps.pageSize }),
    ...(deps.transientRetries === undefined ? {} : { transientRetries: deps.transientRetries }),
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),

    decode: decodeSettlementEvent,
    prepare: (event) => applier.prepare(deps.db, deps.market, event),
    apply: ({ tx, key, event }) =>
      applier.apply({
        tx,
        market: deps.market,
        key,
        event,
        correlationId: `settlement:${deps.market.symbol}:${formatKey(key)}`,
      }),
    haltReason,

    onApplied(outcome) {
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
    },

    onHalt(key, reason) {
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
    },

    onRecovered(cause, applied) {
      logSecurityEvent(deps.logger, 'settlement.recovered', {
        outcome: 'success',
        targetType: 'market',
        targetId: deps.market.symbol,
        reason: cause,
        count: applied,
      });
    },

    onTransient(key, error) {
      deps.logger.warn('settlement could not apply an event this cycle; retrying later', {
        outcome: 'failure',
        targetType: 'market',
        targetId: deps.market.symbol,
        reason: formatKey(key),
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    },

    onStartRefused() {
      logSecurityEvent(deps.logger, 'settlement.start_refused', {
        outcome: 'failure',
        targetType: 'market',
        targetId: deps.market.symbol,
      });
    },

    onCycleFailed(error) {
      deps.logger.error('settlement cycle failed', {
        targetType: 'market',
        targetId: deps.market.symbol,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    },

    onLag(sequences) {
      deps.metrics?.settlementLag.set(sequences, label);
    },

    startRefused: () => new SettlementStartRefusedError(deps.market.symbol),
  });

  return {
    init: () => consumer.init(),
    runOnce: () => consumer.runOnce(),
    start: () => consumer.start(),
    stop: () => consumer.stop(),
    status: () => ({ market: deps.market.symbol, ...consumer.status() }),
  };
}
