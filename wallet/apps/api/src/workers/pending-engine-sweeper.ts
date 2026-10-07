import {
  createOrderRepository,
  withTransaction,
  type OrderRecord,
  type PrismaClient,
} from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import type { DeadLetterQueue } from '../observability/dead-letter.js';
import type { MarketRegistry } from '../services/trading/markets.js';
import type { OrderService } from '../services/trading/order.service.js';

/**
 * Resolve orders stuck in PENDING_ENGINE (prompt_phase_s3.md §14).
 *
 * An order is stuck for one of two reasons that look identical from the
 * database: the gateway died before calling the engine, or the engine accepted
 * the command and could not confirm publication (a 503). The second has
 * MATCHED. Only the engine's journal can tell them apart, so the sweeper asks
 * it — never the book, which has forgotten an order that filled in full.
 *
 * # When "never seen" is proof
 *
 * Not immediately. The gateway gives up on a request after its timeout, but the
 * request can still be queued inside the engine and applied later — for as
 * long as its signed timestamp is inside the engine's tolerance window
 * (ADR-0031). Releasing the hold before then risks an order that matches with
 * nothing held. So `never_seen` is acted on only once the order is older than
 * that window, after which the engine refuses the request forever.
 *
 * # Giving up never releases
 *
 * An order the sweeper cannot resolve becomes a dead letter for an operator.
 * Its hold stays. A released hold on an order that turns out to have matched is
 * money reserved for nothing; a kept hold on one that did not is a user waiting
 * on a runbook. Only one of those is recoverable.
 */

export interface PendingEngineSweeperDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly orders: OrderService;
  readonly markets: MarketRegistry;
  readonly deadLetters: DeadLetterQueue;
  /** How old an order must be before it is first asked about. */
  readonly afterMs: number;
  readonly intervalMs: number;
  readonly maxAttempts: number;
  /** MUST equal the engine's tolerance window (TRADING_ENGINE_TOLERANCE_SECONDS). */
  readonly engineToleranceSeconds: number;
  readonly batchSize?: number;
  readonly clock?: () => Date;
}

export interface PendingEngineSweeper {
  runOnce(): Promise<{ resolved: number; failed: number; deferred: number }>;
  start(): void;
  stop(): void;
}

/** Headroom for clock skew between the gateway and the engine. */
const SKEW_MARGIN_MS = 60_000;

export function createPendingEngineSweeper(deps: PendingEngineSweeperDeps): PendingEngineSweeper {
  const now = deps.clock ?? (() => new Date());
  const batch = deps.batchSize ?? 25;
  const conclusiveAfterMs = deps.engineToleranceSeconds * 1000 + SKEW_MARGIN_MS;

  // The combination that would dead-letter every stuck order before it could
  // ever be proven unseen. Refused at construction, not discovered in an
  // incident.
  if (deps.maxAttempts * deps.intervalMs <= conclusiveAfterMs) {
    throw new Error(
      `TRADING_SWEEPER_MAX_ATTEMPTS x TRADING_SWEEPER_INTERVAL_MS (${String(
        deps.maxAttempts * deps.intervalMs,
      )}ms) must exceed the engine tolerance plus skew (${String(conclusiveAfterMs)}ms), or ` +
        'every stuck order is dead-lettered before "never seen" can be proven',
    );
  }

  const deadLettered = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  async function claim(): Promise<OrderRecord | null> {
    const at = now();
    return withTransaction(deps.db, (tx) =>
      createOrderRepository(tx).claimPendingEngine(new Date(at.getTime() - deps.afterMs), tx, {
        notAttemptedSince: new Date(at.getTime() - deps.intervalMs),
        maxAttempts: deps.maxAttempts,
      }),
    );
  }

  async function resolve(order: OrderRecord): Promise<'resolved' | 'failed' | 'deferred'> {
    const correlationId = `sweeper:${order.id}`;
    const symbol = order.market.slice(order.market.indexOf(':') + 1);
    const entry = deps.markets.get(symbol);
    if (!entry) return 'deferred';

    const lookup = await entry.engine.lookup(order.id);

    if (lookup.outcome === 'seen') {
      // Derive the outcome from what the engine EMITTED for that sequence, not
      // from the fact that it saw the order: it may have rejected it.
      // Re-emission pages end only at sequence boundaries (ADR-0034 §1), so
      // the page's first sequence — this one — is whole however many events
      // it has: a taker sweeping a deep book is not resolved from a truncated
      // list (prompt_phase_s4.md rule 103e).
      const events = await entry.engine.events(lookup.seq - 1n, 1);
      if (events === null) return 'deferred';
      const forSeq = events.filter((event) => event.seq === lookup.seq);
      const after = await deps.orders.resolvePending(order, forSeq, correlationId);
      return after.status === 'PENDING_ENGINE' ? 'deferred' : 'resolved';
    }

    if (lookup.outcome === 'never_seen') {
      const age = now().getTime() - order.createdAt.getTime();
      if (age <= conclusiveAfterMs) {
        // Not proof yet: a request the gateway abandoned may still be queued
        // inside the engine. Ask again later.
        return 'deferred';
      }
      await deps.orders.failNeverSeen(order, correlationId);
      return 'failed';
    }

    // `rebuilding` or `unreachable`: NO answer. Doing nothing is the only safe
    // action — reading it as "never seen" releases a hold on a live order.
    return 'deferred';
  }

  return {
    async runOnce() {
      const counts = { resolved: 0, failed: 0, deferred: 0 };
      for (let i = 0; i < batch; i += 1) {
        const order = await claim();
        if (!order) break;
        try {
          counts[await resolve(order)] += 1;
        } catch (error) {
          counts.deferred += 1;
          deps.logger.warn('sweeper could not resolve an order this cycle', {
            event: 'trading.sweeper_resolved',
            outcome: 'failure',
            targetType: 'order',
            targetId: order.id,
            errorName: error instanceof Error ? error.name : 'unknown',
          });
        }

        // The claim already counted this attempt. Past the budget the order is
        // an operator's, and it keeps its hold.
        if (order.sweepAttempts + 1 >= deps.maxAttempts && !deadLettered.has(order.id)) {
          const current = await createOrderRepository(deps.db).findById(order.id);
          if (current?.status === 'PENDING_ENGINE') {
            deadLettered.add(order.id);
            deps.deadLetters.record({
              queue: 'order_pending_engine',
              reference: order.id,
              idempotencyKey: order.clientOrderId,
              attempts: order.sweepAttempts + 1,
              errorName: 'unresolved_pending_engine',
              correlationId: `sweeper:${order.id}`,
            });
            logSecurityEvent(deps.logger, 'trading.sweeper_dead_letter', {
              outcome: 'failure',
              targetType: 'order',
              targetId: order.id,
            });
          }
        }
      }
      return counts;
    },

    start() {
      const tick = async (): Promise<void> => {
        try {
          await this.runOnce();
        } catch (error) {
          deps.logger.error('sweeper cycle failed', {
            errorName: error instanceof Error ? error.name : 'unknown',
          });
        }
        timer = setTimeout(() => void tick(), deps.intervalMs);
      };
      timer = setTimeout(() => void tick(), deps.intervalMs);
    },

    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}
