import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLedgerRepository,
  createOrderRepository,
  createPrismaClient,
  createSettlementRepository,
  newId,
  withTransaction,
  type EntryInput,
  type Executor,
  type InsertFillInput,
  type LedgerAccountType,
  type PrismaClient,
} from './index.js';

/**
 * Settlement persistence against a real PostgreSQL (ADR-0034, prompt_phase_s4.md
 * §§7-8, 16). Every guarantee here is a constraint, an index or a trigger — the
 * things a mock passes while proving nothing.
 */
const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATION_DATABASE_URL;

let db: PrismaClient;
let owner: PrismaClient;
let buyer: string;
let seller: string;

const QUOTE = 'localnet:SETTLEUSD';
const BASE = 'localnet:SETTLESOL';
const MARKET = 'localnet:SETTLESOL-SETTLEUSD';

beforeAll(async () => {
  if (!APP_URL || !OWNER_URL) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL required');
  db = createPrismaClient({ url: APP_URL });
  owner = createPrismaClient({ url: OWNER_URL });
  buyer = newId();
  seller = newId();
  await db.user.createMany({ data: [{ id: buyer }, { id: seller }] });
  await fund(buyer, QUOTE, 10_000_000n);
  await fund(seller, BASE, 10_000_000n);
});

afterAll(async () => {
  await db.$disconnect();
  await owner.$disconnect();
});

const entry = (
  ownerId: string | null,
  asset: string,
  type: LedgerAccountType,
  amount: bigint,
  direction: 'debit' | 'credit',
): EntryInput => ({
  account: { ownerId, asset, type },
  asset,
  amount: amount.toString(),
  direction,
});

async function post(
  tx: Executor,
  kind: 'allocation' | 'order_hold' | 'order_release' | 'trade_settle' | 'adjustment',
  referenceId: string,
  entries: EntryInput[],
  id?: string,
) {
  return createLedgerRepository(tx).postTransaction(
    { ...(id ? { id } : {}), kind, referenceType: 'test', referenceId, entries },
    tx,
  );
}

async function fund(userId: string, asset: string, amount: bigint) {
  await withTransaction(db, (tx) =>
    post(tx, 'allocation', newId(), [
      entry(null, asset, 'clearing_assets', amount, 'debit'),
      entry(userId, asset, 'user_trading_available', amount, 'credit'),
    ]),
  );
}

/** An order and its hold, as the gateway writes them. */
async function holdingOrder(userId: string, side: 'buy' | 'sell', hold: bigint) {
  const asset = side === 'buy' ? QUOTE : BASE;
  return withTransaction(db, async (tx) => {
    const result = await createOrderRepository(tx).createPending(
      {
        userId,
        clientOrderId: `s-${newId()}`,
        market: MARKET,
        side,
        kind: 'limit',
        timeInForce: 'GTC',
        postOnly: false,
        price: '150000000',
        qty: '10000',
        holdAsset: asset,
        holdAmount: hold.toString(),
      },
      tx,
    );
    if (result.outcome !== 'created') throw new Error('expected a new order');
    await post(
      tx,
      'order_hold',
      result.order.id,
      [
        entry(userId, asset, 'user_trading_available', hold, 'debit'),
        entry(userId, asset, 'user_order_locked', hold, 'credit'),
      ],
      result.holdLedgerTransactionId,
    );
    return result.order;
  });
}

function fillInput(
  over: Partial<InsertFillInput> & Pick<InsertFillInput, 'takerOrderId' | 'makerOrderId'>,
): InsertFillInput {
  return {
    fillId: `${Math.floor(Math.random() * 1e9)}:0`,
    market: MARKET,
    key: { seq: BigInt(Math.floor(Math.random() * 1e12) + 1), idx: 0 },
    takerUserId: buyer,
    makerUserId: seller,
    takerSide: 'buy',
    baseAsset: BASE,
    quoteAsset: QUOTE,
    price: 150_000_000n,
    qty: 4_000n,
    notional: 600_000n,
    takerFeeBps: 20,
    makerFeeBps: 10,
    takerFee: 1_200n,
    makerFee: 600n,
    engineTimestamp: new Date('2026-10-01T12:00:00Z'),
    ...over,
  };
}

/** Insert a fill and its trade_settle, as the worker does, in one transaction. */
async function settle(input: InsertFillInput) {
  return withTransaction(db, async (tx) => {
    const result = await createSettlementRepository(tx).insertFill(input, tx);
    if (result.outcome === 'already_settled') return result;
    const buyerFee = input.takerSide === 'buy' ? input.takerFee : input.makerFee;
    const sellerFee = input.takerSide === 'buy' ? input.makerFee : input.takerFee;
    const b = input.takerSide === 'buy' ? input.takerUserId : input.makerUserId;
    const s = input.takerSide === 'buy' ? input.makerUserId : input.takerUserId;
    await createLedgerRepository(tx).postTransaction(
      {
        id: result.ledgerTransactionId,
        kind: 'trade_settle',
        referenceType: 'fill',
        referenceId: input.fillId,
        entries: [
          entry(b, QUOTE, 'user_order_locked', input.notional + buyerFee, 'debit'),
          entry(s, QUOTE, 'user_trading_available', input.notional - sellerFee, 'credit'),
          entry(null, QUOTE, 'house_trading_fees', buyerFee + sellerFee, 'credit'),
          entry(s, BASE, 'user_order_locked', input.qty, 'debit'),
          entry(b, BASE, 'user_trading_available', input.qty, 'credit'),
        ],
      },
      tx,
    );
    return result;
  });
}

describe('a fill is settled exactly once', () => {
  it('a redelivered fill is recognised by the constraint, not a read', async () => {
    const buy = await holdingOrder(buyer, 'buy', 700_000n);
    const sell = await holdingOrder(seller, 'sell', 10_000n);
    const input = fillInput({ takerOrderId: buy.id, makerOrderId: sell.id });

    expect((await settle(input)).outcome).toBe('inserted');
    expect((await settle(input)).outcome).toBe('already_settled');
    const settlements = await db.ledgerTransaction.count({
      where: { kind: 'trade_settle', referenceId: input.fillId },
    });
    expect(settlements).toBe(1);
  });

  it('refuses a fill committed without its settlement (deferred foreign key)', async () => {
    const buy = await holdingOrder(buyer, 'buy', 700_000n);
    const sell = await holdingOrder(seller, 'sell', 10_000n);
    await expect(
      withTransaction(
        db,
        (tx) =>
          createSettlementRepository(tx).insertFill(
            fillInput({ takerOrderId: buy.id, makerOrderId: sell.id }),
            tx,
          ),
        { maxRetries: 0 },
      ),
    ).rejects.toThrow(/fills_ledger_transaction_fkey/);
  });

  it('the trade_settle index refuses a second settlement for one fill, by any path', async () => {
    const fillId = `idx-${newId()}`;
    const legs = () => [
      entry(null, QUOTE, 'clearing_assets', 1n, 'debit'),
      entry(null, QUOTE, 'house_trading_fees', 1n, 'credit'),
    ];
    await withTransaction(db, (tx) => post(tx, 'trade_settle', fillId, legs()));
    await expect(
      withTransaction(db, (tx) => post(tx, 'trade_settle', fillId, legs()), { maxRetries: 0 }),
    ).rejects.toThrow(/23505[\s\S]*Key \(reference_id\)/);
  });

  it('the index is PARTIAL: other kinds may share a reference id', async () => {
    const shared = `shared-${newId()}`;
    const legs = () => [
      entry(null, QUOTE, 'clearing_assets', 1n, 'debit'),
      entry(null, QUOTE, 'house_trading_fees', 1n, 'credit'),
    ];
    await withTransaction(db, (tx) => post(tx, 'adjustment', shared, legs()));
    await withTransaction(db, (tx) => post(tx, 'adjustment', shared, legs()));
    await withTransaction(db, (tx) => post(tx, 'trade_settle', shared, legs()));
  });
});

describe('an order is released at most once (S3 index, proven in S4)', () => {
  it('refuses a second order_release for one order', async () => {
    const order = await holdingOrder(buyer, 'buy', 1_000n);
    const release = (amount: bigint) => (tx: Executor) =>
      post(tx, 'order_release', order.id, [
        entry(buyer, QUOTE, 'user_order_locked', amount, 'debit'),
        entry(buyer, QUOTE, 'user_trading_available', amount, 'credit'),
      ]);
    await withTransaction(db, release(400n));
    await expect(withTransaction(db, release(600n), { maxRetries: 0 })).rejects.toThrow(
      /23505[\s\S]*Key \(reference_id\)/,
    );
  });
});

describe('the outstanding hold', () => {
  it('a buy taker consumes notional plus the TAKER fee; the maker sell consumes quantity', async () => {
    const buy = await holdingOrder(buyer, 'buy', 700_000n);
    const sell = await holdingOrder(seller, 'sell', 10_000n);
    const repo = createSettlementRepository(db);
    await settle(fillInput({ takerOrderId: buy.id, makerOrderId: sell.id }));
    expect(await repo.outstandingHold(buy.id)).toBe(700_000n - 600_000n - 1_200n);
    expect(await repo.outstandingHold(sell.id)).toBe(10_000n - 4_000n);
  });

  it('a buy MAKER consumes notional plus the MAKER fee', async () => {
    const buy = await holdingOrder(buyer, 'buy', 700_000n);
    const sell = await holdingOrder(seller, 'sell', 10_000n);
    const repo = createSettlementRepository(db);
    await settle(
      fillInput({
        takerOrderId: sell.id,
        makerOrderId: buy.id,
        takerUserId: seller,
        makerUserId: buyer,
        takerSide: 'sell',
      }),
    );
    expect(await repo.outstandingHold(buy.id)).toBe(700_000n - 600_000n - 600n);
  });

  it('subtracts the release, reaching exactly zero', async () => {
    const order = await holdingOrder(buyer, 'buy', 5_000n);
    await withTransaction(db, (tx) =>
      post(tx, 'order_release', order.id, [
        entry(buyer, QUOTE, 'user_order_locked', 5_000n, 'debit'),
        entry(buyer, QUOTE, 'user_trading_available', 5_000n, 'credit'),
      ]),
    );
    expect(await createSettlementRepository(db).outstandingHold(order.id)).toBe(0n);
  });

  it('is null for an order that does not exist', async () => {
    expect(await createSettlementRepository(db).outstandingHold(newId())).toBeNull();
  });
});

describe('the offset', () => {
  it('only moves forward', async () => {
    const repo = createSettlementRepository(db);
    const consumer = `test-${newId()}`;
    expect(await repo.getOffset(consumer, MARKET)).toBeNull();
    expect(await repo.advanceOffset(consumer, MARKET, { seq: 5n, idx: 2 })).toBe(true);
    expect(await repo.advanceOffset(consumer, MARKET, { seq: 5n, idx: 1 })).toBe(false);
    expect(await repo.advanceOffset(consumer, MARKET, { seq: 4n, idx: 9 })).toBe(false);
    expect(await repo.advanceOffset(consumer, MARKET, { seq: 6n, idx: 0 })).toBe(true);
    expect(await repo.getOffset(consumer, MARKET)).toEqual({ seq: 6n, idx: 0 });
  });

  it('rolls back with the settlement it was written with', async () => {
    const repo = createSettlementRepository(db);
    const consumer = `test-${newId()}`;
    await expect(
      withTransaction(
        db,
        async (tx) => {
          await createSettlementRepository(tx).advanceOffset(
            consumer,
            MARKET,
            { seq: 9n, idx: 0 },
            tx,
          );
          throw new Error('settlement failed');
        },
        { maxRetries: 0 },
      ),
    ).rejects.toThrow('settlement failed');
    expect(await repo.getOffset(consumer, MARKET)).toBeNull();
  });
});

describe('fee tier snapshots', () => {
  it('the first writer wins and is never recomputed', async () => {
    const repo = createSettlementRepository(db);
    const user = newId();
    const first = await repo.insertTierSnapshot({
      userId: user,
      quoteAsset: QUOTE,
      day: '2026-10-01',
      volume: 5n,
      tier: 0,
      makerBps: 10,
      takerBps: 20,
    });
    const second = await repo.insertTierSnapshot({
      ...first,
      volume: 10n ** 14n,
      tier: 3,
      makerBps: 2,
      takerBps: 10,
    });
    expect(second).toEqual(first);
  });

  it('counts a fill as volume for both sides, inside the window only', async () => {
    const buy = await holdingOrder(buyer, 'buy', 700_000n);
    const sell = await holdingOrder(seller, 'sell', 10_000n);
    const quote = `localnet:VOL${Math.floor(Math.random() * 1e6)}`;
    // Volume is keyed on the quote asset recorded on the fill; a fresh one
    // isolates this test from every other fill in the database.
    await withTransaction(db, async (tx) => {
      const input = fillInput({ takerOrderId: buy.id, makerOrderId: sell.id, quoteAsset: quote });
      const r = await createSettlementRepository(tx).insertFill(input, tx);
      if (r.outcome !== 'inserted') throw new Error('expected insert');
      await post(
        tx,
        'trade_settle',
        input.fillId,
        [
          entry(null, quote, 'clearing_assets', 1n, 'debit'),
          entry(null, quote, 'house_trading_fees', 1n, 'credit'),
        ],
        r.ledgerTransactionId,
      );
    });
    const repo = createSettlementRepository(db);
    const day = new Date('2026-10-01T00:00:00Z');
    const next = new Date('2026-10-02T00:00:00Z');
    expect(await repo.quoteVolume(buyer, quote, day, next)).toBe(600_000n);
    expect(await repo.quoteVolume(seller, quote, day, next)).toBe(600_000n);
    expect(await repo.quoteVolume(buyer, quote, next, new Date('2026-10-03T00:00:00Z'))).toBe(0n);
  });
});

describe('fills are evidence', () => {
  it('refuses UPDATE and DELETE, even from the schema owner', async () => {
    const buy = await holdingOrder(buyer, 'buy', 700_000n);
    const sell = await holdingOrder(seller, 'sell', 10_000n);
    const input = fillInput({ takerOrderId: buy.id, makerOrderId: sell.id });
    await settle(input);
    await expect(
      db.$executeRawUnsafe(`UPDATE fills SET taker_fee = 0 WHERE fill_id = $1`, input.fillId),
    ).rejects.toThrow();
    await expect(
      owner.$executeRawUnsafe(`UPDATE fills SET taker_fee = 0 WHERE fill_id = $1`, input.fillId),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.$executeRawUnsafe(`DELETE FROM fills WHERE fill_id = $1`, input.fillId),
    ).rejects.toThrow(/append-only/);
  });
});
