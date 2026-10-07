import { createMarketDataRepository, type EventKey, type PrismaClient } from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import { notional } from '@wallet/types';
import type { WalletMetrics } from '../../observability/metrics.js';
import {
  createSequencedConsumer,
  type Reemitter,
  type SequencedConsumer,
  type SequencedConsumerStatus,
} from '../engine-stream/sequenced-consumer.js';
import {
  decodeSettlementEvent,
  formatKey,
  UndecodableEventError,
  type SettlementEvent,
} from '../settlement/events.js';
import { MalformedStreamEntryError, type SettlementEventSource } from '../settlement/source.js';
import { constraintHaltReason } from '../settlement/worker.js';

/**
 * The persisted public trade tape for ONE market (ADR-0036 §§4-6).
 *
 * Reads the engine's stream — never `fills` — and records each `Fill` as a
 * public trade, recomputing the one-minute candle it lands in, in the same
 * transaction that advances its offset. It shares HOW it reads with the
 * settlement worker and nothing else: a different consumer name, a different
 * offset row, a different consumer group, and no money.
 *
 * It does not wait for settlement, and a halted settlement worker does not
 * stop it. An event it cannot record halts THIS consumer for THIS market, and
 * stops nothing else.
 */

/** The row in `engine_offsets`, and the Redis consumer group. */
export const MARKET_DATA_CONSUMER = 'market-data';

class TapeHaltError extends Error {
  constructor(readonly reason: string) {
    super(`trade tape halted: ${reason}`);
    this.name = 'TapeHaltError';
  }
}

export interface TapeConsumerDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly metrics?: WalletMetrics;
  readonly market: { readonly id: string; readonly symbol: string };
  readonly source: SettlementEventSource;
  readonly reemitter: Reemitter;
  readonly startKey?: EventKey;
  readonly batchSize?: number;
  readonly blockMs?: number;
  readonly pageSize?: number;
  readonly intervalMs?: number;
  /** Called after a trade has COMMITTED: the ticker has changed. */
  readonly onTrade?: () => void;
}

export interface TapeConsumer extends Omit<SequencedConsumer, 'status'> {
  status(): SequencedConsumerStatus & { readonly market: string };
}

export class TapeStartRefusedError extends Error {
  constructor(readonly market: string) {
    super(
      `the trade tape for ${market} has no offset and no configured start key ` +
        '(TRADING_MARKET_DATA_START). Refusing to guess where the tape begins.',
    );
    this.name = 'TapeStartRefusedError';
  }
}

type TapeOutcome = 'recorded' | 'duplicate' | 'noop';

/** `k` from the engine's fill id `seq:k`. It must name THIS sequence. */
function fillIndex(event: Extract<SettlementEvent, { kind: 'fill' }>): number {
  const match = /^(\d+):(\d+)$/.exec(event.fillId);
  if (!match || BigInt(match[1]!) !== event.seq) throw new TapeHaltError('fill_id_mismatch');
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) throw new TapeHaltError('fill_id_mismatch');
  return index;
}

export function createTapeConsumer(deps: TapeConsumerDeps): TapeConsumer {
  const label = { market: deps.market.symbol };

  const consumer = createSequencedConsumer<SettlementEvent, TapeOutcome>({
    db: deps.db,
    marketId: deps.market.id,
    source: deps.source,
    reemitter: deps.reemitter,
    consumer: MARKET_DATA_CONSUMER,
    ...(deps.startKey === undefined ? {} : { startKey: deps.startKey }),
    ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
    ...(deps.blockMs === undefined ? {} : { blockMs: deps.blockMs }),
    ...(deps.pageSize === undefined ? {} : { pageSize: deps.pageSize }),
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),

    // The same strict decoder settlement uses: an event of a shape it does not
    // know is never dropped, because a dropped fill is a candle that is wrong.
    decode: decodeSettlementEvent,

    async apply({ tx, event }) {
      if (event.kind !== 'fill') return 'noop';
      const repository = createMarketDataRepository(tx);
      const at = new Date(Number(event.timestampMs));
      const inserted = await repository.insertTrade(
        {
          market: deps.market.id,
          seq: event.seq,
          fillIndex: fillIndex(event),
          price: event.price,
          qty: event.qty,
          // The same integer both legs of the fill settle at (ADR-0026).
          quoteQty: notional(event.price, event.qty),
          takerSide: event.takerSide,
          engineTimestamp: at,
        },
        tx,
      );
      if (!inserted) return 'duplicate';
      // Recomputed from the bucket's trades, not appended to: this trade may
      // have landed in a bucket that is no longer the latest (ADR-0036 §6).
      await repository.recomputeCandle(deps.market.id, at, tx);
      return 'recorded';
    },

    haltReason(error) {
      if (error instanceof TapeHaltError) return error.reason;
      if (error instanceof UndecodableEventError) return 'undecodable_event';
      if (error instanceof MalformedStreamEntryError) return 'malformed_stream_entry';
      return constraintHaltReason(error);
    },

    onApplied(outcome) {
      if (outcome !== 'recorded') return;
      deps.metrics?.tradesRecorded.inc(label);
      deps.onTrade?.();
    },

    onHalt(key, reason) {
      deps.metrics?.marketDataHalts.inc(label);
      // By KEY: it carries no user, order, amount or price.
      deps.logger.error('trade tape halted at an event it cannot record', {
        event: 'market_data.halted',
        outcome: 'failure',
        targetType: 'market',
        targetId: deps.market.symbol,
        reason: `${formatKey(key)}:${reason}`,
      });
      logSecurityEvent(deps.logger, 'market_data.halted', {
        outcome: 'failure',
        targetType: 'market',
        targetId: deps.market.symbol,
        reason,
      });
    },

    onRecovered(cause, applied) {
      logSecurityEvent(deps.logger, 'market_data.recovered', {
        outcome: 'success',
        targetType: 'market',
        targetId: deps.market.symbol,
        reason: cause,
        count: applied,
      });
    },

    onTransient(key, error) {
      deps.logger.warn('trade tape could not record an event this cycle; retrying later', {
        outcome: 'failure',
        targetType: 'market',
        targetId: deps.market.symbol,
        reason: formatKey(key),
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    },

    onStartRefused() {
      logSecurityEvent(deps.logger, 'market_data.start_refused', {
        outcome: 'failure',
        targetType: 'market',
        targetId: deps.market.symbol,
      });
    },

    onCycleFailed(error) {
      deps.logger.error('trade tape cycle failed', {
        targetType: 'market',
        targetId: deps.market.symbol,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    },

    onLag(sequences) {
      deps.metrics?.marketDataLag.set(sequences, label);
    },

    startRefused: () => new TapeStartRefusedError(deps.market.symbol),
  });

  return {
    init: () => consumer.init(),
    runOnce: () => consumer.runOnce(),
    start: () => consumer.start(),
    stop: () => consumer.stop(),
    status: () => ({ market: deps.market.symbol, ...consumer.status() }),
  };
}
