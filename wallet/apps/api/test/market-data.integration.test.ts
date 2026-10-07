import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMarketDataRepository,
  createOrderRepository,
  createSettlementRepository,
  newId,
  userChanges,
  withTransaction,
  type PrismaClient,
} from '@wallet/db';
import { allOrderTransitions, capabilitiesResponseSchema } from '@wallet/types';
import {
  createArenas,
  FUNDS,
  MAKER_FEE,
  NOTIONAL,
  ONE_SOL,
  PRICE,
  TAKER_FEE,
  type Arena,
  type Arenas,
  type Trader,
} from './arena.js';
import { MARKET_DATA_CONSUMER } from '../src/services/market-data/tape-consumer.js';
import type { FanoutMessage } from '../src/services/market-data/fanout.js';
import { seedSteppedUpSession } from './helpers.js';

/**
 * Market data against a real PostgreSQL (prompt_phase_s5.md §17, ADR-0036).
 *
 * The engine is the fake that matches; the three readers of its stream —
 * settlement, the trade tape, the live fan-out — each read a stream this suite
 * controls, so a case can deliver twice to one, lose a sequence from another,
 * and halt a third, and see that none of them leans on the others.
 */

let t: Arenas;
let db: PrismaClient;

beforeAll(async () => {
  // Three levels a side, so a fourth is one more than a snapshot may carry.
  t = await createArenas({ count: 28, bookMaxLevels: 3 });
  db = t.h.app.appDeps.db;
}, 120_000);

afterAll(async () => {
  await t.h.cleanup();
});

const tape = (a: Arena) => t.h.app.trading!.tapes.get(a.symbol)!;
const fanout = (a: Arena) => t.h.app.trading!.fanouts.get(a.symbol)!;
const settlement = (a: Arena) => t.h.app.trading!.settlement.get(a.symbol)!;
const tapeOffset = (a: Arena) =>
  createSettlementRepository(db).getOffset(MARKET_DATA_CONSUMER, a.marketId);

interface TradeRow {
  seq: bigint;
  fill_index: number;
  price: string;
  qty: string;
  quote_qty: string;
  taker_side: string;
}
const tradesOf = (a: Arena) => db.$queryRaw<TradeRow[]>`
  SELECT seq, fill_index, price::text AS price, qty::text AS qty,
         quote_qty::text AS quote_qty, taker_side::text AS taker_side
  FROM trades WHERE market = ${a.marketId} ORDER BY seq, fill_index`;

const candleRows = (a: Arena) => db.$queryRaw<Array<Record<string, unknown>>>`
  SELECT bucket_start, open::text AS open, high::text AS high, low::text AS low,
         close::text AS close, open_seq, open_index, close_seq, close_index,
         base_volume::text AS base_volume, quote_volume::text AS quote_volume, trade_count
  FROM candles WHERE market = ${a.marketId} ORDER BY bucket_start`;

/** A maker rests and a taker crosses it, at `price`, stamped `at`. */
async function trade(
  a: Arena,
  seller: Trader,
  buyer: Trader,
  options: { price?: bigint; qty?: bigint; at?: bigint } = {},
): Promise<void> {
  if (options.at !== undefined) a.engine.clockMs = options.at;
  const body = {
    price: (options.price ?? PRICE).toString(),
    qty: (options.qty ?? ONE_SOL).toString(),
  };
  await t.sell(a, seller, body);
  await t.buy(a, buyer, body);
}

// ---------------------------------------------------------------------------

describe('the trade tape', () => {
  it('records a fill from the stream, without waiting for settlement', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await trade(a, seller, buyer);

    // Settlement has not run. The tape does not need it to.
    expect(await t.record(a)).toBe(3);
    expect(await tradesOf(a)).toEqual([
      {
        seq: 2n,
        fill_index: 0,
        price: PRICE.toString(),
        qty: ONE_SOL.toString(),
        // The same integer both legs of the fill will settle at.
        quote_qty: NOTIONAL.toString(),
        taker_side: 'buy',
      },
    ]);
    // Its own row in engine_offsets: never settlement's.
    expect(await tapeOffset(a)).toEqual({ seq: 2n, idx: 1 });
    expect(await createSettlementRepository(db).getOffset('settlement', a.marketId)).toBeNull();
    expect((await t.balance(buyer.userId, a.quote)).locked).toBeGreaterThan(0n);
  });

  it('delivering every event twice records each trade once and leaves every candle unchanged', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await trade(a, seller, buyer);
    await trade(a, seller, buyer, { price: 151_000_000n });
    await t.record(a);
    const trades = await tradesOf(a);
    const candles = await candleRows(a);
    expect(trades).toHaveLength(2);

    a.tapeSource.republish();
    expect(await tape(a).runOnce()).toBe(0);
    expect(await tradesOf(a)).toEqual(trades);
    expect(await candleRows(a)).toEqual(candles);
    expect(a.tapeSource.pending()).toBe(0);
  });

  it('a wiped stream is recovered through re-emission, with no trade missing and none doubled', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await trade(a, seller, buyer);
    await trade(a, seller, buyer);
    await a.tapeSource.publish();
    a.tapeSource.wipe();

    await t.record(a);
    expect(
      (await tradesOf(a)).map((row) => `${row.seq.toString()}:${String(row.fill_index)}`),
    ).toEqual(['2:0', '4:0']);
    expect(await tapeOffset(a)).toEqual({ seq: 4n, idx: 1 });
  });

  it('halts at an event it cannot record, and settlement for the same market carries on', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    const maker = await t.sell(a, seller);
    const taker = await t.buy(a, buyer, { price: '140000000' }); // rests below: no cross
    a.engine.behaviour = 'accept';
    // A fill between two real, held orders — under an id that is not `seq:k`.
    // Settlement keys by the id it is given and has no reason to refuse it;
    // the tape orders a bucket by `k` and cannot place this trade.
    a.engine.journalEvents([
      {
        kind: 'fill',
        seq: 0n,
        fillId: 'not-a-fill-id',
        takerOrderId: taker.id,
        makerOrderId: maker.id,
        takerSide: 'buy',
        price: 140_000_000n,
        qty: ONE_SOL,
      },
    ]);

    await t.record(a);
    expect(tape(a).status().halted).toEqual({ key: '3:0', reason: 'fill_id_mismatch' });
    expect(await tradesOf(a)).toEqual([]);
    expect(await tapeOffset(a)).toEqual({ seq: 2n, idx: 0 });
    // Still pending: not acknowledged, not skipped.
    expect(a.tapeSource.pending()).toBe(1);
    const halts = t.h.logs
      .entries()
      .filter((entry) => entry.event === 'market_data.halted' && entry.targetId === a.symbol);
    expect(halts.length).toBeGreaterThan(0);

    // Settlement is a different consumer with a different offset.
    expect(await t.settle(a)).toBe(3);
    expect(settlement(a).status().halted).toBeNull();
    expect((await t.balance(buyer.userId, a.base)).available).toBe(FUNDS.base + ONE_SOL);
  });

  it('a halted settlement worker stops neither the tape nor the book', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const maker = await t.sell(a, seller);
    // A fill whose taker the gateway never created: settlement cannot settle it.
    a.engine.journalEvents([
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
    await t.settle(a);
    expect(settlement(a).status().halted).toEqual({ key: '2:0', reason: 'unknown_order' });

    // The match is public whether or not the ledger could take it.
    await t.record(a);
    expect(await tradesOf(a)).toHaveLength(1);
    expect(tape(a).status().halted).toBeNull();
    await t.fan(a);
    expect(fanout(a).book()?.seq).toBe(2n);

    // ...and the market says so, coarsely, on the screen that trades it.
    const markets = (await t.get(seller, '/markets')).body as {
      markets: Array<{ symbol: string; settlement: string }>;
    };
    expect(markets.markets.find((m) => m.symbol === a.symbol)?.settlement).toBe('halted');
  });

  it('refuses to start with no offset and no configured start, like settlement', async () => {
    const { createTapeConsumer, TapeStartRefusedError } = await import(
      '../src/services/market-data/tape-consumer.js'
    );
    const a = t.market();
    expect(await tapeOffset(a)).toBeNull();
    const consumer = createTapeConsumer({
      db,
      logger: t.h.logs.logger,
      market: { id: a.marketId, symbol: a.symbol },
      source: a.tapeSource,
      reemitter: {
        eventsAfter: (after, limit) => a.engine.rawEvents(after, limit),
        lastSeq: async () => (await a.engine.health())?.lastSeq ?? null,
      },
    });
    await expect(consumer.init()).rejects.toBeInstanceOf(TapeStartRefusedError);
  });
});

describe('candles', () => {
  const MINUTE = 60_000n;
  const T0 = BigInt(Date.UTC(2026, 2, 10, 12, 0, 10));

  /** Three trades whose timestamps disagree with their sequence order. */
  async function outOfOrder(a: Arena) {
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await trade(a, seller, buyer, { price: 150_000_000n, at: T0 }); // 12:00:10
    await trade(a, seller, buyer, { price: 151_000_000n, at: T0 + MINUTE }); // 12:01:10
    // Matched LAST, stamped back in the first minute: the gateway signed it
    // earlier than the engine sequenced it (ADR-0031).
    await trade(a, seller, buyer, { price: 149_000_000n, at: T0 + 40_000n }); // 12:00:50
    await t.record(a);
  }

  it('a late trade lands in its own bucket, and open and close follow the engine, not the clock', async () => {
    const a = t.market();
    await outOfOrder(a);

    const rows = await createMarketDataRepository(db).listCandles(
      a.marketId,
      60,
      new Date(Number(T0 - MINUTE)),
      new Date(Number(T0 + 10n * MINUTE)),
      100,
    );
    expect(
      rows.map((c) => [
        c.bucketStart.toISOString().slice(11, 16),
        c.open,
        c.high,
        c.low,
        c.close,
        c.tradeCount,
      ]),
    ).toEqual([
      // The first minute was recomputed when the late trade arrived: it CLOSES
      // at the last-matched trade (149), which is also its low.
      ['12:00', 150_000_000n, 150_000_000n, 149_000_000n, 149_000_000n, 2],
      ['12:01', 151_000_000n, 151_000_000n, 151_000_000n, 151_000_000n, 1],
    ]);
    expect(rows[0]!.baseVolume).toBe(2n * ONE_SOL);
    // Summed from each trade's own integer notional, never recomputed in bulk.
    expect(rows[0]!.quoteVolume).toBe(150_000_000n + 149_000_000n);
  });

  it('a wider interval aggregated from one-minute rows equals the same interval computed from trades', async () => {
    const a = t.market();
    await outOfOrder(a);
    const repository = createMarketDataRepository(db);
    const from = new Date(Number(T0 - 60n * MINUTE));
    const to = new Date(Number(T0 + 60n * MINUTE));

    for (const seconds of [300, 900, 3_600, 86_400]) {
      const aggregated = await repository.listCandles(a.marketId, seconds, from, to, 100);
      expect(aggregated, `${String(seconds)}s`).toEqual(
        await repository.candlesFromTrades(a.marketId, seconds, from, to),
      );
    }
    // By the clock the five-minute bar would close at 151. By the engine's
    // order it closes at 149: the last trade it matched.
    const [five] = await repository.listCandles(a.marketId, 300, from, to, 100);
    expect([five!.open, five!.close]).toEqual([150_000_000n, 149_000_000n]);
  });

  it('a rebuild from trades reproduces the table exactly', async () => {
    const a = t.market();
    await outOfOrder(a);
    const before = await candleRows(a);
    expect(before).toHaveLength(2);

    const rebuilt = await withTransaction(db, (tx) =>
      createMarketDataRepository(tx).rebuildCandles(a.marketId, tx),
    );
    expect(rebuilt).toBe(2);
    expect(await candleRows(a)).toEqual(before);
  });

  it('a bucket with no trades has no row, and the ticker never says zero for "nothing"', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);

    const empty = (await t.get(seller, `/markets/${a.symbol}/ticker`)).body as {
      ticker: Record<string, unknown>;
    };
    expect(empty.ticker).toMatchObject({
      lastPrice: null,
      lastTradeTime: null,
      open24h: null,
      high24h: null,
      low24h: null,
      baseVolume24h: '0',
    });

    // Months ago: outside any 24-hour window ending now.
    await trade(a, seller, buyer, { at: T0 });
    await trade(a, seller, buyer, { at: T0 + 5n * MINUTE, price: 152_000_000n });
    await t.record(a);
    const old = (await t.get(seller, `/markets/${a.symbol}/ticker`)).body as {
      ticker: Record<string, unknown>;
    };
    // The last price is the most recent trade EVER, with its own time.
    expect(old.ticker).toMatchObject({ lastPrice: '152000000', open24h: null, high24h: null });

    const candles = (
      await t.get(
        seller,
        `/markets/${a.symbol}/candles?interval=1m&from=${new Date(Number(T0 - MINUTE)).toISOString()}&to=${new Date(Number(T0 + 10n * MINUTE)).toISOString()}`,
      )
    ).body as { candles: Array<{ time: string }> };
    // Minutes 12:01 to 12:04 had no trade and have no candle.
    expect(candles.candles.map((c) => c.time.slice(11, 16))).toEqual(['12:00', '12:05']);

    await trade(a, seller, buyer, { at: BigInt(Date.now()) - 60_000n, price: 148_000_000n });
    await t.record(a);
    const today = (await t.get(seller, `/markets/${a.symbol}/ticker`)).body as {
      ticker: Record<string, unknown>;
    };
    expect(today.ticker).toMatchObject({
      lastPrice: '148000000',
      open24h: '148000000',
      high24h: '148000000',
      low24h: '148000000',
      baseVolume24h: ONE_SOL.toString(),
    });
  });
});

describe('the live book', () => {
  const view = (a: Arena) => {
    const book = fanout(a).book();
    const level = (l: { price: bigint; qty: bigint }) =>
      `${l.price.toString()}x${l.qty.toString()}`;
    return book && { seq: book.seq, bids: book.bids.map(level), asks: book.asks.map(level) };
  };
  const engineView = async (a: Arena) => {
    const depth = (await a.engine.depth())!;
    const level = (l: { price: bigint; qty: bigint }) =>
      `${l.price.toString()}x${l.qty.toString()}`;
    return {
      seq: depth.seq,
      bids: [...depth.bids].sort((x, y) => (x.price > y.price ? -1 : 1)).map(level),
      asks: [...depth.asks].sort((x, y) => (x.price < y.price ? -1 : 1)).map(level),
    };
  };

  it('is not served until there is one to vouch for', async () => {
    const a = t.market();
    const who = await t.trader(a);
    expect(fanout(a).book()).toBeNull();
    // 503, not an empty book: "not now" is true, an empty book would be a claim.
    expect((await t.get(who, `/markets/${a.symbol}/book`)).status).toBe(503);
  });

  it('follows the engine through rests, crosses, partial fills, cancels and an amend', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await t.fan(a); // a snapshot of the empty book
    expect(view(a)).toEqual({ seq: 0n, bids: [], asks: [] });

    const steps: Array<() => Promise<unknown>> = [
      () => t.sell(a, seller, { price: '151000000' }),
      () => t.sell(a, seller, { price: '151000000', qty: '500000000' }),
      () => t.sell(a, seller, { price: '152000000' }),
      () => t.buy(a, buyer, { price: '149000000' }),
      // Crosses the best ask in part, then in full, then into the next level.
      () => t.buy(a, buyer, { price: '151000000', qty: '400000000' }),
      () => t.buy(a, buyer, { price: '152000000', qty: '1500000000' }),
    ];
    for (const step of steps) {
      await step();
      await t.fan(a);
      expect(view(a)).toEqual(await engineView(a));
    }

    const resting = await t.buy(a, buyer, { price: '148000000' });
    await t.fan(a);
    await t.cancel(buyer, resting.id);
    await t.fan(a);
    expect(view(a)).toEqual(await engineView(a));

    const old = await t.sell(a, seller, { price: '153000000' });
    await t.fan(a);
    const amended = await t.h.app.inject({
      method: 'PATCH',
      url: `/orders/${old.id}`,
      headers: { ...(await import('./helpers.js')).browserHeaders(seller.cookie) },
      payload: { clientOrderId: `md-${t.run}-amend`, price: '154000000', qty: ONE_SOL.toString() },
    });
    expect(amended.statusCode, amended.body).toBe(200);
    await t.fan(a);
    expect(view(a)).toEqual(await engineView(a));

    // And over REST, the same book at the same sequence.
    const rest = (await t.get(buyer, `/markets/${a.symbol}/book`)).body as {
      book: { seq: string; bids: string[][]; asks: string[][] };
    };
    const now = view(a)!;
    expect(rest.book.seq).toBe(now.seq.toString());
    expect(rest.book.asks.map(([p, q]) => `${p!}x${q!}`)).toEqual(now.asks);
    expect(rest.book.bids.map(([p, q]) => `${p!}x${q!}`)).toEqual(now.bids);
  });

  it('a missing sequence makes it say so and take a snapshot — never apply across the hole', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    await t.fan(a);
    const messages: FanoutMessage[] = [];
    const off = fanout(a).subscribe((message) => messages.push(message));

    await t.sell(a, seller, { price: '151000000' });
    await t.sell(a, seller, { price: '152000000' });
    await t.sell(a, seller, { price: '153000000' });
    await a.fanoutSource.publish();
    a.fanoutSource.drop((entry) => entry.seq === 2n);
    await fanout(a).runOnce();

    // Sequence 1 applied. Sequence 3 arrived where 2 should be.
    expect(messages.map((m) => m.kind)).toEqual(['delta', 'resync']);
    expect(fanout(a).book()).toBeNull();

    await fanout(a).runOnce();
    off();
    expect(messages.map((m) => m.kind)).toEqual(['delta', 'resync', 'snapshot']);
    // The snapshot is the engine's book, including the sequence it never saw.
    expect(view(a)).toEqual(await engineView(a));
  });

  it('a sequence whose last entry carries no levels is unknown, not unchanged', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    await t.fan(a);
    const messages: FanoutMessage[] = [];
    const off = fanout(a).subscribe((message) => messages.push(message));

    a.fanoutSource.withholdLevels(true);
    await t.sell(a, seller, { price: '151000000' });
    await a.fanoutSource.publish();
    a.fanoutSource.withholdLevels(false);
    await fanout(a).runOnce();
    // Read, and not applied: nothing was published about it.
    expect(messages).toEqual([]);
    expect(view(a)?.seq).toBe(0n);

    // The stream is quiet while the engine is ahead. Twice is enough.
    await fanout(a).runOnce();
    await fanout(a).runOnce();
    expect(messages.map((m) => m.kind)).toEqual(['resync']);
    await fanout(a).runOnce();
    off();
    expect(view(a)).toEqual(await engineView(a));
  });

  it('sends at most the configured depth, and says when the book is deeper', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    for (const price of ['151000000', '152000000', '153000000', '154000000']) {
      await t.sell(a, seller, { price });
    }
    await t.fan(a);
    const book = fanout(a).book()!;
    expect(book.truncated).toBe(true);
    // The best three, ascending. The fourth is not invented away: it is flagged.
    expect(book.asks.map((l) => l.price)).toEqual([151_000_000n, 152_000_000n, 153_000_000n]);
  });

  it('publishes each trade with nothing but what is public', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await t.fan(a);
    const messages: FanoutMessage[] = [];
    const off = fanout(a).subscribe((message) => messages.push(message));
    const maker = await t.sell(a, seller);
    const taker = await t.buy(a, buyer);
    await t.fan(a);
    off();

    const trades = messages.filter((m) => m.kind === 'trade');
    expect(trades).toHaveLength(1);
    const serialised = JSON.stringify(trades, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const secret of [maker.id, taker.id, seller.userId, buyer.userId]) {
      expect(serialised).not.toContain(secret);
    }
    // The trade is announced before the delta that carries its level change.
    expect(messages.map((m) => m.kind)).toEqual(['delta', 'trade', 'delta']);
  });
});

describe('REST', () => {
  it('pages the public tape newest first, to its end', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    for (let i = 0; i < 3; i += 1) await trade(a, seller, buyer);
    await t.record(a);

    const first = (await t.get(buyer, `/markets/${a.symbol}/trades?limit=2`)).body as {
      trades: Array<Record<string, unknown>>;
      nextBefore: string | null;
    };
    expect(first.trades.map((x) => x.id)).toEqual(['6:0', '4:0']);
    expect(first.nextBefore).toBe('4:0');
    // Exactly the public fields. No order id, user id or fee has a key here.
    expect(Object.keys(first.trades[0]!).sort()).toEqual(
      ['id', 'price', 'qty', 'seq', 'takerSide', 'time'].sort(),
    );

    const second = (
      await t.get(buyer, `/markets/${a.symbol}/trades?limit=2&before=${first.nextBefore!}`)
    ).body as { trades: Array<{ id: string }>; nextBefore: string | null };
    expect(second.trades.map((x) => x.id)).toEqual(['2:0']);
    expect(second.nextBefore).toBeNull();
  });

  it('bounds every list: a limit past the maximum is refused, not clamped silently', async () => {
    const a = t.market();
    const who = await t.trader(a);
    expect((await t.get(who, `/markets/${a.symbol}/trades?limit=201`)).status).toBe(400);
    expect((await t.get(who, `/markets/${a.symbol}/candles?limit=1001`)).status).toBe(400);
    expect((await t.get(who, '/fills?limit=201')).status).toBe(400);
    expect((await t.get(who, '/orders?limit=201')).status).toBe(400);
    expect((await t.get(who, '/markets/NOPE-NOPE/trades')).status).toBe(404);
  });

  it("a user's fills are their own side only — never the counterparty's user, order or fee", async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    const maker = await t.sell(a, seller);
    const taker = await t.buy(a, buyer);
    await t.settle(a);

    const mine = await t.get(buyer, `/fills?market=${a.symbol}`);
    const theirs = await t.get(seller, '/fills');
    expect((mine.body as { fills: unknown[] }).fills).toEqual([
      {
        id: '2:0',
        market: a.symbol,
        orderId: taker.id,
        side: 'buy',
        role: 'taker',
        price: PRICE.toString(),
        qty: ONE_SOL.toString(),
        notional: NOTIONAL.toString(),
        fee: TAKER_FEE.toString(),
        feeBps: 20,
        time: expect.any(String) as unknown,
      },
    ]);
    expect((theirs.body as { fills: Array<Record<string, unknown>> }).fills[0]).toMatchObject({
      orderId: maker.id,
      side: 'sell',
      role: 'maker',
      fee: MAKER_FEE.toString(),
      feeBps: 10,
    });

    // Asserted on the bytes that left, not on the object that was built.
    const buyerBytes = JSON.stringify(mine.body);
    for (const secret of [maker.id, seller.userId, `"${MAKER_FEE.toString()}"`]) {
      expect(buyerBytes).not.toContain(secret);
    }
    const sellerBytes = JSON.stringify(theirs.body);
    for (const secret of [taker.id, buyer.userId, `"${TAKER_FEE.toString()}"`]) {
      expect(sellerBytes).not.toContain(secret);
    }

    // A third user traded nothing and sees nothing.
    const stranger = await t.trader(a);
    expect(((await t.get(stranger, '/fills')).body as { fills: unknown[] }).fills).toEqual([]);
  });

  it('an order history can be read to its end, and filtered to what is open', async () => {
    const a = t.market();
    const who = await t.trader(a);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await t.buy(a, who, { price: String(140_000_000 + i * 1_000) })).id);
    }
    await t.cancel(who, ids[0]!);

    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url: string =
        `/orders?market=${a.symbol}&limit=2` + (before ? `&before=${before}` : '');
      const body = (await t.get(who, url)).body as {
        orders: Array<{ id: string }>;
        nextBefore: string | null;
      };
      seen.push(...body.orders.map((o) => o.id));
      before = body.nextBefore;
      if (before === null) break;
    }
    // Newest first, every order exactly once, and the paging stopped.
    expect(seen).toEqual([...ids].reverse());
    expect(before).toBeNull();

    const open = (await t.get(who, `/orders?market=${a.symbol}&status=open`)).body as {
      orders: Array<{ id: string }>;
    };
    expect(open.orders.map((o) => o.id).sort()).toEqual(ids.slice(1).sort());
  });

  it('a market view carries its settlement state and its ticker', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await trade(a, seller, buyer, { at: BigInt(Date.now()) - 1_000n });
    await t.pump(a);

    const body = (await t.get(buyer, '/markets')).body as {
      markets: Array<{ symbol: string; settlement: string; ticker: { lastPrice: string } | null }>;
    };
    const market = body.markets.find((m) => m.symbol === a.symbol)!;
    expect(market.settlement).toBe('live');
    expect(market.ticker?.lastPrice).toBe(PRICE.toString());
  });

  it('capabilities say what the exchange side of this deployment does', async () => {
    const response = await t.h.app.inject({ method: 'GET', url: '/capabilities' });
    const capabilities = capabilitiesResponseSchema.parse(response.json());
    expect(capabilities.trading).toEqual({
      enabled: true,
      settlement: true,
      marketData: true,
      syntheticLiquidity: false,
    });
  });

  it('an operator can read where each consumer stands; a user cannot', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await trade(a, seller, buyer);
    await t.pump(a);

    expect((await t.get(buyer, '/operator/trading/pipeline')).status).toBe(403);

    const operator = await seedSteppedUpSession(t.h);
    const response = await t.get(operator, '/operator/trading/pipeline');
    expect(response.status).toBe(200);
    const body = response.body as {
      settlement: Array<{ market: string; offset: string | null; halted: unknown }>;
      marketData: Array<{ market: string; offset: string | null; halted: unknown }>;
    };
    expect(body.settlement.find((s) => s.market === a.symbol)).toMatchObject({
      offset: '2:1',
      halted: null,
    });
    expect(body.marketData.find((s) => s.market === a.symbol)).toMatchObject({
      offset: '2:1',
      halted: null,
    });
  });
});

describe('telling a user their orders changed', () => {
  /** User ids announced while `work` runs. */
  async function announced(work: () => Promise<unknown>): Promise<string[]> {
    const heard: string[] = [];
    const off = userChanges.subscribe((ids) => heard.push(...ids));
    try {
      await work();
    } finally {
      off();
    }
    return heard;
  }

  it('is announced only after the commit: a transaction that rolls back tells nobody', async () => {
    const a = t.market();
    const who = await t.trader(a);
    const order = await t.buy(a, who);
    const transition = (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) =>
      createOrderRepository(tx).transition(
        { orderId: order.id, from: 'OPEN', to: 'PENDING_CANCEL', reason: 'test' },
        tx,
      );

    const rolledBack = await announced(async () => {
      await withTransaction(db, async (tx) => {
        expect(await transition(tx)).not.toBeNull();
        throw new Error('rolled back');
      }).catch(() => undefined);
    });
    // The write happened inside the transaction, and was undone with it.
    expect(rolledBack).toEqual([]);
    expect((await createOrderRepository(db).findById(order.id))?.status).toBe('OPEN');

    const heard: string[] = [];
    const off = userChanges.subscribe((ids) => heard.push(...ids));
    let heardInside: string[] = ['unset'];
    await withTransaction(db, async (tx) => {
      await transition(tx);
      // Written, and not yet committed: nobody has been told.
      heardInside = [...heard];
    });
    off();
    expect(heardInside).toEqual([]);
    expect(heard).toEqual([who.userId]);
  });

  it('every legal transition tells the order’s owner', async () => {
    const a = t.market();
    const who = await t.trader(a, { quote: 100_000_000_000n });
    const repository = createOrderRepository(db);
    const pairs = allOrderTransitions();
    expect(pairs.length).toBeGreaterThan(10);

    for (const { from, to } of pairs) {
      const order = await t.buy(a, who, { price: '140000000' });
      // Put the row where this transition starts. The transition itself — the
      // guarded update and its history row — is the code under test.
      await db.$executeRaw`UPDATE orders SET status = ${from}::"OrderStatus" WHERE id = ${order.id}::uuid`;
      const heard = await announced(() =>
        repository.transition({ orderId: order.id, from, to, reason: 'test' }),
      );
      expect(heard, `${from} -> ${to}`).toEqual([who.userId]);
    }
  });

  it('a settled fill tells both sides, and placing an order tells its owner', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    expect(await announced(() => t.sell(a, seller))).toContain(seller.userId);
    await t.buy(a, buyer);
    const heard = await announced(() => t.settle(a));
    expect(new Set(heard)).toEqual(new Set([seller.userId, buyer.userId]));
  });
});
