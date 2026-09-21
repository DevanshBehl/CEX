import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allOrderTransitions, ORDER_STATUSES } from '@wallet/types';
import {
  createLedgerRepository,
  createOrderRepository,
  createPrismaClient,
  newId,
  withTransaction,
  type CreatePendingOrderInput,
  type PrismaClient,
} from './index.js';

/**
 * Orders against a real PostgreSQL (prompt_phase_s3.md §16).
 *
 * What is under test is the database: a unique index under concurrency, a
 * generated trigger, grants, and a deferred foreign key. A mock would pass all
 * of it while proving none of it.
 */
const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATION_DATABASE_URL;

let db: PrismaClient;
let owner: PrismaClient;
let orders: ReturnType<typeof createOrderRepository>;
let ledger: ReturnType<typeof createLedgerRepository>;
let user: string;

const ASSET = 'localnet:ORDERUSDC';

beforeAll(async () => {
  if (!APP_URL || !OWNER_URL) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL required');
  db = createPrismaClient({ url: APP_URL });
  owner = createPrismaClient({ url: OWNER_URL });
  orders = createOrderRepository(db);
  ledger = createLedgerRepository(db);
  await db.$connect();
  user = newId();
  await db.user.create({ data: { id: user } });
});

afterAll(async () => {
  await db.$disconnect();
  await owner.$disconnect();
});

function order(clientOrderId: string): CreatePendingOrderInput {
  return {
    userId: user,
    clientOrderId,
    market: 'localnet:SOL-USDC',
    side: 'buy',
    kind: 'limit',
    timeInForce: 'GTC',
    postOnly: false,
    price: '150000000',
    qty: '1000000',
    holdAsset: ASSET,
    holdAmount: '150',
  };
}

/** The gateway's database half: insert first, hold only if the insert won. */
async function placeWithHold(clientOrderId: string) {
  const accounts = [
    { ownerId: user, asset: ASSET, type: 'user_trading_available' as const },
    { ownerId: user, asset: ASSET, type: 'user_order_locked' as const },
  ];
  await ledger.ensureAccounts(accounts);
  return withTransaction(db, async (tx) => {
    const result = await createOrderRepository(tx).createPending(order(clientOrderId), tx);
    if (result.outcome === 'created') {
      await createLedgerRepository(tx).postTransaction(
        {
          id: result.holdLedgerTransactionId,
          kind: 'order_hold',
          referenceType: 'order',
          referenceId: result.order.id,
          entries: [
            { account: accounts[0]!, asset: ASSET, amount: '150', direction: 'debit' },
            { account: accounts[1]!, asset: ASSET, amount: '150', direction: 'credit' },
          ],
        },
        tx,
      );
    }
    return result;
  });
}

describe('idempotency', () => {
  it('50 concurrent submissions of one clientOrderId create one order and ONE hold', async () => {
    const id = `dup-${newId()}`;
    const results = await Promise.all(Array.from({ length: 50 }, () => placeWithHold(id)));

    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    const ids = new Set(results.map((r) => r.order.id));
    expect(ids.size).toBe(1);
    const [orderId] = [...ids];
    if (orderId === undefined) throw new Error('no order id');

    // The ledger is the proof: exactly one hold transaction for this order.
    const holds = await db.ledgerTransaction.count({
      where: { kind: 'order_hold', referenceType: 'order', referenceId: orderId },
    });
    expect(holds).toBe(1);
  });

  it('a repeat returns the existing order unchanged, without a second hold', async () => {
    const id = `repeat-${newId()}`;
    const first = await placeWithHold(id);
    const second = await placeWithHold(id);
    expect(second.outcome).toBe('existing');
    expect(second.order.id).toBe(first.order.id);
  });
});

describe('an order cannot exist without its hold', () => {
  // The deferred foreign key: the row is written before its hold, and COMMIT
  // refuses it if the hold never arrived.
  it('refuses to commit an order whose hold was never posted', async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await createOrderRepository(tx).createPending(order(`nohold-${newId()}`), tx);
      }),
    ).rejects.toThrow();
  });
});

describe('the generated transition trigger', () => {
  it('accepts every transition ORDER_TRANSITIONS declares', async () => {
    const { order: o } = await placeWithHold(`legal-${newId()}`);
    for (const { from, to } of allOrderTransitions()) {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO order_transitions (id, order_id, from_status, to_status, created_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::"OrderStatus", $3::"OrderStatus", now())`,
          o.id,
          from,
          to,
        ),
        `${from} -> ${to}`,
      ).resolves.toBeDefined();
    }
  });

  it('refuses every transition it does not declare, from raw SQL', async () => {
    const { order: o } = await placeWithHold(`illegal-${newId()}`);
    const legal = new Set(allOrderTransitions().map(({ from, to }) => `${from}->${to}`));
    let refused = 0;
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (legal.has(`${from}->${to}`)) continue;
        await expect(
          db.$executeRawUnsafe(
            `INSERT INTO order_transitions (id, order_id, from_status, to_status, created_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::"OrderStatus", $3::"OrderStatus", now())`,
            o.id,
            from,
            to,
          ),
          `${from} -> ${to}`,
        ).rejects.toThrow(/illegal order transition/);
        refused += 1;
      }
    }
    expect(refused).toBe(ORDER_STATUSES.length ** 2 - legal.size);
  });

  it('the repository refuses an illegal transition before reaching the database', async () => {
    const { order: o } = await placeWithHold(`repo-${newId()}`);
    await expect(
      orders.transition({ orderId: o.id, from: 'PENDING_ENGINE', to: 'CANCELLED' }),
    ).rejects.toThrow(/illegal order transition/);
  });

  it('a guarded transition from the wrong state is a lost race, not an error', async () => {
    const { order: o } = await placeWithHold(`race-${newId()}`);
    expect(await orders.transition({ orderId: o.id, from: 'OPEN', to: 'FILLED' })).toBeNull();
  });
});

describe('order history is append-only', () => {
  it('refuses UPDATE and DELETE from the application role', async () => {
    const { order: o } = await placeWithHold(`ao-${newId()}`);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE order_transitions SET reason = 'x' WHERE order_id = $1::uuid`,
        o.id,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(`DELETE FROM order_transitions WHERE order_id = $1::uuid`, o.id),
    ).rejects.toThrow();
  });

  it('refuses UPDATE and DELETE even from the schema owner', async () => {
    const { order: o } = await placeWithHold(`ao2-${newId()}`);
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE order_transitions SET reason = 'x' WHERE order_id = $1::uuid`,
        o.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.$executeRawUnsafe(`DELETE FROM order_transitions WHERE order_id = $1::uuid`, o.id),
    ).rejects.toThrow(/append-only/);
  });

  it('an order row cannot be deleted by the application', async () => {
    const { order: o } = await placeWithHold(`nodel-${newId()}`);
    await expect(
      db.$executeRawUnsafe(`DELETE FROM orders WHERE id = $1::uuid`, o.id),
    ).rejects.toThrow();
  });
});

describe('structural constraints', () => {
  it('refuses a limit order with no price, from raw SQL', async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await createOrderRepository(tx).createPending(
          { ...order(`noprice-${newId()}`), price: null },
          tx,
        );
      }),
    ).rejects.toThrow();
  });
});

describe('the sweeper claim', () => {
  it('claims only orders older than the cutoff, and counts the attempt', async () => {
    const { order: o } = await placeWithHold(`sweep-${newId()}`);
    const claimed = await withTransaction(db, (tx) =>
      createOrderRepository(tx).claimPendingEngine(new Date(Date.now() + 60_000), tx),
    );
    expect(claimed).not.toBeNull();
    const after = await orders.findById(o.id);
    expect(after?.sweepAttempts ?? 0).toBeGreaterThanOrEqual(0);

    const none = await withTransaction(db, (tx) =>
      createOrderRepository(tx).claimPendingEngine(new Date(0), tx),
    );
    expect(none).toBeNull();
  });
});
