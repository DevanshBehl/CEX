import {
  createLedgerRepository,
  createOrderRepository,
  createSettlementRepository,
  type EventKey,
  type Executor,
  type OrderRecord,
  type PrismaClient,
} from '@wallet/db';
import { postTradeSettlement } from '@wallet/ledger';
import { fillAmounts } from '@wallet/orders';
import { isTerminalOrder, orderHoldsFunds, type OrderStatus } from '@wallet/types';
import { postLedger } from '../trading/ledger-post.js';
import type { SettlementEvent } from './events.js';
import { feeRatesFor } from './fee-tiers.js';
import { HoldInvariantError, releaseOutstanding } from './holds.js';

/**
 * Applying ONE engine event to the books (ADR-0034 §§3, 6).
 *
 * Everything here runs inside the caller's SERIALIZABLE transaction, which also
 * advances the offset. Either all of it commits — the fill row, its
 * `trade_settle`, the order transitions, any terminal release, the offset — or
 * none of it does.
 *
 * Anything this cannot settle throws `SettlementHaltError`: an unknown order,
 * an order in the wrong market or asset, a hold that would be over-consumed, a
 * status the event cannot legally follow. The worker stops AT that key. It
 * never skips it: skipping settles every later fill for the same users against
 * a ledger missing one (prompt_phase_s4.md §12).
 *
 * The reason is a code from a closed set. It never carries an id, an amount or
 * a price (rule 106).
 */

export class SettlementHaltError extends Error {
  constructor(readonly reason: string) {
    super(`settlement halted: ${reason}`);
    this.name = 'SettlementHaltError';
  }
}

const halt = (reason: string): never => {
  throw new SettlementHaltError(reason);
};

/**
 * The id a fill is settled under: the engine's `seq:k`, qualified by market.
 * The ledger reference and `fills.fill_id` are both this (ADR-0034 §3).
 */
export function settlementFillId(market: SettlementMarket, engineFillId: string): string {
  return `${market.id}:${engineFillId}`;
}

export interface SettlementMarket {
  /** Cluster-qualified market id, as orders record it. */
  readonly id: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
}

export type ApplyOutcome =
  | {
      readonly kind: 'fill_settled';
      readonly quoteAsset: string;
      readonly fees: bigint;
      readonly timestampMs: bigint;
    }
  /** The fill was already settled: delivery is at-least-once. */
  | { readonly kind: 'duplicate' }
  /** A disposition moved an order, and released whatever it still held. */
  | { readonly kind: 'applied' }
  /** Nothing to do: the event changed nothing the books record. */
  | { readonly kind: 'noop' };

export interface SettlementApplier {
  /**
   * Create the accounts an event will credit, OUTSIDE the settlement
   * transaction — exactly as the gateway does before posting a hold — so the
   * serializable transaction never races account creation.
   */
  prepare(db: PrismaClient, market: SettlementMarket, event: SettlementEvent): Promise<void>;
  apply(input: {
    readonly tx: Executor;
    readonly market: SettlementMarket;
    readonly key: EventKey;
    readonly event: SettlementEvent;
    readonly correlationId: string;
  }): Promise<ApplyOutcome>;
}

/** Orders a `Cancelled` or an `Expired` may finish, besides one already finished. */
const CANCELLABLE: ReadonlySet<OrderStatus> = new Set(['OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL']);
const EXPIRABLE: ReadonlySet<OrderStatus> = new Set(['PENDING_ENGINE', 'OPEN', 'PARTIALLY_FILLED']);

/**
 * Every order the gateway creates has a UUID id. An id of any other shape —
 * an S2 load-client order, typically — is not in `orders`, and asking the
 * database for it is a type error rather than "not found": left to reach the
 * query it would be retried as a transient failure, forever, instead of halting.
 */
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many times a guarded transition is retried after losing to another writer. */
const CONTENTION_RETRIES = 3;

export function createSettlementApplier(): SettlementApplier {
  async function load(tx: Executor, orderId: string, market: SettlementMarket) {
    // An S2 load-client order, or a bug. Either way it has no hold to consume.
    if (!ORDER_ID.test(orderId)) return halt('unknown_order');
    const order = await createOrderRepository(tx).findById(orderId, tx);
    if (!order) return halt('unknown_order');
    if (order.market !== market.id) return halt('order_market_mismatch');
    return order;
  }

  /**
   * Record a fill's quantity on one order, moving its status as the quantity
   * requires. Returns the order after the move.
   *
   * A partial fill on PENDING_CANCEL patches `filled_qty` and leaves the
   * status alone: moving it to PARTIALLY_FILLED would forget the cancel in
   * flight (ADR-0034 §6).
   */
  async function recordFill(
    tx: Executor,
    start: OrderRecord,
    traded: bigint,
    key: EventKey,
    correlationId: string,
  ): Promise<OrderRecord> {
    const orders = createOrderRepository(tx);
    let order = start;
    for (let attempt = 0; attempt <= CONTENTION_RETRIES; attempt += 1) {
      const filled = BigInt(order.filledQty) + traded;
      const qty = BigInt(order.qty);
      if (filled > qty) return halt('overfill');
      const complete = filled === qty;
      const patch = {
        filledQty: filled.toString(),
        ...(order.engineSeq === null ? { engineSeq: key.seq.toString() } : {}),
      };

      let moved: OrderRecord | null;
      switch (order.status) {
        case 'PENDING_ENGINE':
        case 'OPEN':
          moved = await orders.transition(
            {
              orderId: order.id,
              from: order.status,
              to: complete ? 'FILLED' : 'PARTIALLY_FILLED',
              reason: 'fill',
              correlationId,
              patch,
            },
            tx,
          );
          break;
        case 'PARTIALLY_FILLED':
        case 'PENDING_CANCEL':
          moved = complete
            ? await orders.transition(
                {
                  orderId: order.id,
                  from: order.status,
                  to: 'FILLED',
                  reason: 'fill',
                  correlationId,
                  patch,
                },
                tx,
              )
            : await orders.recordFill(order.id, order.status, filled.toString(), tx);
          break;
        default:
          // A fill for an order that is already terminal: released, failed or
          // filled. Its hold is gone, so there is nothing to consume.
          return halt('fill_for_terminal_order');
      }
      if (moved) return moved;
      // Lost to the gateway's guarded PENDING_ENGINE -> OPEN. Re-read and
      // apply the same fill from wherever it went.
      const current = await orders.findById(order.id, tx);
      if (!current) return halt('unknown_order');
      order = current;
    }
    return halt('order_contended');
  }

  /**
   * Move an order to a terminal status and release what it still holds — in
   * that order, so only the winner of the guarded transition releases.
   * Returns false if the order was already terminal (another path finished
   * it: a lost race, not an error).
   */
  async function finish(
    tx: Executor,
    start: OrderRecord,
    allowedFrom: ReadonlySet<OrderStatus>,
    to: OrderStatus,
    reason: string,
    correlationId: string,
    rejectReason?: string,
  ): Promise<boolean> {
    const orders = createOrderRepository(tx);
    let order = start;
    for (let attempt = 0; attempt <= CONTENTION_RETRIES; attempt += 1) {
      if (order.status === to) return false;
      if (isTerminalOrder(order.status) || !allowedFrom.has(order.status)) {
        return halt(`${to.toLowerCase()}_from_${order.status.toLowerCase()}`);
      }
      const moved = await orders.transition(
        {
          orderId: order.id,
          from: order.status,
          to,
          reason,
          correlationId,
          ...(rejectReason === undefined ? {} : { patch: { rejectReason } }),
        },
        tx,
      );
      if (moved) {
        await releaseOutstanding(tx, moved);
        return true;
      }
      const current = await orders.findById(order.id, tx);
      if (!current) return halt('unknown_order');
      order = current;
    }
    return halt('order_contended');
  }

  /**
   * Rule 79: the order's status and the ledger agree. A holding order still
   * holds something; a terminal one holds exactly nothing.
   */
  async function assertHoldAgrees(tx: Executor, orderId: string): Promise<void> {
    const order = await createOrderRepository(tx).findById(orderId, tx);
    const outstanding = await createSettlementRepository(tx).outstandingHold(orderId, tx);
    if (!order || outstanding === null) return halt('unknown_order');
    if (orderHoldsFunds(order.status) ? outstanding <= 0n : outstanding !== 0n) {
      halt(orderHoldsFunds(order.status) ? 'holding_order_holds_nothing' : 'terminal_order_holds_funds');
    }
  }

  async function settleFill(
    tx: Executor,
    market: SettlementMarket,
    key: EventKey,
    event: Extract<SettlementEvent, { kind: 'fill' }>,
    correlationId: string,
  ): Promise<ApplyOutcome> {
    const taker = await load(tx, event.takerOrderId, market);
    const maker = await load(tx, event.makerOrderId, market);
    if (taker.side !== event.takerSide || maker.side === taker.side) return halt('side_mismatch');

    // The buyer is the taker when the taker bought; otherwise the maker is.
    // Derived once, here — getting it backwards balances (ADR-0034 §3).
    const buyer = event.takerSide === 'buy' ? taker : maker;
    const seller = event.takerSide === 'buy' ? maker : taker;
    if (buyer.holdAsset !== market.quoteAsset || seller.holdAsset !== market.baseAsset) {
      return halt('hold_asset_mismatch');
    }

    const at = { quoteAsset: market.quoteAsset, timestampMs: event.timestampMs };
    const takerRates = await feeRatesFor(tx, { userId: taker.userId, ...at });
    const makerRates = await feeRatesFor(tx, { userId: maker.userId, ...at });
    const amounts = fillAmounts({
      price: event.price,
      qty: event.qty,
      takerSide: event.takerSide,
      takerTier: takerRates,
      makerTier: makerRates,
    });

    // The engine's `seq:k` is unique within ONE market only: every market's
    // first fill is `1:0`. Unqualified, a second market's fill would collide
    // with the first's, read as "already settled", and be skipped without a
    // trace. The settlement reference is qualified by market.
    const fillId = settlementFillId(market, event.fillId);

    // The constraint decides whether this fill was already settled — never a
    // read beforehand (rule 57).
    const recorded = await createSettlementRepository(tx).insertFill(
      {
        fillId,
        market: market.id,
        key,
        takerOrderId: taker.id,
        makerOrderId: maker.id,
        takerUserId: taker.userId,
        makerUserId: maker.userId,
        takerSide: event.takerSide,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        price: event.price,
        qty: event.qty,
        notional: amounts.notional,
        takerFeeBps: amounts.takerBps,
        makerFeeBps: amounts.makerBps,
        takerFee: amounts.takerFee,
        makerFee: amounts.makerFee,
        engineTimestamp: new Date(Number(event.timestampMs)),
      },
      tx,
    );
    if (recorded.outcome === 'already_settled') return { kind: 'duplicate' };

    await postLedger(
      tx,
      postTradeSettlement({
        fillId,
        buyerId: buyer.userId,
        sellerId: seller.userId,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        qty: event.qty,
        notional: amounts.notional,
        buyerFee: amounts.buyerFee,
        sellerFee: amounts.sellerFee,
      }),
      recorded.ledgerTransactionId,
    );

    // Rule 73, after the posting so the fill row counts: neither hold may go
    // below zero. No constraint on the ORDER refuses an over-consumption — and
    // posting one would hide a hold or fee bug inside a balanced transaction.
    const settlement = createSettlementRepository(tx);
    for (const order of [buyer, seller]) {
      const outstanding = await settlement.outstandingHold(order.id, tx);
      if (outstanding === null || outstanding < 0n) halt('over_consumption');
    }

    for (const order of [taker, maker]) {
      const updated = await recordFill(tx, order, event.qty, key, correlationId);
      // A maker's terminal event IS this fill: nothing follows it (rule 79a).
      if (updated.status === 'FILLED') await releaseOutstanding(tx, updated);
    }
    await assertHoldAgrees(tx, taker.id);
    await assertHoldAgrees(tx, maker.id);

    return {
      kind: 'fill_settled',
      quoteAsset: market.quoteAsset,
      fees: amounts.buyerFee + amounts.sellerFee,
      timestampMs: event.timestampMs,
    };
  }

  /** `remaining` as the engine reports it must match what the books say is unfilled. */
  function checkRemaining(order: OrderRecord, remaining: bigint): void {
    if (BigInt(order.qty) - BigInt(order.filledQty) !== remaining) halt('remaining_mismatch');
  }

  return {
    async prepare(db, market, event) {
      if (event.kind !== 'fill') return;
      // Unknown orders halt inside the transaction, with the right reason.
      if (!ORDER_ID.test(event.takerOrderId) || !ORDER_ID.test(event.makerOrderId)) return;
      const orders = createOrderRepository(db);
      const taker = await orders.findById(event.takerOrderId);
      const maker = await orders.findById(event.makerOrderId);
      if (!taker || !maker) return;
      const buyer = event.takerSide === 'buy' ? taker : maker;
      const seller = event.takerSide === 'buy' ? maker : taker;
      await createLedgerRepository(db).ensureAccounts([
        { ownerId: buyer.userId, asset: market.baseAsset, type: 'user_trading_available' },
        { ownerId: seller.userId, asset: market.quoteAsset, type: 'user_trading_available' },
        { ownerId: null, asset: market.quoteAsset, type: 'house_trading_fees' },
      ]);
    },

    async apply({ tx, market, key, event, correlationId }) {
      switch (event.kind) {
        case 'fill':
          return settleFill(tx, market, key, event, correlationId);

        case 'cancelled': {
          const order = await load(tx, event.orderId, market);
          if (order.status !== 'CANCELLED') checkRemaining(order, event.remainingQty);
          const moved = await finish(tx, order, CANCELLABLE, 'CANCELLED', 'cancelled', correlationId);
          await assertHoldAgrees(tx, order.id);
          return { kind: moved ? 'applied' : 'noop' };
        }

        case 'expired': {
          const order = await load(tx, event.orderId, market);
          if (order.status !== 'EXPIRED') checkRemaining(order, event.remainingQty);
          const moved = await finish(tx, order, EXPIRABLE, 'EXPIRED', 'expired', correlationId);
          await assertHoldAgrees(tx, order.id);
          return { kind: moved ? 'applied' : 'noop' };
        }

        case 'rejected': {
          // Answering a cancel or an amend: the order is already gone — filled
          // or cancelled earlier — and its hold already consumed or released.
          // Release NOTHING (rule 78). The order may not even be one the
          // gateway knows: an amend names the OLD order.
          if (event.reason === 'UNKNOWN_ORDER') return { kind: 'noop' };
          const order = await load(tx, event.orderId, market);
          // A placement rejection: nothing entered the book.
          if (BigInt(order.filledQty) !== 0n) return halt('rejected_after_fill');
          const moved = await finish(
            tx,
            order,
            new Set<OrderStatus>(['PENDING_ENGINE']),
            'REJECTED',
            'rejected',
            correlationId,
            event.reason,
          );
          await assertHoldAgrees(tx, order.id);
          return { kind: moved ? 'applied' : 'noop' };
        }

        case 'accepted': {
          const order = await load(tx, event.orderId, market);
          checkRemaining(order, event.restingQty);
          if (event.restingQty === 0n) {
            // Fully filled: the fills before it already finished the order.
            if (order.status !== 'FILLED') halt('accepted_unfilled');
            return { kind: 'noop' };
          }
          if (order.status !== 'PENDING_ENGINE') return { kind: 'noop' };
          // Resting. The gateway makes this move too; whichever is first wins.
          await createOrderRepository(tx).transition(
            {
              orderId: order.id,
              from: 'PENDING_ENGINE',
              to: 'OPEN',
              reason: 'accepted',
              correlationId,
              patch: { engineSeq: key.seq.toString() },
            },
            tx,
          );
          return { kind: 'noop' };
        }

        case 'status_changed':
          return { kind: 'noop' };
      }
    },
  };
}

export { HoldInvariantError };
