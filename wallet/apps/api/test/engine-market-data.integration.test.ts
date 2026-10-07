import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSettlementRepository } from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import { ledgerAssetKey } from '@wallet/types';
import { MARKET_DATA_CONSUMER } from '../src/services/market-data/tape-consumer.js';
import {
  createHttpEngineClient,
  engineKeyFromSeed,
  enginePublicKeyBase64,
  type EngineClient,
} from '../src/services/trading/engine-client.js';
import {
  browserHeaders,
  creditTrading,
  seedSession,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * The book the interface would render, against the REAL engine's book
 * (prompt_phase_s5.md rule 220, ADR-0036 §1).
 *
 * The fake engine derives its level changes by diffing its own book, so every
 * test built on it proves the fan-out applies level changes correctly — and
 * says nothing about whether the engine PUBLISHES them correctly. This one
 * drives the real binary through its real Redis stream with a generated order
 * flow, and after every command compares the fan-out's mirror at sequence `S`
 * with `GET /v1/book` at `S`.
 *
 * Requires the engine binary (`pnpm build:rust`) and Redis. Skipped when
 * either is missing: a skip is honest, a faked "engine" test is not.
 */
const BINARY = resolve(__dirname, '../../../services/matching/target/release/wallet-matching');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');
const QUOTE_SYMBOL = `QM${RUN}`;
const MARKET = `SOL-${QUOTE_SYMBOL}`;
const MARKET_ID = `${TEST_CLUSTER}:${MARKET}`;
const STREAM = `orders:events:${MARKET_ID}`;
const SOL = ledgerAssetKey(TEST_CLUSTER, NATIVE_ASSET);

let h: Harness;
let engineProcess: ChildProcess | undefined;
let engine: EngineClient;
let redis: Redis | undefined;
let dataDir: string | undefined;
let quote: string;
let available = false;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

const skip = (why: string): void => {
  // In CI a skip would be a green job that proved nothing. Fail instead.
  if (process.env.CI) throw new Error(`${why} — and CI must not skip the real-engine tests`);
  // eslint-disable-next-line no-console
  console.warn(`\n  ${why} — skipping the real-engine market-data test.\n`);
};

beforeAll(async () => {
  if (!existsSync(BINARY)) return skip(`no engine binary at ${BINARY} (run pnpm build:rust)`);
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.ping();
  } catch {
    return skip(`Redis not reachable at ${REDIS_URL}`);
  }

  const port = await freePort();
  const key = engineKeyFromSeed(randomBytes(32).toString('base64'));
  dataDir = mkdtempSync(join(tmpdir(), 'matching-md-'));
  engineProcess = spawn(BINARY, ['serve'], {
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '',
      MATCHING_DATA_DIR: dataDir,
      MATCHING_SNAPSHOT_EVERY_N: '10000',
      MATCHING_MARKET_ID: MARKET_ID,
      MATCHING_TICK_SIZE: '1000',
      MATCHING_LOT_SIZE: '1000000',
      MATCHING_MIN_NOTIONAL: '1000',
      MATCHING_COLLAR_BPS: '5000',
      MATCHING_MARKET_STATUS: 'open',
      MATCHING_LISTEN: `127.0.0.1:${String(port)}`,
      MATCHING_CALLER_PUBLIC_KEY: enginePublicKeyBase64(key),
      MATCHING_REDIS_URL: REDIS_URL,
    },
  });
  engine = createHttpEngineClient({
    market: MARKET,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    key,
    timeoutMs: 5_000,
  });
  for (let attempt = 0; attempt < 100 && !(await engine.health()); attempt += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await engine.health())) return skip('the engine did not come up');

  const { Keypair } = await import('@solana/web3.js');
  const mint = Keypair.generate().publicKey.toBase58();
  quote = ledgerAssetKey(TEST_CLUSTER, mint);
  const start = { [MARKET]: { seq: 0n, idx: 0 } };
  h = await startHarness({
    tokens: [
      {
        symbol: QUOTE_SYMBOL,
        mint,
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
      // No scripted sources anywhere: all three readers use the engine's own
      // Redis stream, each in its own way.
      settlement: { sources: new Map(), start },
      marketData: { tapeSources: new Map(), fanoutSources: new Map(), start },
    },
  });
  available = true;
}, 60_000);

afterAll(async () => {
  if (h) await h.cleanup();
  engineProcess?.kill();
  if (redis) {
    await redis.del(STREAM).catch(() => undefined);
    redis.disconnect();
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** A small deterministic generator: the flow is the same on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const level = (l: { price: bigint; qty: bigint }) => `${l.price.toString()}x${l.qty.toString()}`;

describe('the fan-out’s book against the real engine', () => {
  it('equals GET /v1/book at the same sequence after every command of a generated flow', async () => {
    if (!available) return;
    const fanout = h.app.trading!.fanouts.get(MARKET)!;
    const users = await Promise.all(
      [0, 1, 2].map(async () => {
        const session = await seedSession(h);
        await creditTrading(h, session.userId, quote, '100000000000');
        await creditTrading(h, session.userId, SOL, '100000000000');
        return { cookie: session.cookie, open: [] as string[] };
      }),
    );

    /** Run the fan-out until its mirror has reached the engine, then compare. */
    async function compare(step: string): Promise<void> {
      const target = (await engine.health())!.lastSeq;
      for (let attempt = 0; attempt < 10 && (fanout.book()?.seq ?? -1n) < target; attempt += 1) {
        await fanout.runOnce();
      }
      const mirror = fanout.book();
      const depth = (await engine.depth())!;
      expect(mirror, step).not.toBeNull();
      // Like with like: the same sequence on both sides.
      expect(mirror!.seq, step).toBe(depth.seq);
      expect(mirror!.bids.map(level), step).toEqual(depth.bids.map(level));
      expect(mirror!.asks.map(level), step).toEqual(depth.asks.map(level));
    }

    await fanout.runOnce(); // a snapshot of the empty book
    await compare('empty');

    const next = prng(20261007);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    let n = 0;
    let fills = 0;

    for (let step = 0; step < 70; step += 1) {
      const user = pick(users);
      const roll = next();
      let what: string;

      if (roll < 0.15 && user.open.length > 0) {
        const id = user.open.splice(Math.floor(next() * user.open.length), 1)[0]!;
        const response = await h.app.inject({
          method: 'DELETE',
          url: `/orders/${id}`,
          headers: browserHeaders(user.cookie),
        });
        what = `cancel -> ${String(response.statusCode)}`;
      } else if (roll < 0.25 && user.open.length > 0) {
        const index = Math.floor(next() * user.open.length);
        n += 1;
        const response = await h.app.inject({
          method: 'PATCH',
          url: `/orders/${user.open[index]!}`,
          headers: browserHeaders(user.cookie),
          payload: {
            clientOrderId: `emd-${RUN}-${String(n)}`,
            price: String(148_000_000 + Math.floor(next() * 5) * 1_000_000),
            qty: String((1 + Math.floor(next() * 5)) * 100_000_000),
          },
        });
        what = `amend -> ${String(response.statusCode)}`;
        if (response.statusCode === 200) {
          user.open[index] = (response.json() as { order: { id: string } }).order.id;
        } else {
          user.open.splice(index, 1);
        }
      } else {
        n += 1;
        const side = next() < 0.5 ? 'buy' : 'sell';
        const response = await h.app.inject({
          method: 'POST',
          url: '/orders',
          headers: browserHeaders(user.cookie),
          payload: {
            market: MARKET,
            side,
            type: 'limit',
            timeInForce: next() < 0.8 ? 'GTC' : 'IOC',
            // Five prices around 150, so orders cross, stack and miss.
            price: String(148_000_000 + Math.floor(next() * 5) * 1_000_000),
            qty: String((1 + Math.floor(next() * 5)) * 100_000_000),
            postOnly: false,
            clientOrderId: `emd-${RUN}-${String(n)}`,
          },
        });
        expect(response.statusCode, response.body).toBeLessThan(300);
        const order = (response.json() as { order: { id: string; status: string } }).order;
        what = `${side} -> ${order.status}`;
        if (order.status === 'OPEN') user.open.push(order.id);
      }
      await compare(`step ${String(step)}: ${what}`);
    }

    // The flow must actually have traded and moved the book, or the
    // comparison above was between two empty books seventy times.
    const tape = h.app.trading!.tapes.get(MARKET)!;
    const settlement = h.app.trading!.settlement.get(MARKET)!;
    const target = (await engine.health())!.lastSeq;
    const offsets = createSettlementRepository(h.app.appDeps.db);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await tape.runOnce();
      await settlement.runOnce();
      const recorded = await offsets.getOffset(MARKET_DATA_CONSUMER, MARKET_ID);
      const settled = await offsets.getOffset('settlement', MARKET_ID);
      if ((recorded?.seq ?? 0n) >= target && (settled?.seq ?? 0n) >= target) break;
    }
    expect(tape.status().halted, 'tape').toBeNull();
    expect(settlement.status().halted, 'settlement').toBeNull();

    const counted = await h.app.appDeps.db.$queryRaw<Array<{ trades: number; settled: number }>>`
      SELECT (SELECT COUNT(*)::int FROM trades WHERE market = ${MARKET_ID}) AS trades,
             (SELECT COUNT(*)::int FROM fills  WHERE market = ${MARKET_ID}) AS settled`;
    const { trades, settled } = counted[0]!;
    fills = trades;
    expect(fills).toBeGreaterThan(5);
    // Two consumers, two positions, one stream: the public tape and the
    // ledger recorded the same executions.
    expect(settled).toBe(trades);
    expect(
      (await engine.depth())!.bids.length + (await engine.depth())!.asks.length,
    ).toBeGreaterThan(0);
  }, 120_000);

  it('a stream deleted under the fan-out is noticed, and the book is rebuilt from a snapshot', async () => {
    if (!available) return;
    const fanout = h.app.trading!.fanouts.get(MARKET)!;
    const session = await seedSession(h);
    await creditTrading(h, session.userId, quote, '100000000000');
    const before = fanout.book()!.seq;

    await redis!.del(STREAM);
    const response = await h.app.inject({
      method: 'POST',
      url: '/orders',
      headers: browserHeaders(session.cookie),
      payload: {
        market: MARKET,
        side: 'buy',
        type: 'limit',
        timeInForce: 'GTC',
        price: '140000000',
        qty: '100000000',
        postOnly: false,
        clientOrderId: `emd-${RUN}-after-wipe`,
      },
    });
    expect(response.statusCode, response.body).toBeLessThan(300);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await fanout.runOnce();
      if ((fanout.book()?.seq ?? 0n) > before) break;
    }
    const mirror = fanout.book()!;
    const depth = (await engine.depth())!;
    expect(mirror.seq).toBe(depth.seq);
    expect(mirror.bids.map(level)).toEqual(depth.bids.map(level));
    expect(mirror.asks.map(level)).toEqual(depth.asks.map(level));
  }, 60_000);
});
