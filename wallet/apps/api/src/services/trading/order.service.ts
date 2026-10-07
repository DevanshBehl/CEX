import {
  createLedgerRepository,
  createOrderRepository,
  createOrderRiskDecisionRepository,
  withTransaction,
  type OrderRecord,
  type PrismaClient,
} from '@wallet/db';
import {
  ConflictError,
  DependencyUnavailableError,
  InsufficientFundsError,
  NotFoundError,
  PolicyDeniedError,
  ValidationError,
} from '@wallet/errors';
import { postOrderHold } from '@wallet/ledger';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import { collarBand, computeHold, validateOrder } from '@wallet/orders';
import { evaluateOrder, toOrderClientMessage, type OrderRiskPolicy } from '@wallet/risk';
import {
  isTerminalOrder,
  notional,
  type Cluster,
  type Market,
  type OrderRequest,
  type OrderStatus,
  type Price,
  type Qty,
} from '@wallet/types';
import type { EngineEvent, EngineResult } from './engine-client.js';
import type { MarketEntry, MarketRegistry } from './markets.js';
import { postLedger } from './ledger-post.js';
import { releaseOutstanding } from '../settlement/holds.js';

/**
 * The order gateway (prompt_phase_s3.md §§11-15).
 *
 * # The sequence this whole phase turns on
 *
 *   1. structural validation, pre-trade risk              — no money touched
 *   2. ONE serializable transaction: order row, then hold  — the funds check
 *   3. the engine call, with a fresh request id
 *   4. act on the outcome — and on `ambiguous`, do NOTHING
 *
 * The hold is posted BEFORE the engine is told the order exists, and no
 * database constraint stands behind it: the deferred trigger enforces per-asset
 * balance, not non-negative balances. The serializable read-then-post in step 2
 * is the only sufficient-funds check there is.
 *
 * # Who writes what
 *
 * This service creates orders, posts holds, and resolves `PENDING_ENGINE`. It
 * releases a hold only for an order the engine reports it NEVER FILLED —
 * rejected, expired or cancelled at full quantity. Anything a fill touched is
 * left for the settlement worker (prompt_phase_s4.md §6), because releasing a
 * hold that a fill is about to consume drives it negative.
 */

export interface PlaceOrderInput {
  readonly userId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'limit' | 'market';
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
  readonly price: string | null;
  readonly qty: string;
  readonly postOnly: boolean;
  readonly clientOrderId: string;
  readonly correlationId: string;
}

export interface AmendOrderInput {
  readonly userId: string;
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly price: string;
  readonly qty: string;
  readonly correlationId: string;
}

export interface OrderService {
  place(input: PlaceOrderInput): Promise<OrderRecord>;
  cancel(userId: string, orderId: string, correlationId: string): Promise<OrderRecord>;
  cancelAll(userId: string, symbol: string, correlationId: string): Promise<OrderRecord[]>;
  amend(input: AmendOrderInput): Promise<OrderRecord>;
  get(userId: string, orderId: string): Promise<OrderRecord>;
  list(userId: string, symbol: string | undefined, limit: number): Promise<OrderRecord[]>;
  /** One page of a user's orders, newest first, with a cursor. */
  page(
    userId: string,
    options: {
      readonly symbol?: string;
      readonly limit: number;
      readonly openOnly: boolean;
      readonly before?: { readonly createdAt: Date; readonly id: string };
    },
  ): Promise<OrderRecord[]>;
  /**
   * Resolve a PENDING_ENGINE order from what the engine reported about it.
   * Shared with the sweeper, so a placement and its later recovery act the same.
   */
  resolvePending(
    order: OrderRecord,
    events: readonly EngineEvent[],
    correlationId: string,
  ): Promise<OrderRecord>;
  /** Mark an order the engine provably never received, and release its hold. */
  failNeverSeen(order: OrderRecord, correlationId: string): Promise<OrderRecord>;
}

export interface OrderServiceDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly cluster: Cluster;
  readonly markets: MarketRegistry;
  readonly riskPolicy: OrderRiskPolicy;
  readonly clock?: () => Date;
}

/** Round a price DOWN to a tick. */
const floorToTick = (price: bigint, tick: bigint): bigint => (price / tick) * tick;
/** Round a price UP to a tick. */
const ceilToTick = (price: bigint, tick: bigint): bigint => ((price + tick - 1n) / tick) * tick;

export function createOrderService(deps: OrderServiceDeps): OrderService {
  const orders = createOrderRepository(deps.db);
  const decisions = createOrderRiskDecisionRepository(deps.db);
  const ledger = createLedgerRepository(deps.db);
  const now = deps.clock ?? (() => new Date());

  async function routable(symbol: string): Promise<{ entry: MarketEntry; market: Market }> {
    const entry = deps.markets.get(symbol);
    if (!entry) throw new NotFoundError('Unknown market');
    const result = await deps.markets.routable(symbol);
    if (!result.ok) {
      // An unreachable or misconfigured engine is refused BEFORE any hold is
      // taken — there is then nothing to resolve later.
      throw new DependencyUnavailableError(`matching-engine:${symbol}`);
    }
    return { entry, market: result.market };
  }

  function symbolOf(marketId: string): string {
    return marketId.slice(marketId.indexOf(':') + 1);
  }

  /**
   * Post a terminal release and move the order in ONE transaction.
   *
   * The guarded transition runs first: whoever wins it posts the release, and
   * anyone else finds the order already moved and posts nothing. The partial
   * unique index on `order_release` is the backstop if two paths ever race from
   * different states — an order is released exactly once.
   *
   * The amount is the order's OUTSTANDING hold, through the one release
   * function every path shares (ADR-0034 §2) — and this path asserts that it
   * equals the whole hold. Every caller acts on an engine response that proves
   * the order never filled; the assertion is what proves the response was read
   * right. If a fill has been settled against it, the commit is refused rather
   * than a consumed hold released twice.
   */
  async function finalizeUnfilled(
    order: OrderRecord,
    from: OrderStatus,
    to: OrderStatus,
    reason: string,
    correlationId: string,
  ): Promise<OrderRecord> {
    return withTransaction(deps.db, async (tx) => {
      const moved = await createOrderRepository(tx).transition(
        {
          orderId: order.id,
          from,
          to,
          reason,
          correlationId,
          ...(to === 'REJECTED' ? { patch: { rejectReason: reason } } : {}),
        },
        tx,
      );
      if (!moved) {
        return (await createOrderRepository(tx).findById(order.id, tx)) ?? order;
      }
      await releaseOutstanding(tx, moved, { requireUnfilled: true });
      return moved;
    });
  }

  /**
   * Move a resting order to PENDING_CANCEL, and do not lose to a fill.
   *
   * The settlement worker moves orders too (OPEN -> PARTIALLY_FILLED), so the
   * guarded transition can lose a race it could never lose in S3. A lost race
   * re-reads and tries again from the status it finds; only a TERMINAL status
   * ends the request without reaching the engine. If contention outlasts the
   * retries, the order is returned as it stands and the caller still sends the
   * cancel: the engine's `Cancelled` can be recorded from OPEN or
   * PARTIALLY_FILLED directly (prompt_phase_s4.md rule 103c).
   */
  async function toPendingCancel(
    start: OrderRecord,
    reason: string,
    correlationId: string,
  ): Promise<OrderRecord> {
    let order = start;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (order.status !== 'OPEN' && order.status !== 'PARTIALLY_FILLED') return order;
      const moved = await orders.transition({
        orderId: order.id,
        from: order.status,
        to: 'PENDING_CANCEL',
        reason,
        correlationId,
      });
      if (moved) return moved;
      order = (await orders.findById(order.id)) ?? order;
    }
    return order;
  }

  function touches(event: EngineEvent, orderId: string): boolean {
    if (event.kind === 'fill')
      return event.takerOrderId === orderId || event.makerOrderId === orderId;
    if (event.kind === 'status_changed') return false;
    return event.orderId === orderId;
  }

  async function resolvePending(
    order: OrderRecord,
    events: readonly EngineEvent[],
    correlationId: string,
  ): Promise<OrderRecord> {
    const mine = events.filter((event) => touches(event, order.id));
    const filled = mine.some((event) => event.kind === 'fill');
    const rejected = mine.find((event) => event.kind === 'rejected');
    const expired = mine.find((event) => event.kind === 'expired');

    if (rejected && rejected.kind === 'rejected') {
      // Nothing entered the book: the whole hold comes back.
      return finalizeUnfilled(order, 'PENDING_ENGINE', 'REJECTED', rejected.reason, correlationId);
    }
    if (expired && !filled) {
      // An IOC/FOK/market order that took nothing. Never filled, so release.
      return finalizeUnfilled(
        order,
        'PENDING_ENGINE',
        'EXPIRED',
        'expired_unfilled',
        correlationId,
      );
    }
    if (mine.length === 0) {
      // The engine said nothing about this order. Leave it for the sweeper
      // rather than guess.
      return order;
    }
    // Accepted — resting, or filled in part or whole. Fills and whatever they
    // imply belong to the settlement worker; this service only records that the
    // engine has the order. A lost race (the worker already moved it) is not an
    // error.
    const moved = await orders.transition({
      orderId: order.id,
      from: 'PENDING_ENGINE',
      to: 'OPEN',
      reason: filled ? 'accepted_with_fills' : 'accepted',
      correlationId,
      ...(mine[0] ? { patch: { engineSeq: mine[0].seq.toString() } } : {}),
    });
    return moved ?? (await orders.findById(order.id)) ?? order;
  }

  async function actOnPlacement(
    order: OrderRecord,
    result: EngineResult,
    correlationId: string,
  ): Promise<OrderRecord> {
    if (result.kind === 'ambiguous') {
      // ADR-0030: the command may be journaled and the book may have mutated.
      // Do NOT release the hold, do NOT reject, do NOT re-place. The sweeper
      // asks the journal.
      deps.logger.warn('engine outcome ambiguous; order left for the sweeper', {
        event: 'trading.placement_ambiguous',
        outcome: 'failure',
        targetType: 'order',
        targetId: order.id,
        reason: result.cause,
      });
      return order;
    }
    if (result.kind === 'refused') {
      // 400/401/404: the request never reached the book, so nothing was
      // journaled and nothing can fill. A gateway bug, logged as one — and
      // the order fails with its hold returned.
      deps.logger.error('engine refused a placement request', {
        event: 'trading.engine_refused',
        outcome: 'failure',
        targetType: 'order',
        targetId: order.id,
        reason: `${String(result.status)}:${result.error}`,
      });
      return finalizeUnfilled(
        order,
        'PENDING_ENGINE',
        'FAILED',
        `engine_refused_${String(result.status)}`,
        correlationId,
      );
    }
    return resolvePending(order, result.events, correlationId);
  }

  async function openNotionalFor(
    userId: string,
    market: Market,
    reference: bigint | null,
  ): Promise<bigint> {
    const open = await orders.listOpenForUser(userId, market.id);
    let total = 0n;
    for (const o of open) {
      const remaining = BigInt(o.qty) - BigInt(o.filledQty);
      const price = o.price === null ? reference : BigInt(o.price);
      if (price === null || remaining <= 0n) continue;
      total += notional(price, remaining);
    }
    return total;
  }

  /**
   * Everything that must pass before money is touched: structure, then risk.
   * Returns what the hold and the engine call need.
   */
  async function admit(input: {
    userId: string;
    clientOrderId: string;
    entry: MarketEntry;
    market: Market;
    request: OrderRequest;
    excludeOrder?: OrderRecord;
  }): Promise<{ reference: bigint | null; notionalValue: bigint }> {
    const book = await input.entry.engine.book();
    if (!book) throw new DependencyUnavailableError(`matching-engine:${input.entry.symbol}`);
    const reference = book.referencePrice;

    const validation = validateOrder({ request: input.request, market: input.market, reference });
    if (!validation.ok) {
      // Structural reasons are the market's published rules — tick, lot,
      // minimum — so naming them is information the client needs, not a limit
      // it could probe.
      throw new ValidationError(
        validation.reasons.map((reason) => ({ path: 'order', message: reason })),
        "The order does not meet this market's rules",
      );
    }

    const user = await deps.db.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { status: true },
    });
    const at = now();
    let openOrderCount = await orders.countOpenForUser(input.userId, input.market.id);
    let openNotional = await openNotionalFor(input.userId, input.market, reference);
    if (input.excludeOrder) {
      // An amend replaces an order: count the replacement, not both.
      openOrderCount = Math.max(0, openOrderCount - 1);
      const old = input.excludeOrder;
      if (old.price !== null) {
        const remaining = BigInt(old.qty) - BigInt(old.filledQty);
        openNotional -= remaining > 0n ? notional(BigInt(old.price), remaining) : 0n;
      }
    }
    const recentPlacements = await orders.listPlacementTimes(
      input.userId,
      new Date(at.getTime() - deps.riskPolicy.orderRateWindowSeconds * 1000),
    );
    const notionalValue = validation.notional ?? 0n;
    const riskInput = {
      userId: input.userId,
      accountStatus: user.status,
      market: input.market.id,
      qty: BigInt(input.request.qty),
      notional: notionalValue,
      openOrderCount,
      openNotional,
      recentPlacements,
      now: at,
    };
    const decision = evaluateOrder(riskInput, deps.riskPolicy);
    await decisions.record({
      userId: input.userId,
      clientOrderId: input.clientOrderId,
      market: input.market.id,
      verdict: decision.verdict,
      codes: decision.codes,
      evaluatedRules: decision.evaluatedRules,
      inputSnapshot: {
        accountStatus: riskInput.accountStatus,
        qty: riskInput.qty.toString(),
        notional: riskInput.notional.toString(),
        openOrderCount,
        openNotional: openNotional.toString(),
        recentPlacementCount: recentPlacements.length,
        now: at.toISOString(),
      },
      outcomes: decision.outcomes.map((o) => ({ ...o })),
      policyVersion: decision.policyVersion,
    });
    if (decision.verdict === 'deny') {
      logSecurityEvent(deps.logger, 'trading.order_denied', {
        outcome: 'failure',
        userId: input.userId,
        targetType: 'market',
        targetId: input.market.id,
        reason: decision.codes.join(','),
      });
      // Generic to the client; the codes stay in the persisted decision.
      throw new PolicyDeniedError(decision.codes, toOrderClientMessage(decision.codes));
    }
    return { reference, notionalValue };
  }

  /**
   * The order row and its hold, in one serializable transaction.
   *
   * Insert first, ON CONFLICT DO NOTHING — so a repeated clientOrderId finds
   * the existing order and never reaches the hold. Then read the trading
   * balance and post the hold, refusing if it cannot cover. Refusing throws,
   * which rolls the order row back too: no order without a hold, and a deferred
   * foreign key refuses to commit one anyway.
   */
  async function createWithHold(input: {
    userId: string;
    clientOrderId: string;
    market: Market;
    request: OrderRequest;
    hold: { asset: string; amount: bigint };
    correlationId: string;
  }): Promise<{ created: boolean; order: OrderRecord }> {
    await ledger.ensureAccounts([
      { ownerId: input.userId, asset: input.hold.asset, type: 'user_trading_available' },
      { ownerId: input.userId, asset: input.hold.asset, type: 'user_order_locked' },
    ]);

    return withTransaction(deps.db, async (tx) => {
      const result = await createOrderRepository(tx).createPending(
        {
          userId: input.userId,
          clientOrderId: input.clientOrderId,
          market: input.market.id,
          side: input.request.side,
          kind: input.request.type,
          timeInForce: input.request.timeInForce,
          postOnly: input.request.postOnly,
          price: input.request.price,
          qty: input.request.qty,
          holdAsset: input.hold.asset,
          holdAmount: input.hold.amount.toString(),
          correlationId: input.correlationId,
        },
        tx,
      );
      if (result.outcome === 'existing') return { created: false, order: result.order };

      // Read INSIDE the transaction that posts the hold, so a concurrent order
      // cannot slip between the two. Serializable isolation makes the loser
      // retry and see the reduced balance.
      const balances = await createLedgerRepository(tx).getUserTradingBalances(
        input.userId,
        deps.cluster,
        tx,
      );
      const available = BigInt(
        balances.find((b) => b.asset === input.hold.asset)?.available ?? '0',
      );
      if (available < input.hold.amount) throw new InsufficientFundsError();

      await postLedger(
        tx,
        postOrderHold({
          orderId: result.order.id,
          userId: input.userId,
          asset: input.hold.asset,
          amount: input.hold.amount,
        }),
        result.holdLedgerTransactionId,
      );
      return { created: true, order: result.order };
    });
  }

  /**
   * What the ENGINE is sent for this order.
   *
   * A market order goes as an IOC LIMIT at the protection price — the collar
   * edge, rounded to a tick in the direction that keeps it inside the band.
   * The gateway cannot see the engine's reference move between reading it and
   * matching, so an unbounded market buy could fill above what was held — and
   * no database constraint would refuse the settlement. A protection price
   * makes over-consumption impossible by construction: the engine may fill
   * better, never worse, and if its own collar has moved the other way it
   * rejects and the hold comes back.
   */
  function engineTerms(request: OrderRequest, market: Market, reference: bigint | null) {
    if (request.type === 'limit') {
      return {
        type: 'limit' as const,
        timeInForce: request.timeInForce,
        price: BigInt(request.price ?? '0'),
      };
    }
    if (reference === null) throw new Error('unreachable: validated with a reference');
    const band = collarBand(reference, market);
    const tick = BigInt(market.tickSize);
    const price =
      request.side === 'buy' ? floorToTick(band.upper, tick) : ceilToTick(band.lower, tick);
    return { type: 'limit' as const, timeInForce: 'IOC' as const, price };
  }

  return {
    async place(input) {
      const { entry, market } = await routable(input.symbol);

      // Idempotency first: the SAME order, returned as it stands — not
      // re-validated, not re-held, not re-sent (rule 103).
      const existing = await orders.findByClientOrderId(input.userId, input.clientOrderId);
      if (existing) return existing;

      const request: OrderRequest = {
        clientOrderId: input.clientOrderId,
        market: market.id,
        side: input.side,
        type: input.type,
        timeInForce: input.type === 'market' ? 'IOC' : input.timeInForce,
        price: input.type === 'market' ? null : (input.price as Price | null),
        qty: input.qty as Qty,
        postOnly: input.postOnly,
        stpMode: 'cancel_taker',
        accountId: input.userId,
      };

      const { reference } = await admit({
        userId: input.userId,
        clientOrderId: input.clientOrderId,
        entry,
        market,
        request,
      });
      // Never computed anywhere but here (rule 105).
      const hold = computeHold({ request, market, reference });
      const created = await createWithHold({
        userId: input.userId,
        clientOrderId: input.clientOrderId,
        market,
        request,
        hold,
        correlationId: input.correlationId,
      });
      if (!created.created) return created.order;

      const terms = engineTerms(request, market, reference);
      const result = await entry.engine.place({
        orderId: created.order.id,
        side: request.side,
        type: terms.type,
        timeInForce: terms.timeInForce,
        price: terms.price,
        qty: BigInt(request.qty),
        postOnly: request.postOnly,
        accountId: input.userId,
        timestampMs: now().getTime(),
      });
      return actOnPlacement(created.order, result, input.correlationId);
    },

    async cancel(userId, orderId, correlationId) {
      const order = await this.get(userId, orderId);
      if (isTerminalOrder(order.status)) return order;
      if (order.status === 'PENDING_ENGINE') {
        // The engine may not have it yet. Cancelling now would race the
        // placement; the sweeper resolves it first.
        throw new ConflictError('This order is still being placed. Try again in a moment.');
      }
      const entry = deps.markets.get(symbolOf(order.market));
      if (!entry) throw new NotFoundError('Unknown market');

      // OPEN / PARTIALLY_FILLED move to PENDING_CANCEL. An order already in
      // PENDING_CANCEL is re-sent: that is how an ambiguous cancel is retried,
      // and a cancel of an order the engine no longer has changes nothing.
      const current = await toPendingCancel(order, 'cancel_requested', correlationId);
      if (isTerminalOrder(current.status)) return current;

      const result = await entry.engine.cancel(orderId, now().getTime());
      if (result.kind !== 'ok') {
        deps.logger.warn('cancel not confirmed; order left PENDING_CANCEL', {
          event: 'trading.cancel_unconfirmed',
          outcome: 'failure',
          targetType: 'order',
          targetId: orderId,
          reason:
            result.kind === 'ambiguous' ? result.cause : `${String(result.status)}:${result.error}`,
        });
        return current;
      }
      const cancelled = result.events.find((e) => e.kind === 'cancelled' && e.orderId === orderId);
      if (
        cancelled &&
        cancelled.kind === 'cancelled' &&
        cancelled.remainingQty === BigInt(current.qty)
      ) {
        // Cancelled at full quantity: never filled, so the whole hold returns.
        // From whatever status it was left in: PENDING_CANCEL normally, OPEN
        // if contention kept it from getting there (ADR-0034 §6).
        return finalizeUnfilled(current, current.status, 'CANCELLED', 'cancelled', correlationId);
      }
      // Cancelled after fills, or `Rejected{UnknownOrder}` because it already
      // filled. Either way a fill touched this hold, and releasing it now would
      // drive it negative when settlement consumes the fill. Release NOTHING
      // (rule 130); the settlement worker finishes it.
      return current;
    },

    async cancelAll(userId, symbol, correlationId) {
      const entry = deps.markets.get(symbol);
      if (!entry) throw new NotFoundError('Unknown market');
      const open = await orders.listOpenForUser(userId, entry.market.id);
      const results: OrderRecord[] = [];
      // Each cancel is independent: one that fails does not stop the rest.
      for (const order of open) {
        if (order.status === 'PENDING_ENGINE') {
          results.push(order);
          continue;
        }
        try {
          results.push(await this.cancel(userId, order.id, correlationId));
        } catch {
          results.push((await orders.findById(order.id)) ?? order);
        }
      }
      return results;
    },

    async amend(input) {
      const old = await this.get(input.userId, input.orderId);
      if (old.status !== 'OPEN' && old.status !== 'PARTIALLY_FILLED') {
        throw new ConflictError('Only a resting order can be amended.');
      }
      if (old.kind !== 'limit') throw new ConflictError('Only a limit order can be amended.');
      const { entry, market } = await routable(symbolOf(old.market));

      const existing = await orders.findByClientOrderId(input.userId, input.clientOrderId);
      if (existing) return existing;

      // The engine's amend places a GTC, non-post-only limit on the old side.
      const request: OrderRequest = {
        clientOrderId: input.clientOrderId,
        market: market.id,
        side: old.side,
        type: 'limit',
        timeInForce: 'GTC',
        price: input.price as Price,
        qty: input.qty as Qty,
        postOnly: false,
        stpMode: 'cancel_taker',
        accountId: input.userId,
      };
      const { reference } = await admit({
        userId: input.userId,
        clientOrderId: input.clientOrderId,
        entry,
        market,
        request,
        excludeOrder: old,
      });
      const hold = computeHold({ request, market, reference });

      // TAKE, then release (prompt_phase_s4.md §14). The replacement is held in
      // full before the old order is touched, so there is never a moment where
      // a live order is unfunded. The user is briefly double-held — safe, and
      // the reason an amend needs free balance for the new hold.
      const created = await createWithHold({
        userId: input.userId,
        clientOrderId: input.clientOrderId,
        market,
        request,
        hold,
        correlationId: input.correlationId,
      });
      if (!created.created) return created.order;

      const pendingOld = await toPendingCancel(old, 'amend_requested', input.correlationId);

      const result = await entry.engine.amend({
        orderId: old.id,
        newOrderId: created.order.id,
        price: BigInt(input.price),
        qty: BigInt(input.qty),
        timestampMs: now().getTime(),
      });

      if (result.kind === 'refused') {
        // Never reached the engine: the replacement cannot exist there.
        return finalizeUnfilled(
          created.order,
          'PENDING_ENGINE',
          'FAILED',
          `engine_refused_${String(result.status)}`,
          input.correlationId,
        );
      }
      if (result.kind === 'ambiguous') return created.order;

      const oldCancelled = result.events.find(
        (e) => e.kind === 'cancelled' && e.orderId === old.id,
      );
      if (
        !isTerminalOrder(pendingOld.status) &&
        oldCancelled &&
        oldCancelled.kind === 'cancelled' &&
        oldCancelled.remainingQty === BigInt(old.qty)
      ) {
        await finalizeUnfilled(
          pendingOld,
          pendingOld.status,
          'CANCELLED',
          'amended',
          input.correlationId,
        );
      }
      if (!result.events.some((e) => touches(e, created.order.id))) {
        // The engine did not have the old order (it had filled), so it never
        // placed the replacement. Nothing entered the book for it.
        return finalizeUnfilled(
          created.order,
          'PENDING_ENGINE',
          'REJECTED',
          'UNKNOWN_ORDER',
          input.correlationId,
        );
      }
      return resolvePending(created.order, result.events, input.correlationId);
    },

    async get(userId, orderId) {
      const order = await orders.findById(orderId);
      // Another user's order is not found, never forbidden — a 403 would
      // confirm the id exists.
      if (!order || order.userId !== userId) throw new NotFoundError('Order not found');
      return order;
    },

    async list(userId, symbol, limit) {
      const marketId = symbol === undefined ? undefined : deps.markets.get(symbol)?.market.id;
      if (symbol !== undefined && marketId === undefined) throw new NotFoundError('Unknown market');
      return orders.listForUser(userId, marketId, limit);
    },

    async page(userId, options) {
      const marketId =
        options.symbol === undefined ? undefined : deps.markets.get(options.symbol)?.market.id;
      if (options.symbol !== undefined && marketId === undefined) {
        throw new NotFoundError('Unknown market');
      }
      return orders.pageForUser(userId, {
        ...(marketId === undefined ? {} : { market: marketId }),
        limit: options.limit,
        openOnly: options.openOnly,
        ...(options.before === undefined ? {} : { before: options.before }),
      });
    },

    resolvePending,

    async failNeverSeen(order, correlationId) {
      return finalizeUnfilled(
        order,
        'PENDING_ENGINE',
        'FAILED',
        'engine_never_received',
        correlationId,
      );
    },
  };
}
