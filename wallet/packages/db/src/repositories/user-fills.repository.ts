import { Prisma } from '@prisma/client';
import type { Executor } from '../transaction.js';

/**
 * A user's OWN side of their fills (prompt_phase_s5.md rules 124, 132).
 *
 * `fills` holds both users, both orders and both fees. Every query here is
 * filtered by one user id IN THE QUERY and selects that user's columns only —
 * the counterparty's user id, order id and fee are never read, so they cannot
 * be returned. This is the only reader of `fills` outside settlement and
 * reconciliation.
 */

export interface UserFillRecord {
  /** The engine's `seq:k`, without the market qualifier settlement stores. */
  readonly fillId: string;
  /** Cluster-qualified market id. */
  readonly market: string;
  readonly seq: bigint;
  readonly idx: number;
  readonly orderId: string;
  readonly side: 'buy' | 'sell';
  readonly role: 'maker' | 'taker';
  readonly price: bigint;
  readonly qty: bigint;
  readonly notional: bigint;
  readonly fee: bigint;
  readonly feeBps: number;
  readonly engineTimestamp: Date;
  readonly createdAt: Date;
}

export interface UserFillsRepository {
  /** Newest first by settlement order `(created_at, seq, idx)`. */
  listForUser(
    userId: string,
    options: {
      readonly market?: string;
      readonly limit: number;
      /** Fills settled strictly before this one's cursor. */
      readonly before?: { readonly createdAt: Date; readonly seq: bigint; readonly idx: number };
      /** Fills settled at or after this time, oldest first. */
      readonly since?: Date;
    },
    tx?: Executor,
  ): Promise<UserFillRecord[]>;
}

interface Row {
  fill_id: string;
  market: string;
  seq: bigint;
  idx: number;
  order_id: string;
  side: 'buy' | 'sell';
  role: 'maker' | 'taker';
  price: string;
  qty: string;
  notional: string;
  fee: string;
  fee_bps: number;
  engine_timestamp: Date;
  created_at: Date;
}

export function createUserFillsRepository(db: Executor): UserFillsRepository {
  return {
    async listForUser(userId, options, tx) {
      const market = options.market ? Prisma.sql`AND f.market = ${options.market}` : Prisma.empty;
      const before = options.before
        ? Prisma.sql`AND (f.created_at, f.seq, f.idx) <
            (${options.before.createdAt}, ${options.before.seq}, ${options.before.idx})`
        : Prisma.empty;
      const since = options.since ? Prisma.sql`AND f.created_at >= ${options.since}` : Prisma.empty;
      const order = options.since
        ? Prisma.sql`ORDER BY f.created_at ASC, f.seq ASC, f.idx ASC`
        : Prisma.sql`ORDER BY f.created_at DESC, f.seq DESC, f.idx DESC`;

      // A user is on exactly one side: the engine never matches an order
      // against its own account (self-trade prevention), so `taker_user_id =
      // maker_user_id` does not occur and each row maps to one view.
      const rows = await (tx ?? db).$queryRaw<Row[]>`
        SELECT
          f.fill_id,
          f.market,
          f.seq,
          f.idx,
          CASE WHEN f.taker_user_id = ${userId}::uuid
            THEN f.taker_order_id ELSE f.maker_order_id END::text AS order_id,
          CASE WHEN f.taker_user_id = ${userId}::uuid
            THEN f.taker_side::text
            ELSE CASE WHEN f.taker_side = 'buy' THEN 'sell' ELSE 'buy' END END AS side,
          CASE WHEN f.taker_user_id = ${userId}::uuid THEN 'taker' ELSE 'maker' END AS role,
          f.price::text AS price,
          f.qty::text AS qty,
          f.notional::text AS notional,
          CASE WHEN f.taker_user_id = ${userId}::uuid
            THEN f.taker_fee ELSE f.maker_fee END::text AS fee,
          CASE WHEN f.taker_user_id = ${userId}::uuid
            THEN f.taker_fee_bps ELSE f.maker_fee_bps END AS fee_bps,
          f.engine_timestamp,
          f.created_at
        FROM fills f
        WHERE (f.taker_user_id = ${userId}::uuid OR f.maker_user_id = ${userId}::uuid)
          ${market} ${before} ${since}
        ${order}
        LIMIT ${options.limit}
      `;
      return rows.map((row) => ({
        // Settlement qualifies the id by market (`<market>:<seq>:<k>`); the
        // engine's own id is what the public tape shows, so return that.
        fillId: row.fill_id.startsWith(`${row.market}:`)
          ? row.fill_id.slice(row.market.length + 1)
          : row.fill_id,
        market: row.market,
        seq: row.seq,
        idx: row.idx,
        orderId: row.order_id,
        side: row.side,
        role: row.role,
        price: BigInt(row.price),
        qty: BigInt(row.qty),
        notional: BigInt(row.notional),
        fee: BigInt(row.fee),
        feeBps: row.fee_bps,
        engineTimestamp: row.engine_timestamp,
        createdAt: row.created_at,
      }));
    },
  };
}
