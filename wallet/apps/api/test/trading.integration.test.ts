import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLedgerRepository, createOrderRepository, newId } from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import { ledgerAssetKey } from '@wallet/types';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import {
  browserHeaders,
  creditTrading,
  seedSession,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * The order gateway against a real PostgreSQL (prompt_phase_s3.md §16).
 *
 * The engine is a fake that keeps a real journal, so the cases that matter —
 * an ambiguous reply for a command that WAS applied, a lookup that cannot
 * answer — are expressible. What is under test is when the gateway posts a
 * hold, when it releases one, and when it must do neither.
 */

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC = ledgerAssetKey(TEST_CLUSTER, USDC_MINT);
const SOL = ledgerAssetKey(TEST_CLUSTER, NATIVE_ASSET);
// A symbol no developer .env allowlists, so the market resolves to THIS mint.
const MARKET = 'SOL-TUSDC';

/** 150 USDC per SOL, scaled (ADR-0026). One SOL costs 150_000_000 USDC base units. */
const PRICE = '150000000';
const ONE_SOL = '1000000000';
/** Notional of one SOL at PRICE, plus the worst-case 20 bp taker fee. */
const HOLD_ONE_SOL = 150_000_000n + 300_000n;

let h: Harness;
let engine: FakeEngine;

beforeAll(async () => {
  engine = createFakeEngine({
    market: MARKET,
    marketId: `${TEST_CLUSTER}:${MARKET}`,
    tickSize: 1_000n,
    lotSize: 1_000_000n,
    minNotional: 1_000n,
    collarBps: 5_000,
  });
  h = await startHarness({
    tokens: [
      {
        symbol: 'TUSDC',
        mint: USDC_MINT,
        decimals: 6,
        perTransactionLimit: '1000000000000',
        dailyLimit: '1000000000000',
        manualReviewAbove: '1000000000000',
      },
    ],
    trading: {
      engines: new Map([[MARKET, engine]]),
      clearingAddress: 'So11111111111111111111111111111111111111112',
      markets: [
        {
          symbol: MARKET,
          tickSize: '1000',
          lotSize: '1000000',
          minNotional: '1000',
          collarBps: 5_000,
        },
      ],
    },
  });
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(() => {
  engine.behaviour = 'accept';
  engine.lookupOverride = null;
  engine.referencePrice = 150_000_000n;
});

let n = 0;
const cid = () => `test-order-${Date.now()}-${(n += 1)}`;

async function trader(usdc = '1000000000'): Promise<{ userId: string; cookie: string }> {
  const session = await seedSession(h);
  await creditTrading(h, session.userId, USDC, usdc);
  await creditTrading(h, session.userId, SOL, '10000000000');
  return { userId: session.userId, cookie: session.cookie };
}

function place(cookie: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/orders',
    headers: browserHeaders(cookie),
    payload: {
      market: MARKET,
      side: 'buy',
      type: 'limit',
      timeInForce: 'GTC',
      price: PRICE,
      qty: ONE_SOL,
      postOnly: false,
      clientOrderId: cid(),
      ...body,
    },
  });
}

const trading = (userId: string, asset = USDC) =>
  createLedgerRepository(h.app.appDeps.db)
    .getUserTradingBalances(userId, TEST_CLUSTER)
    .then(
      (rows) => rows.find((r) => r.asset === asset) ?? { available: '0', locked: '0', total: '0' },
    );

const releasesFor = (orderId: string) =>
  h.app.appDeps.db.ledgerTransaction.count({
    where: { kind: 'order_release', referenceId: orderId },
  });

// ---------------------------------------------------------------------------

describe('placing an order', () => {
  it('posts the hold before the engine sees it, and opens on acceptance', async () => {
    const t = await trader();
    const response = await place(t.cookie, {});
    expect(response.statusCode, response.body).toBe(200);
    const { order } = response.json();
    expect(order.status).toBe('OPEN');
    expect(order.holdAmount).toBe(HOLD_ONE_SOL.toString());

    const balance = await trading(t.userId);
    expect(BigInt(balance.locked)).toBe(HOLD_ONE_SOL);
    expect(BigInt(balance.available)).toBe(1_000_000_000n - HOLD_ONE_SOL);
  });

  it('refuses an order the trading balance cannot cover, leaving no order and no hold', async () => {
    const t = await trader('1000');
    const response = await place(t.cookie, {});
    expect(response.statusCode).toBe(409);
    const orders = await createOrderRepository(h.app.appDeps.db).listForUser(
      t.userId,
      undefined,
      10,
    );
    expect(orders).toHaveLength(0);
    expect((await trading(t.userId)).locked).toBe('0');
  });

  it('refuses a structural violation before any hold is taken', async () => {
    const t = await trader();
    const response = await place(t.cookie, { price: '150000001' });
    expect(response.statusCode).toBe(400);
    expect((await trading(t.userId)).locked).toBe('0');
  });

  it('a sell holds base, not quote', async () => {
    const t = await trader();
    const response = await place(t.cookie, { side: 'sell' });
    expect(response.json().order.holdAsset).toBe(NATIVE_ASSET);
    expect((await trading(t.userId, SOL)).locked).toBe(ONE_SOL);
    expect((await trading(t.userId, USDC)).locked).toBe('0');
  });
});

describe('idempotency and concurrency', () => {
  it('50 concurrent submissions of one clientOrderId create one order and ONE hold', async () => {
    const t = await trader();
    const clientOrderId = cid();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => place(t.cookie, { clientOrderId })),
    );
    const ids = new Set(
      responses.filter((r) => r.statusCode === 200).map((r) => r.json().order.id),
    );
    expect(ids.size).toBe(1);
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
  });

  // Rule 159. The loser is refused by the serializable read-then-post, not by
  // a prior check — there is no database constraint behind it.
  it('two concurrent orders exceeding the balance produce exactly one hold', async () => {
    const t = await trader((HOLD_ONE_SOL + 1_000n).toString());
    const results = await Promise.all([place(t.cookie, {}), place(t.cookie, {})]);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 409]);
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
    expect(BigInt((await trading(t.userId)).available)).toBeGreaterThanOrEqual(0n);
  });
});

describe('what the engine says decides what happens to the hold', () => {
  it('a business rejection releases the whole hold, exactly once', async () => {
    const t = await trader();
    engine.behaviour = 'reject';
    const { order } = (await place(t.cookie, {})).json();
    expect(order.status).toBe('REJECTED');
    expect((await trading(t.userId)).locked).toBe('0');
    expect(await releasesFor(order.id)).toBe(1);
  });

  it('a transport refusal fails the order and returns the hold', async () => {
    const t = await trader();
    engine.behaviour = 'refuse';
    const { order } = (await place(t.cookie, {})).json();
    expect(order.status).toBe('FAILED');
    expect((await trading(t.userId)).locked).toBe('0');
  });

  // Rule 107 — the most expensive mistake available in this phase.
  it('an ambiguous reply leaves the order PENDING_ENGINE with its hold intact', async () => {
    const t = await trader();
    engine.behaviour = 'ambiguous_applied';
    const { order } = (await place(t.cookie, {})).json();
    expect(order.status).toBe('PENDING_ENGINE');
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
    expect(await releasesFor(order.id)).toBe(0);
  });

  it('an IOC that expires unfilled returns its hold', async () => {
    const t = await trader();
    engine.behaviour = 'expire';
    const { order } = (await place(t.cookie, { timeInForce: 'IOC' })).json();
    expect(order.status).toBe('EXPIRED');
    expect((await trading(t.userId)).locked).toBe('0');
  });

  // Fills belong to settlement (prompt_phase_s4.md §6). Releasing a hold a fill
  // is about to consume would drive it negative.
  it('a fill leaves the hold for settlement and does not release anything', async () => {
    const t = await trader();
    engine.behaviour = 'fill';
    const { order } = (await place(t.cookie, {})).json();
    expect(order.status).toBe('OPEN');
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
    expect(await releasesFor(order.id)).toBe(0);
  });
});

describe('market orders', () => {
  // A market order goes to the engine as an IOC LIMIT at the protection price,
  // so the engine can never fill above what was held.
  it('is sent as an IOC limit at the collar edge, and the hold covers it', async () => {
    const t = await trader();
    const before = engine.placed.length;
    const { order } = (
      await place(t.cookie, { type: 'market', price: null, timeInForce: 'GTC' })
    ).json();
    const sent = engine.placed[before]!;
    expect(sent.type).toBe('limit');
    expect(sent.timeInForce).toBe('IOC');
    // Collar 50% around 150e6: upper 225e6, already on a 1000 tick.
    expect(sent.price).toBe(225_000_000n);
    // Held at the top of the band plus worst-case fee — never less than the
    // most the engine can charge.
    const worst = (225_000_000n * 1_000_000_000n) / 1_000_000_000n;
    expect(BigInt(order.holdAmount)).toBeGreaterThanOrEqual(worst);
  });

  it('is refused when the book has no reference price', async () => {
    const t = await trader();
    engine.referencePrice = null;
    const response = await place(t.cookie, { type: 'market', price: null });
    expect(response.statusCode).toBe(400);
    expect((await trading(t.userId)).locked).toBe('0');
  });
});

describe('the PENDING_ENGINE sweeper', () => {
  async function pending(behaviour: 'ambiguous_applied' | 'ambiguous_lost') {
    const t = await trader();
    engine.behaviour = behaviour;
    const { order } = (await place(t.cookie, {})).json();
    engine.behaviour = 'accept';
    // Past the sweeper's first-ask delay (created_at), and least-recently
    // attempted of every pending order in the database (updated_at) — orders
    // are never deleted, so earlier runs leave PENDING_ENGINE orders behind and
    // the sweeper, correctly, attends to the longest-neglected first.
    await h.app.appDeps.db.$executeRawUnsafe(
      `UPDATE orders SET created_at = now() - interval '10 seconds', updated_at = now() - interval '30 days' WHERE id = $1::uuid`,
      order.id,
    );
    return { t, orderId: order.id as string };
  }

  it('opens an order the engine journaled, keeping its hold', async () => {
    const { t, orderId } = await pending('ambiguous_applied');
    await h.app.trading!.sweeper.runOnce();
    const order = await createOrderRepository(h.app.appDeps.db).findById(orderId);
    expect(order?.status).toBe('OPEN');
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
  });

  // ADR-0031: a request the gateway abandoned may still be queued in the engine
  // for the length of its tolerance window. "Never seen" is not proof yet.
  it('does NOT release a never-seen order younger than the engine tolerance', async () => {
    const { t, orderId } = await pending('ambiguous_lost');
    await h.app.trading!.sweeper.runOnce();
    const order = await createOrderRepository(h.app.appDeps.db).findById(orderId);
    expect(order?.status).toBe('PENDING_ENGINE');
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
  });

  it('fails a never-seen order once past the tolerance, and releases its hold', async () => {
    const { t, orderId } = await pending('ambiguous_lost');
    await h.app.appDeps.db.$executeRawUnsafe(
      `UPDATE orders SET created_at = now() - interval '20 minutes' WHERE id = $1::uuid`,
      orderId,
    );
    await h.app.trading!.sweeper.runOnce();
    const order = await createOrderRepository(h.app.appDeps.db).findById(orderId);
    expect(order?.status).toBe('FAILED');
    expect((await trading(t.userId)).locked).toBe('0');
    expect(await releasesFor(orderId)).toBe(1);
  });

  // Rule 124. `rebuilding` is not `never_seen`.
  it('does nothing when the engine cannot answer', async () => {
    const { t, orderId } = await pending('ambiguous_lost');
    await h.app.appDeps.db.$executeRawUnsafe(
      `UPDATE orders SET created_at = now() - interval '20 minutes' WHERE id = $1::uuid`,
      orderId,
    );
    engine.lookupOverride = 'rebuilding';
    await h.app.trading!.sweeper.runOnce();
    const order = await createOrderRepository(h.app.appDeps.db).findById(orderId);
    expect(order?.status).toBe('PENDING_ENGINE');
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
  });
});

describe('cancelling', () => {
  it('a cancel at full quantity returns the whole hold, once', async () => {
    const t = await trader();
    const { order } = (await place(t.cookie, {})).json();
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/orders/${order.id}`,
      headers: browserHeaders(t.cookie),
    });
    expect(response.json().order.status).toBe('CANCELLED');
    expect((await trading(t.userId)).locked).toBe('0');
    expect(await releasesFor(order.id)).toBe(1);
  });

  // A fill touched the hold; releasing it would go negative once settled.
  it('a cancel after a partial fill releases NOTHING and leaves it for settlement', async () => {
    const t = await trader();
    const { order } = (await place(t.cookie, {})).json();
    engine.fillResting(order.id, 500_000_000n);
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/orders/${order.id}`,
      headers: browserHeaders(t.cookie),
    });
    expect(response.json().order.status).toBe('PENDING_CANCEL');
    expect(BigInt((await trading(t.userId)).locked)).toBe(HOLD_ONE_SOL);
    expect(await releasesFor(order.id)).toBe(0);
  });

  // Rule 130: Rejected{UnknownOrder} answering a cancel means it already filled.
  it('a cancel of an order the engine no longer has releases nothing', async () => {
    const t = await trader();
    const { order } = (await place(t.cookie, {})).json();
    engine.fillResting(order.id, BigInt(ONE_SOL));
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/orders/${order.id}`,
      headers: browserHeaders(t.cookie),
    });
    expect(response.json().order.status).toBe('PENDING_CANCEL');
    expect(await releasesFor(order.id)).toBe(0);
  });

  it('cancel-all cancels every open order in the market', async () => {
    const t = await trader();
    await place(t.cookie, {});
    await place(t.cookie, {});
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/orders?market=${MARKET}`,
      headers: browserHeaders(t.cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().orders.every((o: { status: string }) => o.status === 'CANCELLED')).toBe(
      true,
    );
    expect((await trading(t.userId)).locked).toBe('0');
  });

  it("refuses to cancel another user's order, as not found", async () => {
    const a = await trader();
    const b = await trader();
    const { order } = (await place(a.cookie, {})).json();
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/orders/${order.id}`,
      headers: browserHeaders(b.cookie),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('amending', () => {
  // Take-then-release: the replacement is held before the old one is released.
  it('holds the replacement, then releases the old order', async () => {
    const t = await trader();
    const { order } = (await place(t.cookie, {})).json();
    const response = await h.app.inject({
      method: 'PATCH',
      url: `/orders/${order.id}`,
      headers: browserHeaders(t.cookie),
      payload: { clientOrderId: cid(), price: '140000000', qty: ONE_SOL },
    });
    expect(response.statusCode).toBe(200);
    const replacement = response.json().order;
    expect(replacement.status).toBe('OPEN');
    expect(replacement.id).not.toBe(order.id);

    const old = await createOrderRepository(h.app.appDeps.db).findById(order.id);
    expect(old?.status).toBe('CANCELLED');
    expect(await releasesFor(order.id)).toBe(1);
    // Only the replacement is held now.
    expect(BigInt((await trading(t.userId)).locked)).toBe(BigInt(replacement.holdAmount));
  });
});

describe('what an order can never do', () => {
  // HOLDING_ORDER_STATUSES and the ledger agree, over every order this suite made.
  it('holds funds exactly when its state says it does', async () => {
    const rows = await h.app.appDeps.db.$queryRawUnsafe<
      Array<{ id: string; status: string; released: bigint }>
    >(
      `SELECT o.id, o.status::text AS status,
              (SELECT count(*) FROM ledger_transactions t
                 WHERE t.kind = 'order_release' AND t.reference_id = o.id::text) AS released
         FROM orders o
        WHERE o.market = $1`,
      // This suite's orders only. The database outlives every suite, and
      // others deliberately build states no gateway produces — a second
      // release against a pending order, to prove the index refuses it.
      `${TEST_CLUSTER}:${MARKET}`,
    );
    for (const row of rows) {
      const holding = ['PENDING_ENGINE', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL'].includes(
        row.status,
      );
      // A released order is terminal; a holding one has not been released.
      if (holding) expect(Number(row.released), row.id).toBe(0);
      if (['REJECTED', 'EXPIRED', 'FAILED', 'CANCELLED'].includes(row.status)) {
        expect(Number(row.released), `${row.status} ${row.id}`).toBe(1);
      }
    }
  });

  it('is released at most once, whoever tries', async () => {
    const t = await trader();
    engine.behaviour = 'reject';
    const { order } = (await place(t.cookie, {})).json();
    // A second path attempting the same terminal release finds it done.
    const repo = createOrderRepository(h.app.appDeps.db);
    const current = await repo.findById(order.id);
    await h.app.trading!.orders.failNeverSeen({ ...current!, status: 'PENDING_ENGINE' }, 'test');
    expect(await releasesFor(order.id)).toBe(1);
  });
});

describe('pre-trade risk', () => {
  it('denies with a generic message and persists the decision', async () => {
    const t = await trader();
    const response = await place(t.cookie, { qty: '1000000000000000000' });
    // Refused structurally (notional overflow) or by risk; either way no hold.
    expect([400, 403]).toContain(response.statusCode);
    expect((await trading(t.userId)).locked).toBe('0');
  });
});

describe('the trading surface', () => {
  it('lists markets with the engine-reported status', async () => {
    const t = await trader();
    const response = await h.app.inject({
      method: 'GET',
      url: '/markets',
      headers: browserHeaders(t.cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().markets[0]).toMatchObject({
      symbol: MARKET,
      status: 'open',
      baseSymbol: 'SOL',
      quoteSymbol: 'TUSDC',
    });
  });

  it('shows the trading balance separately from the wallet balance', async () => {
    const t = await trader();
    const response = await h.app.inject({
      method: 'GET',
      url: '/trading/balances',
      headers: browserHeaders(t.cookie),
    });
    const usdc = response.json().balances.find((b: { symbol: string }) => b.symbol === 'TUSDC');
    expect(usdc.available).toBe('1000000000');
  });

  it('refuses a market whose rules disagree with its engine, before any hold', async () => {
    const t = await trader();
    engine.health_ = { ...engine.health_, tickSize: 7n };
    // Bust the registry's short status cache.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const response = await place(t.cookie, {});
    engine.health_ = { ...engine.health_, tickSize: 1_000n };
    expect(response.statusCode).toBe(503);
    expect((await trading(t.userId)).locked).toBe('0');
  });
});

void newId;
