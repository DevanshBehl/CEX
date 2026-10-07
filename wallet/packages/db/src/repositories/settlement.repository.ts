import { Prisma } from '@prisma/client';
import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

/**
 * Settlement persistence (ADR-0034): the fill record, the worker's position,
 * the per-day fee tier, and the one derived number everything else turns on —
 * an order's OUTSTANDING HOLD.
 *
 * Idempotency is decided by constraints here, never by a read followed by a
 * write: `insertFill` is `ON CONFLICT DO NOTHING`, and a lost conflict is a
 * return value, not an exception. A failed statement aborts the whole
 * PostgreSQL transaction, so a caught unique violation would leave the caller
 * holding a transaction that can only roll back.
 */

/** An event's position: `(seq, idx)` (ADR-0034 §1). */
export interface EventKey {
  readonly seq: bigint;
  readonly idx: number;
}

export function compareKeys(a: EventKey, b: EventKey): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return a.idx - b.idx;
}

export interface InsertFillInput {
  readonly fillId: string;
  readonly market: string;
  readonly key: EventKey;
  readonly takerOrderId: string;
  readonly makerOrderId: string;
  readonly takerUserId: string;
  readonly makerUserId: string;
  readonly takerSide: 'buy' | 'sell';
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly price: bigint;
  readonly qty: bigint;
  readonly notional: bigint;
  readonly takerFeeBps: number;
  readonly makerFeeBps: number;
  readonly takerFee: bigint;
  readonly makerFee: bigint;
  readonly engineTimestamp: Date;
}

export type InsertFillResult =
  | {
      readonly outcome: 'inserted';
      /** Post the settlement under THIS id, in the same transaction. */
      readonly ledgerTransactionId: string;
    }
  | { readonly outcome: 'already_settled' };

export interface FeeTierSnapshotRecord {
  readonly userId: string;
  readonly quoteAsset: string;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly volume: bigint;
  readonly tier: number;
  readonly makerBps: number;
  readonly takerBps: number;
}

/** One price level of resting gateway orders, as the database sees it. */
export interface HeldLevel {
  readonly side: 'buy' | 'sell';
  readonly price: bigint;
  /** Σ(qty − filled_qty) over resting orders at this price. */
  readonly qty: bigint;
}

export interface SettlementRepository {
  /**
   * Record a fill, or learn it was already recorded.
   *
   * The fill names its ledger transaction before that transaction exists — a
   * deferred foreign key refuses to commit one without the other — so a
   * redelivered fill never reaches the posting at all.
   */
  insertFill(input: InsertFillInput, tx?: Executor): Promise<InsertFillResult>;

  /**
   * `hold_amount − Σ consumed by settled fills − Σ released`, from the fills
   * table and the ledger. Never a column (prompt_phase_s4.md rule 72).
   *
   * A buy consumes `notional + its own fee` per fill — the taker fee when it
   * was the taker, the maker fee when it rested. A sell consumes bare quantity,
   * because its fee comes out of the quote it receives.
   *
   * Null when the order does not exist.
   */
  outstandingHold(orderId: string, tx?: Executor): Promise<bigint | null>;

  /** The worker's last fully applied key for a market, or null if it has none. */
  getOffset(consumer: string, market: string, tx?: Executor): Promise<EventKey | null>;

  /**
   * Move the offset FORWARD to `key`, in the caller's transaction.
   *
   * Never backward: a stale write from a slow attempt cannot rewind position.
   * Returns false when the stored offset was already at or past `key`.
   */
  advanceOffset(consumer: string, market: string, key: EventKey, tx?: Executor): Promise<boolean>;

  /**
   * A user's quote volume in fills whose engine timestamp is in `[from, to)`.
   * Both sides of a fill count it: it is volume for the taker and the maker.
   */
  quoteVolume(
    userId: string,
    quoteAsset: string,
    from: Date,
    to: Date,
    tx?: Executor,
  ): Promise<bigint>;

  findTierSnapshot(
    userId: string,
    quoteAsset: string,
    day: string,
    tx?: Executor,
  ): Promise<FeeTierSnapshotRecord | null>;

  /**
   * Write a snapshot unless one exists, and return WHICHEVER exists afterwards.
   * The first writer wins and every later reader gets its numbers: a snapshot
   * is never recomputed (ADR-0034 §9).
   */
  insertTierSnapshot(
    snapshot: FeeTierSnapshotRecord,
    tx?: Executor,
  ): Promise<FeeTierSnapshotRecord>;

  // --- Reconciliation (ADR-0035) ---------------------------------------------

  /**
   * Check 3, database side: resting LIMIT orders by side and price. Excludes
   * PENDING_ENGINE (may not rest yet) and market orders (never rest).
   */
  heldLevels(market: string, tx?: Executor): Promise<HeldLevel[]>;

  /**
   * Check 3, ledger side: (user, asset) pairs whose `user_order_locked`
   * balance differs from the sum of their holding orders' outstanding holds.
   * One statement, so one snapshot: a settlement committing mid-check cannot
   * produce a phantom mismatch.
   */
  orderLockMismatches(cluster: string, tx?: Executor): Promise<number>;

  /** User trading accounts below zero. Any at all is an immediate alert. */
  negativeTradingAccounts(cluster: string, tx?: Executor): Promise<number>;
}

export function createSettlementRepository(db: Executor): SettlementRepository {
  const exec = (tx?: Executor) => tx ?? db;

  return {
    async insertFill(input, tx) {
      const ledgerTransactionId = newId();
      const rows = await exec(tx).$queryRaw<Array<{ id: string }>>`
        INSERT INTO fills (
          id, fill_id, market, seq, idx,
          taker_order_id, maker_order_id, taker_user_id, maker_user_id, taker_side,
          base_asset, quote_asset, price, qty, notional,
          taker_fee_bps, maker_fee_bps, taker_fee, maker_fee,
          engine_timestamp, ledger_transaction_id, created_at
        ) VALUES (
          ${newId()}::uuid, ${input.fillId}, ${input.market}, ${input.key.seq}, ${input.key.idx},
          ${input.takerOrderId}::uuid, ${input.makerOrderId}::uuid,
          ${input.takerUserId}::uuid, ${input.makerUserId}::uuid,
          ${input.takerSide}::"OrderSide",
          ${input.baseAsset}, ${input.quoteAsset},
          ${new Prisma.Decimal(input.price.toString())},
          ${new Prisma.Decimal(input.qty.toString())},
          ${new Prisma.Decimal(input.notional.toString())},
          ${input.takerFeeBps}, ${input.makerFeeBps},
          ${new Prisma.Decimal(input.takerFee.toString())},
          ${new Prisma.Decimal(input.makerFee.toString())},
          ${input.engineTimestamp}, ${ledgerTransactionId}::uuid, now()
        )
        ON CONFLICT (fill_id) DO NOTHING
        RETURNING id
      `;
      return rows.length === 0
        ? { outcome: 'already_settled' }
        : { outcome: 'inserted', ledgerTransactionId };
    },

    async outstandingHold(orderId, tx) {
      const rows = await exec(tx).$queryRaw<Array<{ outstanding: string }>>`
        SELECT (
          o.hold_amount
          - COALESCE((
              SELECT SUM(
                CASE WHEN o.side = 'buy'
                  THEN f.notional + CASE WHEN f.taker_order_id = o.id THEN f.taker_fee ELSE f.maker_fee END
                  ELSE f.qty
                END)
              FROM fills f
              WHERE f.taker_order_id = o.id OR f.maker_order_id = o.id
            ), 0)
          - COALESCE((
              SELECT SUM(e.amount)
              FROM ledger_transactions t
              JOIN ledger_entries e  ON e.transaction_id = t.id
              JOIN ledger_accounts a ON a.id = e.account_id
              WHERE t.kind = 'order_release'
                AND t.reference_id = o.id::text
                AND a.type = 'user_order_locked'
                AND e.direction = 'debit'
            ), 0)
        )::text AS outstanding
        FROM orders o
        WHERE o.id = ${orderId}::uuid
      `;
      const row = rows[0];
      return row === undefined ? null : BigInt(row.outstanding);
    },

    async getOffset(consumer, market, tx) {
      const row = await exec(tx).engineOffset.findUnique({
        where: { consumer_market: { consumer, market } },
      });
      return row ? { seq: row.seq, idx: row.idx } : null;
    },

    async advanceOffset(consumer, market, key, tx) {
      const rows = await exec(tx).$queryRaw<Array<{ consumer: string }>>`
        INSERT INTO engine_offsets (consumer, market, seq, idx, updated_at)
        VALUES (${consumer}, ${market}, ${key.seq}, ${key.idx}, now())
        ON CONFLICT (consumer, market) DO UPDATE
          SET seq = EXCLUDED.seq, idx = EXCLUDED.idx, updated_at = now()
          WHERE (engine_offsets.seq, engine_offsets.idx) < (EXCLUDED.seq, EXCLUDED.idx)
        RETURNING consumer
      `;
      return rows.length > 0;
    },

    async quoteVolume(userId, quoteAsset, from, to, tx) {
      const rows = await exec(tx).$queryRaw<Array<{ volume: string }>>`
        SELECT COALESCE(SUM(notional), 0)::text AS volume
        FROM fills
        WHERE quote_asset = ${quoteAsset}
          AND engine_timestamp >= ${from} AND engine_timestamp < ${to}
          AND (taker_user_id = ${userId}::uuid OR maker_user_id = ${userId}::uuid)
      `;
      return BigInt(rows[0]?.volume ?? '0');
    },

    async findTierSnapshot(userId, quoteAsset, day, tx) {
      const rows = await exec(tx).$queryRaw<
        Array<{
          volume: string;
          tier: number;
          maker_bps: number;
          taker_bps: number;
        }>
      >`
        SELECT volume::text AS volume, tier, maker_bps, taker_bps
        FROM fee_tier_snapshots
        WHERE user_id = ${userId}::uuid AND quote_asset = ${quoteAsset} AND day = ${day}::date
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        userId,
        quoteAsset,
        day,
        volume: BigInt(row.volume),
        tier: row.tier,
        makerBps: row.maker_bps,
        takerBps: row.taker_bps,
      };
    },

    async heldLevels(market, tx) {
      const rows = await exec(tx).$queryRaw<
        Array<{ side: 'buy' | 'sell'; price: string; qty: string }>
      >`
        SELECT side::text AS side, price::text AS price, SUM(qty - filled_qty)::text AS qty
        FROM orders
        WHERE market = ${market}
          AND kind = 'limit'
          AND status IN ('OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL')
        GROUP BY side, price
      `;
      return rows
        .map((row) => ({ side: row.side, price: BigInt(row.price), qty: BigInt(row.qty) }))
        .filter((level) => level.qty > 0n);
    },

    async orderLockMismatches(cluster, tx) {
      const rows = await exec(tx).$queryRaw<Array<{ mismatches: number }>>`
        WITH holding AS (
          SELECT o.id, o.user_id, o.hold_asset, o.hold_amount, o.side
          FROM orders o
          WHERE o.status IN ('PENDING_ENGINE', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL')
            AND o.hold_asset LIKE ${`${cluster}:%`}
        ),
        consumed AS (
          SELECT h.id, SUM(
            CASE WHEN h.side = 'buy'
              THEN f.notional + CASE WHEN f.taker_order_id = h.id THEN f.taker_fee ELSE f.maker_fee END
              ELSE f.qty
            END) AS amount
          FROM holding h
          JOIN fills f ON f.taker_order_id = h.id OR f.maker_order_id = h.id
          GROUP BY h.id
        ),
        released AS (
          SELECT t.reference_id AS id, SUM(e.amount) AS amount
          FROM ledger_transactions t
          JOIN ledger_entries e  ON e.transaction_id = t.id
          JOIN ledger_accounts a ON a.id = e.account_id
          WHERE t.kind = 'order_release' AND a.type = 'user_order_locked' AND e.direction = 'debit'
          GROUP BY t.reference_id
        ),
        expected AS (
          SELECT h.user_id, h.hold_asset AS asset,
                 SUM(h.hold_amount - COALESCE(c.amount, 0) - COALESCE(r.amount, 0)) AS amount
          FROM holding h
          LEFT JOIN consumed c ON c.id = h.id
          LEFT JOIN released r ON r.id = h.id::text
          GROUP BY h.user_id, h.hold_asset
        ),
        actual AS (
          SELECT a.owner_id AS user_id, a.asset,
                 SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END) AS amount
          FROM ledger_accounts a
          JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.type = 'user_order_locked' AND a.asset LIKE ${`${cluster}:%`}
          GROUP BY a.owner_id, a.asset
        )
        SELECT COUNT(*)::int AS mismatches
        FROM actual
        FULL OUTER JOIN expected
          ON expected.user_id = actual.user_id AND expected.asset = actual.asset
        WHERE COALESCE(actual.amount, 0) <> COALESCE(expected.amount, 0)
      `;
      return rows[0]?.mismatches ?? 0;
    },

    async negativeTradingAccounts(cluster, tx) {
      const rows = await exec(tx).$queryRaw<Array<{ negatives: number }>>`
        SELECT COUNT(*)::int AS negatives FROM (
          SELECT a.id
          FROM ledger_accounts a
          JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.owner_id IS NOT NULL
            AND a.type IN ('user_trading_available', 'user_order_locked', 'user_trading_locked')
            AND a.asset LIKE ${`${cluster}:%`}
          GROUP BY a.id
          HAVING SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END) < 0
        ) negative
      `;
      return rows[0]?.negatives ?? 0;
    },

    async insertTierSnapshot(snapshot, tx) {
      const e = exec(tx);
      await e.$executeRaw`
        INSERT INTO fee_tier_snapshots
          (user_id, quote_asset, day, volume, tier, maker_bps, taker_bps, created_at)
        VALUES (${snapshot.userId}::uuid, ${snapshot.quoteAsset}, ${snapshot.day}::date,
                ${new Prisma.Decimal(snapshot.volume.toString())}, ${snapshot.tier},
                ${snapshot.makerBps}, ${snapshot.takerBps}, now())
        ON CONFLICT (user_id, quote_asset, day) DO NOTHING
      `;
      const stored = await this.findTierSnapshot(
        snapshot.userId,
        snapshot.quoteAsset,
        snapshot.day,
        e,
      );
      if (!stored) throw new Error('fee tier snapshot vanished after insert');
      return stored;
    },
  };
}
