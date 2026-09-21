import { Prisma } from '@prisma/client';
import { canOrderTransition, type OrderStatus } from '@wallet/types';
import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

/**
 * Orders, and the order history (prompt_phase_s3.md §§10-11).
 *
 * The interface is shaped around the one ordering rule the gateway depends on:
 * the ORDER ROW IS WRITTEN FIRST, `ON CONFLICT DO NOTHING`, and the hold is
 * posted only if that insert won. A repeated `clientOrderId` therefore returns
 * the existing order and never posts a second hold.
 *
 * The order row names its hold before the hold exists, which is why
 * `createPending` hands back a pre-generated ledger transaction id for the
 * caller to post under. A deferred foreign key refuses to commit an order whose
 * hold was never posted.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderKind = 'limit' | 'market';
export type OrderTimeInForce = 'GTC' | 'IOC' | 'FOK';

export interface OrderRecord {
  readonly id: string;
  readonly userId: string;
  readonly clientOrderId: string;
  readonly market: string;
  readonly side: OrderSide;
  readonly kind: OrderKind;
  readonly timeInForce: OrderTimeInForce;
  readonly postOnly: boolean;
  /** Scaled price as a decimal string, or null for a market order. */
  readonly price: string | null;
  readonly qty: string;
  readonly filledQty: string;
  readonly status: OrderStatus;
  readonly holdAsset: string;
  /** The hold AS POSTED. What is still held is a ledger projection. */
  readonly holdAmount: string;
  readonly holdLedgerTransactionId: string;
  readonly engineSeq: string | null;
  readonly rejectReason: string | null;
  readonly sweepAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePendingOrderInput {
  readonly userId: string;
  readonly clientOrderId: string;
  readonly market: string;
  readonly side: OrderSide;
  readonly kind: OrderKind;
  readonly timeInForce: OrderTimeInForce;
  readonly postOnly: boolean;
  readonly price: string | null;
  readonly qty: string;
  readonly holdAsset: string;
  readonly holdAmount: string;
  readonly correlationId?: string;
}

export type CreatePendingOrderResult =
  | {
      readonly outcome: 'created';
      readonly order: OrderRecord;
      /** Post the hold under THIS id, in the same transaction. */
      readonly holdLedgerTransactionId: string;
    }
  | { readonly outcome: 'existing'; readonly order: OrderRecord };

export interface OrderTransitionPatch {
  readonly filledQty?: string;
  readonly engineSeq?: string;
  readonly rejectReason?: string;
}

export interface OrderTransitionInput {
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly reason?: string;
  readonly correlationId?: string;
  readonly patch?: OrderTransitionPatch;
}

export interface OrderRepository {
  createPending(input: CreatePendingOrderInput, tx?: Executor): Promise<CreatePendingOrderResult>;
  findById(id: string, tx?: Executor): Promise<OrderRecord | null>;
  findByClientOrderId(
    userId: string,
    clientOrderId: string,
    tx?: Executor,
  ): Promise<OrderRecord | null>;
  /**
   * Move an order between states, guarded on its current state.
   *
   * Returns null when the order was not in `from` — another actor moved it
   * first. That is a lost race, not an error.
   */
  transition(input: OrderTransitionInput, tx?: Executor): Promise<OrderRecord | null>;
  /**
   * Claim the oldest order stuck in PENDING_ENGINE, for the sweeper.
   *
   * `FOR UPDATE SKIP LOCKED`, so concurrent sweepers take different rows. The
   * claim does NOT transition the order: only the engine's journal can say what
   * happened to it, and the sweeper acts on that answer.
   */
  claimPendingEngine(olderThan: Date, tx?: Executor): Promise<OrderRecord | null>;
  listOpenForUser(userId: string, market: string, tx?: Executor): Promise<OrderRecord[]>;
  countOpenForUser(userId: string, market: string, tx?: Executor): Promise<number>;
}

const OPEN_STATUSES: readonly OrderStatus[] = [
  'PENDING_ENGINE',
  'OPEN',
  'PARTIALLY_FILLED',
  'PENDING_CANCEL',
];

export function createOrderRepository(db: Executor): OrderRepository {
  const exec = (tx?: Executor) => tx ?? db;

  return {
    /**
     * Idempotent by construction: ON CONFLICT DO NOTHING, never try/catch — a
     * failed statement aborts the whole PostgreSQL transaction.
     *
     * Under a concurrent duplicate, the second insert blocks on the unique index
     * until the first commits, then does nothing and returns the existing order.
     * It never reaches the hold, so it can never post a second one.
     */
    async createPending(input, tx) {
      const e = exec(tx);
      const id = newId();
      const holdLedgerTransactionId = newId();

      const rows = await e.$queryRaw<Array<{ id: string }>>`
        INSERT INTO orders (
          id, user_id, client_order_id, market, side, kind, time_in_force,
          post_only, price, qty, status, hold_asset, hold_amount,
          hold_ledger_transaction_id, created_at, updated_at
        ) VALUES (
          ${id}::uuid, ${input.userId}::uuid, ${input.clientOrderId}, ${input.market},
          ${input.side}::"OrderSide", ${input.kind}::"OrderKind",
          ${input.timeInForce}::"OrderTimeInForce", ${input.postOnly},
          ${input.price === null ? null : new Prisma.Decimal(input.price)},
          ${new Prisma.Decimal(input.qty)}, 'PENDING_ENGINE'::"OrderStatus",
          ${input.holdAsset}, ${new Prisma.Decimal(input.holdAmount)},
          ${holdLedgerTransactionId}::uuid, now(), now()
        )
        ON CONFLICT (user_id, client_order_id) DO NOTHING
        RETURNING id
      `;

      if (rows.length === 0) {
        const existing = await this.findByClientOrderId(input.userId, input.clientOrderId, e);
        if (!existing) throw new Error('order conflict resolved to nothing');
        return { outcome: 'existing', order: existing };
      }

      await e.$executeRaw`
        INSERT INTO order_transitions (id, order_id, from_status, to_status, correlation_id, created_at)
        VALUES (${newId()}::uuid, ${id}::uuid, NULL, 'PENDING_ENGINE'::"OrderStatus",
                ${input.correlationId ?? null}, now())
      `;

      const created = await e.order.findUniqueOrThrow({ where: { id } });
      return { outcome: 'created', order: toRecord(created), holdLedgerTransactionId };
    },

    async findById(id, tx) {
      const row = await exec(tx).order.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async findByClientOrderId(userId, clientOrderId, tx) {
      const row = await exec(tx).order.findUnique({
        where: { userId_clientOrderId: { userId, clientOrderId } },
      });
      return row ? toRecord(row) : null;
    },

    async transition(input, tx) {
      const e = exec(tx);
      // Checked here too, so an illegal transition is a comprehensible error at
      // the call site rather than a trigger violation three layers down.
      if (!canOrderTransition(input.from, input.to)) {
        throw new Error(`illegal order transition ${input.from} -> ${input.to}`);
      }

      const patch = input.patch ?? {};
      const updated = await e.order.updateMany({
        where: { id: input.orderId, status: input.from },
        data: {
          status: input.to,
          ...(patch.filledQty !== undefined
            ? { filledQty: new Prisma.Decimal(patch.filledQty) }
            : {}),
          ...(patch.engineSeq !== undefined ? { engineSeq: BigInt(patch.engineSeq) } : {}),
          ...(patch.rejectReason !== undefined ? { rejectReason: patch.rejectReason } : {}),
        },
      });
      if (updated.count === 0) return null;

      await e.$executeRaw`
        INSERT INTO order_transitions (id, order_id, from_status, to_status, reason, correlation_id, created_at)
        VALUES (${newId()}::uuid, ${input.orderId}::uuid,
                ${input.from}::"OrderStatus", ${input.to}::"OrderStatus",
                ${input.reason ?? null}, ${input.correlationId ?? null}, now())
      `;
      return this.findById(input.orderId, e);
    },

    async claimPendingEngine(olderThan, tx) {
      const e = exec(tx);
      const rows = await e.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM orders
        WHERE status = 'PENDING_ENGINE'::"OrderStatus"
          AND created_at < ${olderThan}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const id = rows[0]?.id;
      if (id === undefined) return null;
      await e.order.update({ where: { id }, data: { sweepAttempts: { increment: 1 } } });
      return this.findById(id, e);
    },

    async listOpenForUser(userId, market, tx) {
      const rows = await exec(tx).order.findMany({
        where: { userId, market, status: { in: [...OPEN_STATUSES] } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toRecord);
    },

    async countOpenForUser(userId, market, tx) {
      return exec(tx).order.count({
        where: { userId, market, status: { in: [...OPEN_STATUSES] } },
      });
    },
  };
}

function toRecord(row: {
  id: string;
  userId: string;
  clientOrderId: string;
  market: string;
  side: OrderSide;
  kind: OrderKind;
  timeInForce: OrderTimeInForce;
  postOnly: boolean;
  price: Prisma.Decimal | null;
  qty: Prisma.Decimal;
  filledQty: Prisma.Decimal;
  status: OrderStatus;
  holdAsset: string;
  holdAmount: Prisma.Decimal;
  holdLedgerTransactionId: string;
  engineSeq: bigint | null;
  rejectReason: string | null;
  sweepAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}): OrderRecord {
  // `.toFixed(0)`, never `.toString()`: a Decimal can render in exponential
  // notation, which is not a base-unit integer string.
  return {
    id: row.id,
    userId: row.userId,
    clientOrderId: row.clientOrderId,
    market: row.market,
    side: row.side,
    kind: row.kind,
    timeInForce: row.timeInForce,
    postOnly: row.postOnly,
    price: row.price === null ? null : row.price.toFixed(0),
    qty: row.qty.toFixed(0),
    filledQty: row.filledQty.toFixed(0),
    status: row.status,
    holdAsset: row.holdAsset,
    holdAmount: row.holdAmount.toFixed(0),
    holdLedgerTransactionId: row.holdLedgerTransactionId,
    engineSeq: row.engineSeq === null ? null : row.engineSeq.toString(),
    rejectReason: row.rejectReason,
    sweepAttempts: row.sweepAttempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
