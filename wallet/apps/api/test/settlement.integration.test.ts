import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainReader } from '@wallet/blockchain';
import {
  createLedgerRepository,
  createOrderRepository,
  createSettlementRepository,
  newId,
  withTransaction,
  type PrismaClient,
} from '@wallet/db';
import { postOrderHold } from '@wallet/ledger';
import { createCapturingLogger } from '@wallet/logger';
import { NATIVE_ASSET } from '@wallet/solana';
import { ledgerAssetKey } from '@wallet/types';
import { createClearingReconciliationService } from '../src/services/clearing-reconciliation.service.js';
import type { ReconciliationReport } from '../src/services/reconciliation.service.js';
import {
  createSettlementWorker,
  SettlementStartRefusedError,
  type SettlementWorker,
} from '../src/services/settlement/worker.js';
import { postLedger } from '../src/services/trading/ledger-post.js';
import { createReconciliationWorker } from '../src/workers/reconciliation-worker.js';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import {
  browserHeaders,
  creditTrading,
  seedSession,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';
import { createScriptedSource, type ScriptedSource } from './scripted-source.js';

/**
 * Settlement against a real PostgreSQL (prompt_phase_s4.md §16, ADR-0034).
 *
 * The engine is a fake that MATCHES — fills name real orders with real holds —
 * and the stream is one the test controls, so it can deliver every event twice,
 * lose some, lose all of them, or die between the commit and the ack.
 *
 * Every case gets its own market, with its own quote token. Fills, offsets and
 * ledger entries are append-only and survive the run, and a halted market stays
 * halted, so a shared market would make each case depend on the ones before it
 * — and on every earlier run of the suite.
 */

const SOL = ledgerAssetKey(TEST_CLUSTER, NATIVE_ASSET);
const CLEARING_ADDRESS = 'So11111111111111111111111111111111111111112';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

/** 150 quote per SOL, scaled (ADR-0026). One SOL costs 150_000_000 quote base units. */
const PRICE = 150_000_000n;
const ONE_SOL = 1_000_000_000n;
const NOTIONAL = 150_000_000n;
/** Tier 0: taker 20 bp, maker 10 bp of NOTIONAL. */
const TAKER_FEE = 300_000n;
const MAKER_FEE = 150_000n;
/** What a buy of one SOL at PRICE holds: notional plus the worst-case taker fee. */
const BUY_HOLD = NOTIONAL + TAKER_FEE;

const FUNDS = { quote: 1_000_000_000n, base: 10_000_000_000n };

interface Arena {
  readonly symbol: string;
  readonly marketId: string;
  readonly base: string;
  readonly quote: string;
  readonly engine: FakeEngine;
  readonly source: ScriptedSource;
}

let h: Harness;
const singles: Arena[] = [];
/** Two markets sharing one quote asset, so tier volume crosses them. */
const pairs: Array<{ sol: Arena; alt: Arena }> = [];

const SINGLE_MARKETS = 32;
const RULES = { tickSize: '1000', lotSize: '1000000', minNotional: '1000', collarBps: 5_000 };

beforeAll(async () => {
  const { Keypair } = await import('@solana/web3.js');
  const tokens: Array<{ symbol: string; mint: string; decimals: number }> = [];
  const token = (symbol: string, decimals: number): string => {
    const mint = Keypair.generate().publicKey.toBase58();
    tokens.push({ symbol, mint, decimals });
    return ledgerAssetKey(TEST_CLUSTER, mint);
  };
  const arena = (symbol: string, base: string, quote: string): Arena => {
    const engine = createFakeEngine({
      market: symbol,
      marketId: `${TEST_CLUSTER}:${symbol}`,
      tickSize: 1_000n,
      lotSize: 1_000_000n,
      minNotional: 1_000n,
      collarBps: 5_000,
    });
    engine.behaviour = 'match';
    return {
      symbol,
      marketId: `${TEST_CLUSTER}:${symbol}`,
      base,
      quote,
      engine,
      source: createScriptedSource(engine),
    };
  };

  for (let i = 0; i < SINGLE_MARKETS; i += 1) {
    const quoteSymbol = `Q${RUN}N${String(i)}`;
    singles.push(arena(`SOL-${quoteSymbol}`, SOL, token(quoteSymbol, 6)));
  }
  const altSymbol = `B${RUN}`;
  const alt = token(altSymbol, 9);
  for (const name of ['X', 'Y']) {
    const quoteSymbol = `Q${RUN}${name}`;
    const quote = token(quoteSymbol, 6);
    pairs.push({
      sol: arena(`SOL-${quoteSymbol}`, SOL, quote),
      alt: arena(`${altSymbol}-${quoteSymbol}`, alt, quote),
    });
  }
  const all = [...singles, ...pairs.flatMap((pair) => [pair.sol, pair.alt])];

  h = await startHarness({
    tokens: tokens.map((t) => ({
      ...t,
      perTransactionLimit: '1000000000000000',
      dailyLimit: '1000000000000000',
      manualReviewAbove: '1000000000000000',
    })),
    trading: {
      engines: new Map(all.map((a) => [a.symbol, a.engine])),
      clearingAddress: CLEARING_ADDRESS,
      markets: all.map((a) => ({ symbol: a.symbol, ...RULES })),
      settlement: {
        sources: new Map(all.map((a) => [a.symbol, a.source])),
        // Explicit, per market: nothing has ever been settled on any of them.
        start: Object.fromEntries(all.map((a) => [a.symbol, { seq: 0n, idx: 0 }])),
      },
    },
  });
}, 120_000);

afterAll(async () => {
  await h.cleanup();
});

// --- helpers ---------------------------------------------------------------

let nextArena = 0;
function market(): Arena {
  const arena = singles[nextArena];
  nextArena += 1;
  if (!arena) throw new Error('raise SINGLE_MARKETS: every market is taken');
  return arena;
}

const db = (): PrismaClient => h.app.appDeps.db;
const worker = (a: Arena): SettlementWorker => h.app.trading!.settlement.get(a.symbol)!;
const orderOf = async (id: string) => (await createOrderRepository(db()).findById(id))!;
const offsetOf = (a: Arena) => createSettlementRepository(db()).getOffset('settlement', a.marketId);

interface Trader {
  readonly userId: string;
  readonly cookie: string;
}

async function trader(a: Arena, funds: { quote?: bigint; base?: bigint } = {}): Promise<Trader> {
  const session = await seedSession(h);
  await creditTrading(h, session.userId, a.quote, (funds.quote ?? FUNDS.quote).toString());
  await creditTrading(h, session.userId, a.base, (funds.base ?? FUNDS.base).toString());
  return { userId: session.userId, cookie: session.cookie };
}

let n = 0;
interface Placed {
  readonly id: string;
  readonly status: string;
  readonly holdAmount: string;
}

async function place(a: Arena, who: Trader, body: Record<string, unknown>): Promise<Placed> {
  n += 1;
  const response = await h.app.inject({
    method: 'POST',
    url: '/orders',
    headers: browserHeaders(who.cookie),
    payload: {
      market: a.symbol,
      type: 'limit',
      timeInForce: 'GTC',
      price: PRICE.toString(),
      qty: ONE_SOL.toString(),
      postOnly: false,
      clientOrderId: `settle-${RUN}-${String(n)}`,
      ...body,
    },
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return (response.json() as { order: Placed }).order;
}

const buy = (a: Arena, who: Trader, body: Record<string, unknown> = {}) =>
  place(a, who, { side: 'buy', ...body });
const sell = (a: Arena, who: Trader, body: Record<string, unknown> = {}) =>
  place(a, who, { side: 'sell', ...body });

async function cancel(who: Trader, orderId: string): Promise<string> {
  const response = await h.app.inject({
    method: 'DELETE',
    url: `/orders/${orderId}`,
    headers: browserHeaders(who.cookie),
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { order: { status: string } }).order.status;
}

/** Publish what the engine journaled, and run a worker until it has nothing left. */
async function settle(a: Arena, using: SettlementWorker = worker(a)): Promise<number> {
  await a.source.publish();
  let applied = 0;
  for (;;) {
    const count = await using.runOnce();
    applied += count;
    if (count === 0) return applied;
  }
}

async function balance(userId: string, asset: string) {
  const rows = await createLedgerRepository(db()).getUserTradingBalances(userId, TEST_CLUSTER);
  const row = rows.find((r) => r.asset === asset);
  return { available: BigInt(row?.available ?? '0'), locked: BigInt(row?.locked ?? '0') };
}

async function clearing(asset: string) {
  const rows = await createLedgerRepository(db()).getClearingTotals(TEST_CLUSTER);
  const row = rows.find((r) => r.asset === asset);
  return {
    assets: BigInt(row?.clearingAssets ?? '0'),
    liabilities: BigInt(row?.tradingLiabilities ?? '0'),
    fees: BigInt(row?.houseTradingFees ?? '0'),
  };
}

interface FillRow {
  seq: bigint;
  idx: number;
  fill_id: string;
  taker_fee_bps: number;
  maker_fee_bps: number;
  taker_fee: string;
  maker_fee: string;
  notional: string;
}

const fillsOf = (a: Arena) => db().$queryRaw<FillRow[]>`
  SELECT seq, idx, fill_id, taker_fee_bps, maker_fee_bps,
         taker_fee::text AS taker_fee, maker_fee::text AS maker_fee, notional::text AS notional
  FROM fills WHERE market = ${a.marketId} ORDER BY seq, idx`;

const keysOf = (rows: readonly { seq: bigint; idx: number }[]) =>
  rows.map((row) => `${row.seq.toString()}:${String(row.idx)}`);

/** The keys the stream carried for fills: what re-emission must reproduce. */
const publishedFillKeys = (a: Arena) =>
  keysOf(
    a.source
      .published()
      .filter((entry) => entry.raw.startsWith('{"Fill"'))
      .map((entry) => entry.key),
  );

/** What each `order_release` for an order returned. One element per release. */
async function released(orderId: string): Promise<bigint[]> {
  const rows = await db().$queryRaw<Array<{ amount: string }>>`
    SELECT e.amount::text AS amount
    FROM ledger_transactions t
    JOIN ledger_entries e  ON e.transaction_id = t.id
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE t.kind = 'order_release' AND t.reference_id = ${orderId}
      AND a.type = 'user_order_locked' AND e.direction = 'debit'`;
  return rows.map((row) => BigInt(row.amount));
}

const settlementsOf = (a: Arena) =>
  db().ledgerTransaction.count({
    where: { kind: 'trade_settle', referenceId: { startsWith: `${a.marketId}:` } },
  });

const transitions = async (orderId: string) =>
  (
    await db().$queryRaw<Array<{ from_status: string | null; to_status: string }>>`
      SELECT from_status::text AS from_status, to_status::text AS to_status
      FROM order_transitions WHERE order_id = ${orderId}::uuid ORDER BY created_at, id`
  ).map((row) => `${row.from_status ?? ''}->${row.to_status}`);

/** A worker built by hand, for what the server's own wiring does not vary. */
function standalone(
  a: Arena,
  options: { database?: PrismaClient; pageSize?: number; start?: boolean; retries?: number } = {},
): SettlementWorker {
  const entry = h.app.trading!.markets.get(a.symbol)!;
  return createSettlementWorker({
    db: options.database ?? db(),
    logger: h.logs.logger,
    market: {
      id: entry.market.id,
      symbol: a.symbol,
      baseAsset: entry.market.baseAsset,
      quoteAsset: entry.market.quoteAsset,
    },
    source: a.source,
    reemitter: {
      eventsAfter: (afterSeq, limit) => a.engine.rawEvents(afterSeq, limit),
      lastSeq: async () => (await a.engine.health())?.lastSeq ?? null,
    },
    consumer: 'settlement',
    ...(options.start === false ? {} : { startKey: { seq: 0n, idx: 0 } }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.retries === undefined ? {} : { transientRetries: options.retries }),
  });
}

const logged = (event: string, a: Arena) =>
  h.logs.entries().filter((entry) => entry.event === event && entry.targetId === a.symbol);

// ---------------------------------------------------------------------------

describe('a fill moves money, once', () => {
  it('a buy taker: both sides settle, both fees reach the house, nothing is left held', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    const maker = await sell(a, seller);
    const taker = await buy(a, buyer);

    // Accepted (maker), then Fill and Accepted{0} (taker).
    expect(await settle(a)).toBe(3);

    // The buyer paid the notional plus the TAKER fee and received the base.
    expect(await balance(buyer.userId, a.quote)).toEqual({
      available: FUNDS.quote - NOTIONAL - TAKER_FEE,
      locked: 0n,
    });
    expect((await balance(buyer.userId, a.base)).available).toBe(FUNDS.base + ONE_SOL);
    // The seller gave the base and received the notional less the MAKER fee.
    expect(await balance(seller.userId, a.base)).toEqual({
      available: FUNDS.base - ONE_SOL,
      locked: 0n,
    });
    expect((await balance(seller.userId, a.quote)).available).toBe(
      FUNDS.quote + NOTIONAL - MAKER_FEE,
    );

    // One fill, one trade_settle, referenced by the FILL id — never an order id.
    const fills = await fillsOf(a);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      seq: 2n,
      idx: 0,
      fill_id: `${a.marketId}:2:0`,
      taker_fee_bps: 20,
      maker_fee_bps: 10,
      taker_fee: TAKER_FEE.toString(),
      maker_fee: MAKER_FEE.toString(),
      notional: NOTIONAL.toString(),
    });
    expect(await settlementsOf(a)).toBe(1);

    for (const id of [maker.id, taker.id]) {
      const order = await orderOf(id);
      expect(order.status).toBe('FILLED');
      expect(order.filledQty).toBe(ONE_SOL.toString());
      // Both holds were consumed exactly: nothing to return (rule 62b).
      expect(await released(id)).toEqual([]);
    }

    // The clearing slack IS the fee equity: nothing else may explain it.
    const totals = await clearing(a.quote);
    expect(totals.fees).toBe(TAKER_FEE + MAKER_FEE);
    expect(totals.assets - totals.liabilities).toBe(totals.fees);
    // A trade moves liabilities between users, never coins.
    expect(totals.assets).toBe(2n * FUNDS.quote);
  });

  it('a sell taker: the taker rate follows the SELLER, and the maker buy gets its fee headroom back', async () => {
    const a = market();
    const buyer = await trader(a);
    const seller = await trader(a);
    const maker = await buy(a, buyer);
    expect(BigInt(maker.holdAmount)).toBe(BUY_HOLD);
    const taker = await sell(a, seller);
    await settle(a);

    // The seller is the taker here, so the seller pays 20 bp.
    expect((await balance(seller.userId, a.quote)).available).toBe(
      FUNDS.quote + NOTIONAL - TAKER_FEE,
    );
    // The buyer rested: 10 bp, although the hold assumed the worst taker rate.
    expect(await balance(buyer.userId, a.quote)).toEqual({
      available: FUNDS.quote - NOTIONAL - MAKER_FEE,
      locked: 0n,
    });

    // The maker got NO disposition event — the engine emits one only for the
    // order that sent the command. Its terminal event was the fill itself, and
    // the unused headroom came back in that same transaction (rule 79a).
    expect((await orderOf(maker.id)).status).toBe('FILLED');
    expect(await released(maker.id)).toEqual([TAKER_FEE - MAKER_FEE]);
    expect((await orderOf(taker.id)).status).toBe('FILLED');
    expect(await released(taker.id)).toEqual([]);
    expect((await clearing(a.quote)).fees).toBe(TAKER_FEE + MAKER_FEE);
  });

  it("a market buy's collar over-hold comes back on its terminal release", async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    await sell(a, seller);
    const taker = await buy(a, buyer, { type: 'market', price: null });

    // Held at the TOP of the collar band (150 + 50%), plus the worst fee.
    const hold = BigInt(taker.holdAmount);
    expect(hold).toBe(225_000_000n + 450_000n);
    await settle(a);

    // It filled at the maker's 150. The difference is real money, returned by
    // the one release — there is no separate refund mechanism.
    expect((await orderOf(taker.id)).status).toBe('FILLED');
    expect(await released(taker.id)).toEqual([hold - NOTIONAL - TAKER_FEE]);
    expect(await balance(buyer.userId, a.quote)).toEqual({
      available: FUNDS.quote - NOTIONAL - TAKER_FEE,
      locked: 0n,
    });
  });

  it('a partial fill consumes and releases NOTHING; the fill that completes it ends it', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    const maker = await sell(a, seller);
    await buy(a, buyer, { qty: '400000000' });
    await settle(a);

    let order = await orderOf(maker.id);
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.filledQty).toBe('400000000');
    // The remainder stays held until the order is terminal (rule 157).
    expect((await balance(seller.userId, a.base)).locked).toBe(600_000_000n);
    expect(await released(maker.id)).toEqual([]);

    await buy(a, buyer, { qty: '600000000' });
    await settle(a);
    order = await orderOf(maker.id);
    expect(order.status).toBe('FILLED');
    // Fully consumed: terminal with no release posted, and nothing left behind.
    expect(await released(maker.id)).toEqual([]);
    expect((await balance(seller.userId, a.base)).locked).toBe(0n);
    expect(await createSettlementRepository(db()).outstandingHold(maker.id)).toBe(0n);
    expect(await fillsOf(a)).toHaveLength(2);
  });

  it('a status change is applied as a no-op and still advances the offset', async () => {
    const a = market();
    a.engine.changeStatus();
    expect(await settle(a)).toBe(1);
    expect(await offsetOf(a)).toEqual({ seq: 1n, idx: 0 });
  });
});

describe('delivery is at-least-once', () => {
  async function traded(a: Arena) {
    const seller = await trader(a);
    const buyer = await trader(a);
    const maker = await sell(a, seller);
    const taker = await buy(a, buyer);
    const snapshot = async () => ({
      buyerQuote: await balance(buyer.userId, a.quote),
      buyerBase: await balance(buyer.userId, a.base),
      sellerQuote: await balance(seller.userId, a.quote),
      sellerBase: await balance(seller.userId, a.base),
      clearing: await clearing(a.quote),
      fills: (await fillsOf(a)).length,
      settlements: await settlementsOf(a),
      offset: await offsetOf(a),
    });
    return { seller, buyer, maker, taker, snapshot };
  }

  it('redelivering every event of the stream changes nothing', async () => {
    const a = market();
    const { snapshot } = await traded(a);
    await settle(a);
    const before = await snapshot();
    expect(before.fills).toBe(1);

    a.source.republish();
    expect(a.source.pending()).toBe(3);
    expect(await worker(a).runOnce()).toBe(0);
    expect(await snapshot()).toEqual(before);
    // Skipped by the offset — and acknowledged, so they stop coming back.
    expect(a.source.pending()).toBe(0);
  });

  it('dying between the commit and the XACK duplicates nothing', async () => {
    const a = market();
    const { snapshot } = await traded(a);
    await a.source.publish();
    a.source.failNextAck();
    await expect(worker(a).runOnce()).rejects.toThrow('process died before XACK');

    // Committed, and never acknowledged: all three entries are still pending.
    const committed = await snapshot();
    expect(committed.fills).toBe(1);
    expect(a.source.pending()).toBe(3);

    expect(await worker(a).runOnce()).toBe(0);
    expect(await snapshot()).toEqual(committed);
    expect(a.source.pending()).toBe(0);
  });

  it('dying before the commit loses nothing', async () => {
    const a = market();
    // A database whose next transaction does all its work and is then lost.
    let armed = false;
    const lossy = new Proxy(db(), {
      get(target, property) {
        if (property === '$transaction' && armed) {
          return async (fn: (tx: unknown) => Promise<unknown>, options: unknown) =>
            (target.$transaction as (f: unknown, o: unknown) => Promise<unknown>)(
              async (tx: unknown) => {
                await fn(tx);
                armed = false;
                throw new Error('connection lost before commit');
              },
              options,
            );
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const dying = standalone(a, { database: lossy, retries: 0 });
    await dying.init();

    const { buyer, snapshot } = await traded(a);
    await a.source.publish();
    // The maker's Accepted commits; the fill's transaction is the one lost.
    a.source.drop((entry) => entry.key.seq > 1n);
    expect(await dying.runOnce()).toBe(1);
    const before = await snapshot();
    a.source.republish();

    armed = true;
    await dying.runOnce();
    // Rolled back whole: no fill, no posting, the offset where it was, and the
    // entry never acknowledged.
    expect(await snapshot()).toEqual(before);
    expect(before.fills).toBe(0);
    expect(a.source.pending()).toBeGreaterThan(0);

    // Redelivered, and applied exactly once.
    await settle(a, dying);
    const after = await snapshot();
    expect(after.fills).toBe(1);
    expect(after.settlements).toBe(1);
    expect(after.offset).toEqual({ seq: 2n, idx: 1 });
    expect(await balance(buyer.userId, a.base)).toEqual({
      available: FUNDS.base + ONE_SOL,
      locked: 0n,
    });
  });
});

describe('position, gaps and recovery', () => {
  it('refuses to start with no offset and no configured start key', async () => {
    const a = market();
    // Nothing was ever applied on this market, so it has no offset row.
    expect(await offsetOf(a)).toBeNull();
    await expect(standalone(a, { start: false }).init()).rejects.toBeInstanceOf(
      SettlementStartRefusedError,
    );
    expect(logged('settlement.start_refused', a)).toHaveLength(1);
  });

  it('a sequence missing from the stream is recovered from the journal', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    await sell(a, seller);
    await buy(a, buyer);
    await sell(a, seller);
    await a.source.publish();
    // The taker's whole command — the fill included — never reached the stream.
    a.source.drop((entry) => entry.key.seq === 2n);

    await settle(a);
    expect(keysOf(await fillsOf(a))).toEqual(['2:0']);
    expect(await offsetOf(a)).toEqual({ seq: 3n, idx: 0 });
    expect(logged('settlement.recovered', a).map((entry) => entry.reason)).toContain(
      'sequence_gap',
    );
    expect((await balance(buyer.userId, a.base)).available).toBe(FUNDS.base + ONE_SOL);
  });

  it('a wiped stream recovers every fill through re-emission, under the same keys', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    await sell(a, seller);
    await sell(a, seller);
    await buy(a, buyer, { qty: (2n * ONE_SOL).toString() });
    await buy(a, buyer); // rests: nothing left to cross
    await a.source.publish();
    const expected = publishedFillKeys(a);
    expect(expected).toEqual(['3:0', '3:1']);

    a.source.wipe();
    await settle(a);
    expect(keysOf(await fillsOf(a))).toEqual(expected);
    expect(await offsetOf(a)).toEqual({ seq: 4n, idx: 0 });
    expect(logged('settlement.recovered', a).map((entry) => entry.reason)).toContain(
      'stream_reset',
    );
  });

  it('a recovery page that ends inside a sequence yields the same keys as the stream', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    for (let i = 0; i < 3; i += 1) await sell(a, seller);
    // One command, four events: three fills and the taker's disposition.
    await buy(a, buyer, { qty: (3n * ONE_SOL).toString() });
    await a.source.publish();
    const expected = publishedFillKeys(a);
    expect(expected).toEqual(['4:0', '4:1', '4:2']);

    // A page limit of one falls inside sequence 4 every time it is reached.
    const paged = standalone(a, { pageSize: 1 });
    await paged.init();
    a.source.wipe();
    await settle(a, paged);

    expect(keysOf(await fillsOf(a))).toEqual(expected);
    expect(await offsetOf(a)).toEqual({ seq: 4n, idx: 3 });
    expect((await balance(buyer.userId, a.base)).available).toBe(FUNDS.base + 3n * ONE_SOL);
  });
});

describe('one writer of fill-driven state', () => {
  it('a fill against a PENDING_ENGINE order settles, and the gateway then loses its race quietly', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    await sell(a, seller);
    // The engine matched and journaled; the gateway got a 503 and knows nothing.
    a.engine.behaviour = 'match_ambiguous';
    const taker = await buy(a, buyer);
    a.engine.behaviour = 'match';
    expect(taker.status).toBe('PENDING_ENGINE');

    await settle(a);
    expect((await orderOf(taker.id)).status).toBe('FILLED');

    // The sweeper now resolves it from the journal, as it would in production.
    h.logs.clear();
    const stale = { ...(await orderOf(taker.id)), status: 'PENDING_ENGINE' as const };
    const events = (await a.engine.events(1n, 1))!;
    const after = await h.app.trading!.orders.resolvePending(stale, events, 'test');
    // Its guarded PENDING_ENGINE -> OPEN found nothing to move. Not an error.
    expect(after.status).toBe('FILLED');
    expect(h.logs.entries().filter((entry) => entry.level === 'error')).toEqual([]);
    expect(await released(taker.id)).toEqual([]);
    expect((await balance(buyer.userId, a.quote)).locked).toBe(0n);
  });

  it('a cancel that loses to a completing fill ends FILLED, with nothing released', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    const maker = await sell(a, seller);
    await settle(a);
    await buy(a, buyer);
    // The book no longer has it: the cancel is answered Rejected{UnknownOrder}.
    expect(await cancel(seller, maker.id)).toBe('PENDING_CANCEL');

    await settle(a);
    expect((await orderOf(maker.id)).status).toBe('FILLED');
    expect(await released(maker.id)).toEqual([]);
    expect(await balance(seller.userId, a.base)).toEqual({
      available: FUNDS.base - ONE_SOL,
      locked: 0n,
    });
  });

  it('a cancel after a partial fill ends CANCELLED, with exactly the remainder released', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    const maker = await sell(a, seller);
    await settle(a);
    await buy(a, buyer, { qty: '400000000' });
    // The gateway saw a partial cancel and left the release to settlement.
    expect(await cancel(seller, maker.id)).toBe('PENDING_CANCEL');
    expect(await released(maker.id)).toEqual([]);

    await settle(a);
    const order = await orderOf(maker.id);
    expect(order.status).toBe('CANCELLED');
    expect(order.filledQty).toBe('400000000');
    // The partial fill did NOT forget the cancel in flight.
    expect(await transitions(maker.id)).not.toContain('PENDING_CANCEL->PARTIALLY_FILLED');
    expect(await released(maker.id)).toEqual([600_000_000n]);
    expect(await balance(seller.userId, a.base)).toEqual({
      available: FUNDS.base - 400_000_000n,
      locked: 0n,
    });
  });

  it('a cancel whose first guarded transition loses to a fill still reaches the engine', async () => {
    const a = market();
    const seller = await trader(a);
    const buyer = await trader(a);
    const maker = await sell(a, seller);
    await settle(a);
    await buy(a, buyer, { qty: '400000000' });

    // The interleaving S3 could not have: the cancel reads the order OPEN, and
    // settlement moves it to PARTIALLY_FILLED before the cancel's transition.
    const orders = h.app.trading!.orders;
    const read = orders.get.bind(orders);
    orders.get = async (userId, orderId) => {
      const stale = await read(userId, orderId);
      await settle(a);
      return stale;
    };
    try {
      const result = await orders.cancel(seller.userId, maker.id, 'test');
      expect(result.status).toBe('PENDING_CANCEL');
    } finally {
      orders.get = read;
    }

    // It retried from the status it found, rather than giving up without
    // calling the engine — which would have left the user's order live.
    expect(await transitions(maker.id)).toContain('PARTIALLY_FILLED->PENDING_CANCEL');
    expect((await a.engine.depth())?.asks).toEqual([]);

    await settle(a);
    expect((await orderOf(maker.id)).status).toBe('CANCELLED');
    expect(await released(maker.id)).toEqual([600_000_000n]);
    expect((await balance(seller.userId, a.base)).locked).toBe(0n);
  });

  it('a full-quantity cancel seen by the gateway AND the worker posts one release', async () => {
    const a = market();
    const buyer = await trader(a);
    const order = await buy(a, buyer);
    expect(await cancel(buyer, order.id)).toBe('CANCELLED');
    expect(await released(order.id)).toEqual([BUY_HOLD]);

    // The same Cancelled now arrives on the stream.
    expect(await settle(a)).toBe(2);
    expect(await released(order.id)).toEqual([BUY_HOLD]);
    expect(await balance(buyer.userId, a.quote)).toEqual({ available: FUNDS.quote, locked: 0n });
  });

  it('an order is released once whether the worker, the gateway or the sweeper is first', async () => {
    const a = market();
    const buyer = await trader(a);
    const order = await buy(a, buyer);
    await settle(a);
    // Cancelled in the book without the gateway ever moving it to
    // PENDING_CANCEL: a `Cancelled` is a fact, recorded from OPEN directly.
    await a.engine.cancel(order.id, Date.now());
    await settle(a);
    expect(await transitions(order.id)).toContain('OPEN->CANCELLED');
    expect(await released(order.id)).toEqual([BUY_HOLD]);

    // The gateway, late.
    expect(await cancel(buyer, order.id)).toBe('CANCELLED');
    // The sweeper, acting on a stale read.
    const stale = { ...(await orderOf(order.id)), status: 'PENDING_ENGINE' as const };
    await h.app.trading!.orders.failNeverSeen(stale, 'test');

    expect(await released(order.id)).toEqual([BUY_HOLD]);
    expect((await orderOf(order.id)).status).toBe('CANCELLED');
    expect(await balance(buyer.userId, a.quote)).toEqual({ available: FUNDS.quote, locked: 0n });
  });

  it('an amend releases the old order once and leaves the replacement held', async () => {
    const a = market();
    const buyer = await trader(a);
    const old = await buy(a, buyer);
    const response = await h.app.inject({
      method: 'PATCH',
      url: `/orders/${old.id}`,
      headers: browserHeaders(buyer.cookie),
      payload: {
        clientOrderId: `settle-${RUN}-amend`,
        price: '140000000',
        qty: ONE_SOL.toString(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const replacement = (response.json() as { order: Placed }).order;

    await settle(a);
    expect(await released(old.id)).toEqual([BUY_HOLD]);
    expect((await orderOf(replacement.id)).status).toBe('OPEN');
    expect((await balance(buyer.userId, a.quote)).locked).toBe(BigInt(replacement.holdAmount));
  });
});

describe('halt, do not skip', () => {
  async function expectHalted(a: Arena, key: string, reason: string) {
    expect(worker(a).status().halted).toEqual({ key, reason });
    const halts = logged('settlement.halted', a);
    expect(halts.length).toBeGreaterThan(0);
    return halts;
  }

  it('a fill for an order the gateway never created halts at that key and posts nothing', async () => {
    const a = market();
    const other = market();
    const buyer = await trader(a);
    // The engine fills it against a maker that is not in `orders` at all — an
    // S2 load-client order, whose id is not even a UUID.
    a.engine.behaviour = 'fill';
    const taker = await buy(a, buyer);
    a.engine.behaviour = 'match';

    expect(await settle(a)).toBe(0);
    const halts = await expectHalted(a, '1:0', 'unknown_order');
    // Named by its key alone: no user, order, amount or price (rule 106).
    for (const entry of halts) {
      const line = JSON.stringify(entry);
      expect(line).not.toContain(taker.id);
      expect(line).not.toContain(buyer.userId);
    }

    // No offset moved, nothing posted, and the hold is exactly as it was.
    expect(await offsetOf(a)).toBeNull();
    expect(await fillsOf(a)).toEqual([]);
    expect(await settlementsOf(a)).toBe(0);
    expect(await balance(buyer.userId, a.quote)).toEqual({
      available: FUNDS.quote - BUY_HOLD,
      locked: BUY_HOLD,
    });

    // It does not move on to later events, however many arrive.
    await sell(a, await trader(a));
    expect(await settle(a)).toBe(0);
    expect(await offsetOf(a)).toBeNull();
    expect(a.source.pending()).toBeGreaterThan(0);

    // Another market is its own stream and its own offset, and keeps settling.
    const seller = await trader(other);
    const second = await trader(other);
    await sell(other, seller);
    await buy(other, second);
    expect(await settle(other)).toBe(3);
    expect(await fillsOf(other)).toHaveLength(1);
    expect(worker(other).status().halted).toBeNull();
  });

  it('a fill naming a well-formed order id that does not exist halts the same way', async () => {
    const a = market();
    const seller = await trader(a);
    const maker = await sell(a, seller);
    await settle(a);
    const seq = a.engine.journalEvents([
      {
        kind: 'fill',
        seq: 0n,
        fillId: '2:0',
        takerOrderId: newId(),
        makerOrderId: maker.id,
        takerSide: 'buy',
        price: PRICE,
        qty: ONE_SOL,
      },
    ]);
    expect(seq).toBe(2n);

    expect(await settle(a)).toBe(0);
    await expectHalted(a, '2:0', 'unknown_order');
    expect(await offsetOf(a)).toEqual({ seq: 1n, idx: 0 });
    expect(await fillsOf(a)).toEqual([]);
    expect((await balance(seller.userId, a.base)).locked).toBe(ONE_SOL);
  });

  it('a fill that would consume more than the order held halts rather than posting', async () => {
    const a = market();
    const buyer = await trader(a);
    const seller = await trader(a);
    // Both rest, uncrossed in the book the gateway believes in.
    a.engine.behaviour = 'accept';
    const bid = await buy(a, buyer);
    const ask = await sell(a, seller);
    await settle(a);

    // The engine reports them matched ABOVE the bid's limit: 200 against a hold
    // sized for 150. Balanced, plausible, and more than was reserved.
    a.engine.journalEvents([
      {
        kind: 'fill',
        seq: 0n,
        fillId: '3:0',
        takerOrderId: ask.id,
        makerOrderId: bid.id,
        takerSide: 'sell',
        price: 200_000_000n,
        qty: ONE_SOL,
      },
    ]);
    expect(await settle(a)).toBe(0);
    await expectHalted(a, '3:0', 'over_consumption');

    expect(await fillsOf(a)).toEqual([]);
    expect(await settlementsOf(a)).toBe(0);
    // Nothing went negative, because nothing was posted.
    expect(await balance(buyer.userId, a.quote)).toEqual({
      available: FUNDS.quote - BUY_HOLD,
      locked: BUY_HOLD,
    });
    expect(await balance(seller.userId, a.base)).toEqual({
      available: FUNDS.base - ONE_SOL,
      locked: ONE_SOL,
    });
    expect((await orderOf(bid.id)).status).toBe('OPEN');
  });

  it('an event of a shape it does not recognise halts at its key and is never dropped', async () => {
    const a = market();
    const buyer = await trader(a);
    await buy(a, buyer);
    await settle(a);

    a.source.push({ seq: 2n, idx: 0 }, '{"Liquidated":{"seq":2,"order_id":"x"}}');
    expect(await worker(a).runOnce()).toBe(0);
    await expectHalted(a, '2:0', 'undecodable_event');
    expect(await offsetOf(a)).toEqual({ seq: 1n, idx: 0 });
    // Still pending: not acknowledged, not parked, not skipped.
    expect(a.source.pending()).toBe(1);
  });
});

describe('fees', () => {
  const DAY = 86_400_000n;
  const D0 = BigInt(Date.UTC(2026, 2, 10, 12));
  /** 700 SOL at 150 is 105,000 quote: past the 100,000 that earns tier 1. */
  const BIG = 700n * ONE_SOL;
  const RICH = { quote: 500_000_000_000n, base: 5_000_000_000_000n };

  async function cross(a: Arena, seller: Trader, buyer: Trader, qty: bigint, at: bigint) {
    a.engine.clockMs = at;
    await sell(a, seller, { qty: qty.toString() });
    await buy(a, buyer, { qty: qty.toString() });
  }

  const rates = async (a: Arena) =>
    (await fillsOf(a)).map((fill) => ({
      taker: fill.taker_fee_bps,
      maker: fill.maker_fee_bps,
      takerFee: fill.taker_fee,
      makerFee: fill.maker_fee,
    }));

  it('the tier comes from the fill timestamps, never from when settlement ran', async () => {
    async function history(a: Arena) {
      const seller = await trader(a, RICH);
      const buyer = await trader(a, RICH);
      await cross(a, seller, buyer, BIG, D0);
      // Same UTC day: the day's tier was fixed from the 30 days BEFORE it.
      await cross(a, seller, buyer, ONE_SOL, D0 + 3_600_000n);
      // The next day sees the first day's volume.
      await cross(a, seller, buyer, ONE_SOL, D0 + DAY);
    }
    const first = market();
    const second = market();
    await history(first);
    await history(second);

    await settle(first);
    // The same history, settled more than a year later by the wall clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 400 * 86_400_000);
      await settle(second);
    } finally {
      vi.useRealTimers();
    }

    const fees = await rates(first);
    expect(fees.map((fee) => [fee.taker, fee.maker])).toEqual([
      [20, 10],
      [20, 10],
      [18, 8],
    ]);
    expect(await rates(second)).toEqual(fees);
  });

  it('two markets settling one user’s fills in either order charge identical fees', async () => {
    async function history(pair: { sol: Arena; alt: Arena }) {
      const seller = await trader(pair.sol, RICH);
      const buyer = await trader(pair.sol, RICH);
      await creditTrading(h, seller.userId, pair.alt.base, RICH.base.toString());
      // Yesterday: a little volume, settled before anything else in both runs.
      await cross(pair.sol, seller, buyer, ONE_SOL, D0);
      await settle(pair.sol);
      // Today: enough volume on one market to earn a better tier, and one
      // small fill on the other. A rolling window would price the small fill
      // differently depending on which market's worker ran first.
      await cross(pair.sol, seller, buyer, BIG, D0 + DAY);
      await cross(pair.alt, seller, buyer, ONE_SOL, D0 + DAY + 60_000n);
    }
    const [one, two] = pairs as [(typeof pairs)[0], (typeof pairs)[0]];
    await history(one);
    await history(two);

    await settle(one.sol);
    await settle(one.alt);
    await settle(two.alt);
    await settle(two.sol);

    const sol = await rates(one.sol);
    const alt = await rates(one.alt);
    expect(await rates(two.sol)).toEqual(sol);
    expect(await rates(two.alt)).toEqual(alt);
    // The day's tier was fixed from yesterday's volume: tier 0 throughout.
    expect(alt.map((fee) => [fee.taker, fee.maker])).toEqual([[20, 10]]);
    expect(sol.map((fee) => [fee.taker, fee.maker])).toEqual([
      [20, 10],
      [20, 10],
    ]);
  });
});

describe('reconciling the clearing tier (ADR-0035)', () => {
  const stub: ReconciliationReport = {
    runAt: new Date().toISOString(),
    healthy: true,
    addressesConsidered: 0,
    withdrawalsInFlight: 0,
    users: [],
    divergedUsers: 0,
    assets: [],
  };

  /** A chain that agrees with the ledger, except where a test says otherwise. */
  function service(a: Arena, missing: () => bigint) {
    // Read once: the ledger does not move while a check runs, and this
    // database carries every asset every earlier run ever credited.
    let ledger: Promise<Map<string, bigint>> | undefined;
    const reader = {
      getBalance: async (_address: string, asset: string) => {
        ledger ??= createLedgerRepository(db())
          .getClearingTotals(TEST_CLUSTER)
          .then((rows) => new Map(rows.map((row) => [row.asset, BigInt(row.clearingAssets)])));
        const held = (await ledger).get(asset) ?? 0n;
        return (asset === a.quote ? held - missing() : held).toString();
      },
    } as unknown as ChainReader;
    return createClearingReconciliationService({
      db: db(),
      reader,
      cluster: TEST_CLUSTER,
      clearingAddress: CLEARING_ADDRESS,
      nativeAsset: SOL,
      reserve: 0n,
      markets: [h.app.trading!.markets.get(a.symbol)!],
      consumer: 'settlement',
    });
  }

  it('all three checks are clean after a settled trade, and the slack is the fee equity', async () => {
    const a = market();
    // This database outlives the suite, and holds balances driven negative
    // before the trigger that now refuses them existed. Settlement adds none.
    const negativeBefore =
      await createSettlementRepository(db()).negativeTradingAccounts(TEST_CLUSTER);
    const seller = await trader(a);
    const buyer = await trader(a);
    await sell(a, seller);
    await buy(a, buyer);
    await sell(a, seller, { price: '160000000' }); // rests
    await settle(a);

    const report = await service(a, () => 0n).run();
    const finding = (check: string, subject: string) =>
      report.findings.find((f) => f.check === check && f.subject === subject)!;
    expect(finding('reserve', a.quote).status).toBe('clean');
    expect(finding('equation', a.quote)).toMatchObject({
      status: 'clean',
      detail: { houseTradingFees: (TAKER_FEE + MAKER_FEE).toString(), unexplained: '0' },
    });
    expect(finding('book', a.symbol)).toMatchObject({
      status: 'clean',
      detail: { levelsOnlyInEngine: '0', levelsOnlyInDatabase: '0', levelsDiffering: '0' },
    });
    expect(report.negativeTradingAccounts).toBe(negativeBefore);
  });

  it('a reserve shortfall alerts after its streak, not on one reading', async () => {
    const a = market();
    await trader(a);
    let missing = 0n;
    const clearingService = service(a, () => missing);
    const logs = createCapturingLogger('trace');
    const reconciliation = createReconciliationWorker({
      run: async () => {
        const report = await clearingService.run();
        // This database is shared with every other suite; judge this market's.
        const mine = report.findings.filter((f) => f.subject === a.quote);
        return { ...stub, clearing: { ...report, findings: mine } };
      },
      logger: logs.logger,
      consecutiveCyclesBeforeAlert: 2,
      intervalMs: 1_000,
    });

    await reconciliation.runOnce();
    expect(reconciliation.streak(`reserve:${a.quote}`)).toBe(0);

    missing = 5n;
    await reconciliation.runOnce();
    expect(reconciliation.streak(`reserve:${a.quote}`)).toBe(1);
    expect(logs.text()).not.toContain('clearing_drift_persisted');

    await reconciliation.runOnce();
    const alerts = logs
      .entries()
      .filter((entry) => entry.event === 'reconciliation.clearing_drift_persisted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ targetType: 'reserve', targetId: a.quote });
    // The ledger still balances: only the chain could have said this.
    expect(reconciliation.streak(`equation:${a.quote}`)).toBe(0);
  });

  it('check 3 reports a hold with no resting order, and never compares a book read ahead', async () => {
    const a = market();
    const seller = await trader(a);
    const resting = await sell(a, seller);
    const book = async () =>
      (await service(a, () => 0n).run()).findings.find((f) => f.check === 'book')!;

    // Journaled by the engine and not yet settled: lag, not drift.
    expect((await book()).status).toBe('inconclusive');
    await settle(a);
    expect((await book()).status).toBe('clean');

    // The order leaves the engine's book while the database still holds for it.
    a.engine.fillResting(resting.id, ONE_SOL);
    expect(await book()).toMatchObject({
      status: 'drift',
      detail: { levelsOnlyInDatabase: '1', levelsOnlyInEngine: '0' },
    });
  });

  it('check 3 finds a locked balance that no order accounts for', async () => {
    const a = market();
    const user = await trader(a);
    const settlement = createSettlementRepository(db());
    const before = await settlement.orderLockMismatches(TEST_CLUSTER);

    // A hold posted for an order that does not exist: the book comparison
    // cannot see it, because nothing rests and nothing is expected to.
    await withTransaction(db(), (tx) =>
      postLedger(
        tx,
        postOrderHold({ orderId: newId(), userId: user.userId, asset: a.quote, amount: 1_000n }),
      ),
    );
    expect(await settlement.orderLockMismatches(TEST_CLUSTER)).toBe(before + 1);
  });
});
