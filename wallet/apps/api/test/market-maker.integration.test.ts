import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrderRepository, newId, type OrderRecord } from '@wallet/db';
import { capabilitiesResponseSchema } from '@wallet/types';
import { createMarketMaker, type MarketMaker } from '../src/services/market-maker/market-maker.js';
import type {
  ReferencePrice,
  ReferencePriceSource,
} from '../src/services/market-maker/reference-price.js';
import { createArenas, ONE_SOL, type Arena, type Arenas, type Trader } from './arena.js';
import { createFakeEngine } from './fake-engine.js';
import { seedSession, startHarness, TEST_CLUSTER, type Harness } from './helpers.js';

/**
 * The demo market maker against a real PostgreSQL (prompt_phase_s5.md §12,
 * ADR-0038).
 *
 * What is under test is less what it quotes — the strategy is a pure function
 * with its own unit tests — than HOW: that every quote is an ordinary order,
 * by an ordinary user, with an ordinary hold, and that it stops quoting the
 * moment it cannot see a price or its fills are not settling.
 *
 * It is funded here with the suite's ledger credit. That is correct in a test
 * and is exactly what it must never be given anywhere else.
 */

let t: Arenas;
const makers: MarketMaker[] = [];

beforeAll(async () => {
  t = await createArenas({ count: 12 });
}, 120_000);

afterAll(async () => {
  await t.h.cleanup();
});

const REFERENCE = 150_000_000n;
const NOW = new Date('2026-10-07T12:00:00.000Z');

interface Controlled extends ReferencePriceSource {
  current: ReferencePrice | null;
  asked: number;
}

function controlled(price: bigint | null = REFERENCE): Controlled {
  const source: Controlled = {
    name: 'test',
    current: price === null ? null : { price, observedAt: NOW, generation: 'g1' },
    asked: 0,
    async price() {
      source.asked += 1;
      return source.current;
    },
  };
  return source;
}

async function maker(a: Arena, who: Trader, source: ReferencePriceSource): Promise<MarketMaker> {
  const made = createMarketMaker({
    db: t.h.app.appDeps.db,
    logger: t.h.logs.logger,
    cluster: TEST_CLUSTER,
    orders: t.h.app.trading!.orders,
    markets: t.h.app.trading!.markets,
    source,
    userId: who.userId,
    quoting: { [a.symbol]: { levelQty: ONE_SOL } },
    levels: 3,
    halfSpreadBps: 10,
    levelStepBps: 10,
    intervalMs: 1_000,
    staleMs: 10_000,
    settlementState: (symbol) =>
      t.h.app.trading!.settlement.get(symbol)!.status().halted ? 'halted' : 'live',
    clock: () => NOW,
  });
  expect(await made.init()).toBe(true);
  makers.push(made);
  return made;
}

const RICH = { quote: 100_000_000_000n, base: 100_000_000_000n };

const openOf = async (who: Trader, a: Arena): Promise<OrderRecord[]> =>
  (await createOrderRepository(t.h.app.appDeps.db).listOpenForUser(who.userId, a.marketId)).sort(
    (x, y) => (BigInt(x.price!) < BigInt(y.price!) ? -1 : 1),
  );

const BIDS = ['149550000', '149700000', '149850000'];
const ASKS = ['150150000', '150300000', '150450000'];

// ---------------------------------------------------------------------------

describe('it is a user', () => {
  it('quotes a two-sided ladder as ordinary orders with ordinary holds', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const m = await maker(a, who, controlled());
    await m.runOnce();

    const open = await openOf(who, a);
    expect(open.map((o) => [o.side, o.price])).toEqual([
      ...BIDS.map((price) => ['buy', price]),
      ...ASKS.map((price) => ['sell', price]),
    ]);
    for (const order of open) {
      // Its own orders, in the same table, accepted by the same engine.
      expect(order.userId).toBe(who.userId);
      expect(order.status).toBe('OPEN');
      expect(order.kind).toBe('limit');
    }
    // Deterministic ids: market, generation, side, level.
    expect(open.map((o) => o.clientOrderId)).toContain(`mm:${a.symbol}:g1:buy:0`);

    // Real holds, taken by the gateway before the engine saw each order:
    // three asks of one SOL, and each bid's notional plus the worst-case fee.
    expect((await t.balance(who.userId, a.base)).locked).toBe(3n * ONE_SOL);
    const bidHolds = BIDS.reduce((sum, price) => sum + (BigInt(price) * 1_002n) / 1_000n, 0n);
    expect((await t.balance(who.userId, a.quote)).locked).toBe(bidHolds);
    expect(open.reduce((sum, o) => sum + (o.side === 'buy' ? BigInt(o.holdAmount) : 0n), 0n)).toBe(
      bidHolds,
    );

    // And it is what the book shows.
    const depth = (await a.engine.depth())!;
    expect(depth.bids).toHaveLength(3);
    expect(depth.asks).toHaveLength(3);
  });

  it('a user’s order fills against it and settles: real fees, real balances, both sides', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const m = await maker(a, who, controlled());
    await m.runOnce();

    const taker = await t.trader(a);
    // A market buy: fills the maker's best ask at 150.15.
    a.engine.referencePrice = REFERENCE;
    await t.buy(a, taker, { type: 'market', price: null });
    await t.settle(a);

    const paid = 150_150_000n;
    expect((await t.balance(taker.userId, a.base)).available).toBe(10_000_000_000n + ONE_SOL);
    // The maker rested: it earns the notional less the MAKER fee, like anyone.
    expect((await t.balance(who.userId, a.quote)).available).toBe(
      RICH.quote - (await t.balance(who.userId, a.quote)).locked + paid - (paid * 10n) / 10_000n,
    );
    expect(t.h.app.trading!.settlement.get(a.symbol)!.status().halted).toBeNull();

    // Next cycle, same generation: the filled level is not re-placed under an
    // id the gateway has already seen. It comes back with the next generation.
    await m.runOnce();
    expect((await openOf(who, a)).filter((o) => o.side === 'sell')).toHaveLength(2);
  });

  it('re-issuing a generation after a restart places nothing twice', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const source = controlled();
    await (await maker(a, who, source)).runOnce();
    const before = (await openOf(who, a)).map((o) => o.id);
    const placedBefore = a.engine.placed.length;

    // A new process: no memory of what it placed, the same generation to quote.
    await (await maker(a, who, source)).runOnce();
    expect((await openOf(who, a)).map((o) => o.id)).toEqual(before);
    expect(a.engine.placed.length).toBe(placedBefore);
  });

  it('quotes only the side it can fund, and running out is not an error', async () => {
    const a = t.market();
    // Base, and no quote asset at all.
    const who = await t.trader(a, { quote: 1n, base: 100_000_000_000n });
    const m = await maker(a, who, controlled());
    t.h.logs.clear();
    await m.runOnce();
    await m.runOnce();

    const open = await openOf(who, a);
    expect(open.map((o) => o.side)).toEqual(['sell', 'sell', 'sell']);
    expect(t.h.logs.entries().filter((entry) => entry.level === 'error')).toEqual([]);
    // No bid was attempted: nothing took a hold to release it again.
    expect(a.engine.placed.filter((p) => p.side === 'buy')).toEqual([]);
  });
});

describe('it never quotes a price it cannot see', () => {
  it('leaves the ladder alone for a small move, and requotes once the reference moves a level', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const source = controlled();
    const m = await maker(a, who, source);
    await m.runOnce();
    const first = (await openOf(who, a)).map((o) => o.id);

    // Five basis points: under the level step. Cancelling and replacing six
    // orders for this would spend the order-rate limit on nothing.
    source.current = { price: 150_075_000n, observedAt: NOW, generation: 'g2' };
    await m.runOnce();
    expect((await openOf(who, a)).map((o) => o.id)).toEqual(first);

    source.current = { price: 151_500_000n, observedAt: NOW, generation: 'g3' };
    await m.runOnce();
    const requoted = await openOf(who, a);
    expect(requoted).toHaveLength(6);
    expect(requoted.some((o) => first.includes(o.id))).toBe(false);
    expect(requoted.map((o) => o.clientOrderId)).toContain(`mm:${a.symbol}:g3:sell:0`);
    // Cancelled before anything was placed: its new bid never met its old ask.
    expect((await a.engine.depth())!.asks.every((l) => l.price > 151_500_000n)).toBe(true);
    for (const id of first) {
      expect((await createOrderRepository(t.h.app.appDeps.db).findById(id))?.status).toBe(
        'CANCELLED',
      );
    }
  });

  it('pulls every quote when the reference goes stale, rather than leave it resting', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const source = controlled();
    const m = await maker(a, who, source);
    await m.runOnce();
    expect(await openOf(who, a)).toHaveLength(6);

    // The feed stopped eleven seconds ago. The bound is ten.
    source.current = { ...source.current!, observedAt: new Date(NOW.getTime() - 11_000) };
    await m.runOnce();
    expect(await openOf(who, a)).toEqual([]);
    expect(await t.balance(who.userId, a.base)).toEqual({ available: RICH.base, locked: 0n });
    expect(await t.balance(who.userId, a.quote)).toEqual({ available: RICH.quote, locked: 0n });
    expect((await a.engine.depth())!.asks).toEqual([]);

    const pulls = t.h.logs
      .entries()
      .filter((e) => e.event === 'market_maker.quotes_pulled' && e.targetId === a.symbol);
    expect(pulls.map((e) => e.reason)).toEqual(['reference_stale']);
    // Said once, not on every cycle it stays stale.
    await m.runOnce();
    expect(
      t.h.logs
        .entries()
        .filter((e) => e.event === 'market_maker.quotes_pulled' && e.targetId === a.symbol),
    ).toHaveLength(1);
  });

  it('quotes nothing when the source has nothing to say — it has no other source to ask', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const source = controlled(null);
    const m = await maker(a, who, source);
    await m.runOnce();
    expect(await openOf(who, a)).toEqual([]);
    expect(a.engine.placed).toEqual([]);
    expect(source.asked).toBe(1);
  });

  it('stops quoting a market whose fills are not settling', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const m = await maker(a, who, controlled());
    await m.runOnce();
    expect(await openOf(who, a)).toHaveLength(6);
    await t.settle(a);

    // A fill settlement cannot apply: the market halts.
    a.engine.journalEvents([
      {
        kind: 'fill',
        seq: 0n,
        fillId: 'x:0',
        takerOrderId: newId(),
        makerOrderId: (await openOf(who, a))[0]!.id,
        takerSide: 'sell',
        price: REFERENCE,
        qty: ONE_SOL,
      },
    ]);
    await t.settle(a);
    expect(t.h.app.trading!.settlement.get(a.symbol)!.status().halted).not.toBeNull();

    // Its view of its own inventory is now behind. It gets out.
    await m.runOnce();
    expect((await a.engine.depth())!.bids).toEqual([]);
    expect((await a.engine.depth())!.asks).toEqual([]);
    expect(
      t.h.logs
        .entries()
        .filter((e) => e.event === 'market_maker.quotes_pulled' && e.targetId === a.symbol)
        .map((e) => e.reason),
    ).toEqual(['settlement_halted']);
  });

  it('cancels what it has resting when it stops', async () => {
    const a = t.market();
    const who = await t.trader(a, RICH);
    const m = await maker(a, who, controlled());
    await m.runOnce();
    await m.stop();
    expect(await openOf(who, a)).toEqual([]);
    expect((await t.balance(who.userId, a.quote)).locked).toBe(0n);
    // Stopped is stopped.
    await m.runOnce();
    expect(await openOf(who, a)).toEqual([]);
  });
});

describe('whether it may start', () => {
  const symbol = () => `SOL-K${t.run}`;
  let second: Harness | undefined;

  afterAll(async () => {
    await second?.cleanup();
  });

  async function boot(userId: string): Promise<Harness> {
    const { Keypair } = await import('@solana/web3.js');
    const engine = createFakeEngine({
      market: symbol(),
      marketId: `${TEST_CLUSTER}:${symbol()}`,
      tickSize: 1_000n,
      lotSize: 1_000_000n,
      minNotional: 1_000n,
      collarBps: 5_000,
    });
    await second?.cleanup();
    second = await startHarness({
      tokens: [
        {
          symbol: `K${t.run}`,
          mint: Keypair.generate().publicKey.toBase58(),
          decimals: 6,
          perTransactionLimit: '1',
          dailyLimit: '1',
          manualReviewAbove: '1',
        },
      ],
      trading: {
        engines: new Map([[symbol(), engine]]),
        clearingAddress: 'So11111111111111111111111111111111111111112',
        markets: [
          {
            symbol: symbol(),
            tickSize: '1000',
            lotSize: '1000000',
            minNotional: '1000',
            collarBps: 5_000,
          },
        ],
        marketData: {
          tapeSources: new Map(),
          fanoutSources: new Map(),
          start: { [symbol()]: { seq: 0n, idx: 0 } },
        },
        marketMaker: {
          userId,
          markets: { [symbol()]: { levelQty: ONE_SOL, startPrice: REFERENCE } },
        },
      },
    });
    return second;
  }

  const synthetic = async (h: Harness) =>
    capabilitiesResponseSchema.parse(
      (await h.app.inject({ method: 'GET', url: '/capabilities' })).json(),
    ).trading.syntheticLiquidity;

  it('refuses without a user that exists — and the API carries on without it', async () => {
    const h = await boot(newId());
    expect(h.app.trading!.marketMaker).toBeNull();
    expect(
      h.logs
        .entries()
        .filter((e) => e.event === 'market_maker.start_refused')
        .map((e) => e.reason),
    ).toEqual(['no_such_user']);
    // Nothing created the user to make it work.
    expect((await h.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    // The interface is told the truth: there is no synthetic liquidity here.
    expect(await synthetic(h)).toBe(false);
  });

  it('starts as a user that exists, and the deployment says its liquidity is synthetic', async () => {
    const user = await seedSession(t.h);
    const h = await boot(user.userId);
    expect(h.app.trading!.marketMaker).not.toBeNull();
    expect(await synthetic(h)).toBe(true);
    // Unfunded: it runs, quotes nothing, and credits itself nothing.
    await h.app.trading!.marketMaker!.runOnce();
    const open = await createOrderRepository(h.app.appDeps.db).listOpenForUser(
      user.userId,
      `${TEST_CLUSTER}:${symbol()}`,
    );
    expect(open).toEqual([]);
    expect(await t.balance(user.userId, `${TEST_CLUSTER}:SOL`)).toEqual({
      available: 0n,
      locked: 0n,
    });
  });
});
