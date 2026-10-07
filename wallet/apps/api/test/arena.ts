import { expect } from 'vitest';
import { createLedgerRepository } from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import { ledgerAssetKey } from '@wallet/types';
import type { ApiConfig } from '@wallet/config';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import {
  browserHeaders,
  creditTrading,
  seedSession,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';
import { createScriptedFanoutSource, type ScriptedFanoutSource } from './scripted-fanout-source.js';
import { createScriptedSource, type ScriptedSource } from './scripted-source.js';

/**
 * Markets for one suite, each with a fake engine that MATCHES and three
 * streams the test controls — one per reader of the engine's stream
 * (ADR-0036 §2): settlement, the trade tape, and the live fan-out.
 *
 * Every market has its own quote token, so nothing a case leaves behind —
 * fills, trades, candles, offsets, a halt — can reach another case, or another
 * run of the suite against the same database.
 */

export const SOL = ledgerAssetKey(TEST_CLUSTER, NATIVE_ASSET);
export const CLEARING_ADDRESS = 'So11111111111111111111111111111111111111112';

/** 150 quote per SOL, scaled (ADR-0026). */
export const PRICE = 150_000_000n;
export const ONE_SOL = 1_000_000_000n;
export const NOTIONAL = 150_000_000n;
export const TAKER_FEE = 300_000n;
export const MAKER_FEE = 150_000n;
export const FUNDS = { quote: 1_000_000_000n, base: 10_000_000_000n };

export interface Arena {
  readonly symbol: string;
  readonly marketId: string;
  readonly base: string;
  readonly quote: string;
  readonly engine: FakeEngine;
  readonly settlementSource: ScriptedSource;
  readonly tapeSource: ScriptedSource;
  readonly fanoutSource: ScriptedFanoutSource;
}

export interface Trader {
  readonly userId: string;
  readonly cookie: string;
  readonly cookieName: string;
  readonly sessionId: string;
}

export interface PlacedOrder {
  readonly id: string;
  readonly status: string;
  readonly holdAmount: string;
}

export interface Arenas {
  readonly h: Harness;
  readonly run: string;
  /** The next unused market. */
  market(): Arena;
  trader(a: Arena, funds?: { quote?: bigint; base?: bigint }): Promise<Trader>;
  place(a: Arena, who: Trader, body: Record<string, unknown>): Promise<PlacedOrder>;
  buy(a: Arena, who: Trader, body?: Record<string, unknown>): Promise<PlacedOrder>;
  sell(a: Arena, who: Trader, body?: Record<string, unknown>): Promise<PlacedOrder>;
  cancel(who: Trader, orderId: string): Promise<string>;
  /** Publish to settlement's stream and run its worker dry. */
  settle(a: Arena): Promise<number>;
  /** Publish to the tape's stream and run its consumer dry. */
  record(a: Arena): Promise<number>;
  /** Publish to the fan-out's stream and run it until it has read everything. */
  fan(a: Arena): Promise<void>;
  /** All three. */
  pump(a: Arena): Promise<void>;
  balance(userId: string, asset: string): Promise<{ available: bigint; locked: bigint }>;
  get(who: { readonly cookie: string }, url: string): Promise<{ status: number; body: unknown }>;
}

export async function createArenas(options: {
  readonly count: number;
  readonly bookMaxLevels?: number;
  readonly socket?: Partial<ApiConfig['trading']['socket']>;
}): Promise<Arenas> {
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const { Keypair } = await import('@solana/web3.js');
  const tokens: Array<{ symbol: string; mint: string; decimals: number }> = [];
  const arenas: Arena[] = [];

  for (let i = 0; i < options.count; i += 1) {
    const quoteSymbol = `M${run}N${String(i)}`;
    const mint = Keypair.generate().publicKey.toBase58();
    tokens.push({ symbol: quoteSymbol, mint, decimals: 6 });
    const symbol = `SOL-${quoteSymbol}`;
    const marketId = `${TEST_CLUSTER}:${symbol}`;
    const engine = createFakeEngine({
      market: symbol,
      marketId,
      tickSize: 1_000n,
      lotSize: 1_000_000n,
      minNotional: 1_000n,
      collarBps: 5_000,
    });
    engine.behaviour = 'match';
    arenas.push({
      symbol,
      marketId,
      base: SOL,
      quote: ledgerAssetKey(TEST_CLUSTER, mint),
      engine,
      settlementSource: createScriptedSource(engine),
      tapeSource: createScriptedSource(engine),
      fanoutSource: createScriptedFanoutSource(engine),
    });
  }

  const start = Object.fromEntries(arenas.map((a) => [a.symbol, { seq: 0n, idx: 0 }]));
  const h = await startHarness({
    tokens: tokens.map((t) => ({
      ...t,
      perTransactionLimit: '1000000000000000',
      dailyLimit: '1000000000000000',
      manualReviewAbove: '1000000000000000',
    })),
    trading: {
      engines: new Map(arenas.map((a) => [a.symbol, a.engine])),
      clearingAddress: CLEARING_ADDRESS,
      markets: arenas.map((a) => ({
        symbol: a.symbol,
        tickSize: '1000',
        lotSize: '1000000',
        minNotional: '1000',
        collarBps: 5_000,
      })),
      settlement: { sources: new Map(arenas.map((a) => [a.symbol, a.settlementSource])), start },
      marketData: {
        tapeSources: new Map(arenas.map((a) => [a.symbol, a.tapeSource])),
        fanoutSources: new Map(arenas.map((a) => [a.symbol, a.fanoutSource])),
        start,
        ...(options.bookMaxLevels === undefined ? {} : { bookMaxLevels: options.bookMaxLevels }),
        ...(options.socket === undefined ? {} : { socket: options.socket }),
      },
    },
  });

  let next = 0;
  let n = 0;

  const api: Arenas = {
    h,
    run,

    market() {
      const arena = arenas[next];
      next += 1;
      if (!arena) throw new Error('raise the arena count: every market is taken');
      return arena;
    },

    async trader(a, funds = {}) {
      const session = await seedSession(h);
      await creditTrading(h, session.userId, a.quote, (funds.quote ?? FUNDS.quote).toString());
      await creditTrading(h, session.userId, a.base, (funds.base ?? FUNDS.base).toString());
      return session;
    },

    async place(a, who, body) {
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
          clientOrderId: `md-${run}-${String(n)}`,
          ...body,
        },
      });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return (response.json() as { order: PlacedOrder }).order;
    },

    buy: (a, who, body = {}) => api.place(a, who, { side: 'buy', ...body }),
    sell: (a, who, body = {}) => api.place(a, who, { side: 'sell', ...body }),

    async cancel(who, orderId) {
      const response = await h.app.inject({
        method: 'DELETE',
        url: `/orders/${orderId}`,
        headers: browserHeaders(who.cookie),
      });
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { order: { status: string } }).order.status;
    },

    async settle(a) {
      await a.settlementSource.publish();
      const worker = h.app.trading!.settlement.get(a.symbol)!;
      let applied = 0;
      for (;;) {
        const count = await worker.runOnce();
        applied += count;
        if (count === 0) return applied;
      }
    },

    async record(a) {
      await a.tapeSource.publish();
      const tape = h.app.trading!.tapes.get(a.symbol)!;
      let applied = 0;
      for (;;) {
        const count = await tape.runOnce();
        applied += count;
        if (count === 0) return applied;
      }
    },

    async fan(a) {
      await a.fanoutSource.publish();
      const fanout = h.app.trading!.fanouts.get(a.symbol)!;
      // Once to take a snapshot if it has none, then until the stream is read.
      await fanout.runOnce();
      while (a.fanoutSource.unread() > 0) await fanout.runOnce();
    },

    async pump(a) {
      await api.settle(a);
      await api.record(a);
      await api.fan(a);
    },

    async balance(userId, asset) {
      const rows = await createLedgerRepository(h.app.appDeps.db).getUserTradingBalances(
        userId,
        TEST_CLUSTER,
      );
      const row = rows.find((r) => r.asset === asset);
      return { available: BigInt(row?.available ?? '0'), locked: BigInt(row?.locked ?? '0') };
    },

    async get(who, url) {
      const response = await h.app.inject({
        method: 'GET',
        url,
        headers: browserHeaders(who.cookie),
      });
      return { status: response.statusCode, body: response.json() as unknown };
    },
  };
  return api;
}
