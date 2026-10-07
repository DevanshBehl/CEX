import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChainReader } from '@wallet/blockchain';
import {
  createLedgerRepository,
  createOrderRepository,
  createSettlementRepository,
} from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import { ledgerAssetKey } from '@wallet/types';
import { createClearingReconciliationService } from '../src/services/clearing-reconciliation.service.js';
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
 * Settlement end to end against the REAL matching engine and a REAL Redis
 * stream (prompt_phase_s4.md rule 122).
 *
 * Every other settlement test uses a fake engine and a scripted stream,
 * because exactly-once and halting are properties of ordering and need a
 * transport a test can break on purpose. This one exists to prove the real
 * pieces are wired to each other: that the engine's `XADD` carries the `idx`
 * settlement keys by, that its JSON survives the strict decoder, that a
 * deleted stream is recovered through its `GET /v1/events`, and that its
 * `GET /v1/book` is what check 3 compares against.
 *
 * What it does NOT cover: the chain. Trading balances are credited in the
 * ledger rather than allocated through a validator, so check 1 runs against a
 * reader that agrees with the ledger.
 *
 * Requires the engine binary (`pnpm build:rust`) and Redis. Skipped when
 * either is missing: a skip is honest, a faked "engine" test is not.
 */
const BINARY = resolve(__dirname, '../../../services/matching/target/release/wallet-matching');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');
const QUOTE_SYMBOL = `QE${RUN}`;
const MARKET = `SOL-${QUOTE_SYMBOL}`;
const MARKET_ID = `${TEST_CLUSTER}:${MARKET}`;
const STREAM = `orders:events:${MARKET_ID}`;
const SOL = ledgerAssetKey(TEST_CLUSTER, NATIVE_ASSET);
const CLEARING_ADDRESS = 'So11111111111111111111111111111111111111112';

const PRICE = 150_000_000n;
const ONE_SOL = 1_000_000_000n;
const NOTIONAL = 150_000_000n;
const TAKER_FEE = 300_000n;
const MAKER_FEE = 150_000n;
const FUNDS = { quote: 1_000_000_000n, base: 10_000_000_000n };

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
  // eslint-disable-next-line no-console
  console.warn(`\n  ${why} — skipping the real-engine settlement test.\n`);
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
  dataDir = mkdtempSync(join(tmpdir(), 'matching-e2e-'));
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
      clearingAddress: CLEARING_ADDRESS,
      markets: [
        {
          symbol: MARKET,
          tickSize: '1000',
          lotSize: '1000000',
          minNotional: '1000',
          collarBps: 5_000,
        },
      ],
      // No scripted source: the server reads the engine's own Redis stream.
      settlement: { sources: new Map(), start: { [MARKET]: { seq: 0n, idx: 0 } } },
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

// --- helpers ---------------------------------------------------------------

async function trader() {
  const session = await seedSession(h);
  await creditTrading(h, session.userId, quote, FUNDS.quote.toString());
  await creditTrading(h, session.userId, SOL, FUNDS.base.toString());
  return { userId: session.userId, cookie: session.cookie };
}

let n = 0;
async function place(cookie: string, side: 'buy' | 'sell', body: Record<string, unknown> = {}) {
  n += 1;
  const response = await h.app.inject({
    method: 'POST',
    url: '/orders',
    headers: browserHeaders(cookie),
    payload: {
      market: MARKET,
      side,
      type: 'limit',
      timeInForce: 'GTC',
      price: PRICE.toString(),
      qty: ONE_SOL.toString(),
      postOnly: false,
      clientOrderId: `e2e-${RUN}-${String(n)}`,
      ...body,
    },
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return (response.json() as { order: { id: string; status: string } }).order;
}

const offset = () =>
  createSettlementRepository(h.app.appDeps.db).getOffset('settlement', MARKET_ID);

/** Run the server's own worker until it has applied everything the engine journaled. */
async function settle(): Promise<void> {
  const worker = h.app.trading!.settlement.get(MARKET)!;
  const target = (await engine.health())!.lastSeq;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await worker.runOnce();
    expect(worker.status().halted).toBeNull();
    if (((await offset())?.seq ?? 0n) >= target) return;
  }
  throw new Error(`settlement did not reach sequence ${target.toString()}`);
}

async function balance(userId: string, asset: string) {
  const rows = await createLedgerRepository(h.app.appDeps.db).getUserTradingBalances(
    userId,
    TEST_CLUSTER,
  );
  const row = rows.find((r) => r.asset === asset);
  return { available: BigInt(row?.available ?? '0'), locked: BigInt(row?.locked ?? '0') };
}

const fills = () => h.app.appDeps.db.$queryRaw<
  Array<{ fill_id: string; seq: bigint; idx: number }>
>`
  SELECT fill_id, seq, idx FROM fills WHERE market = ${MARKET_ID} ORDER BY seq, idx`;

// ---------------------------------------------------------------------------

describe('settlement against the real engine and its Redis stream', () => {
  it('a maker and a crossing taker settle from the stream the engine published', async () => {
    if (!available) return;
    const seller = await trader();
    const buyer = await trader();
    const maker = await place(seller.cookie, 'sell');
    const taker = await place(buyer.cookie, 'buy');

    // What settlement keys by is on the wire: every entry carries `idx`.
    const entries = await redis!.xrange(STREAM, '-', '+');
    expect(entries).toHaveLength(3);
    expect(entries.map(([, fields]) => fields[fields.indexOf('idx') + 1])).toEqual(['0', '0', '1']);

    await settle();
    // Read from the stream, not fetched from the engine behind its back.
    expect(h.logs.entries().some((entry) => entry.event === 'settlement.recovered')).toBe(false);

    expect(await fills()).toEqual([{ fill_id: `${MARKET_ID}:2:0`, seq: 2n, idx: 0 }]);
    expect(await offset()).toEqual({ seq: 2n, idx: 1 });
    expect(await balance(buyer.userId, quote)).toEqual({
      available: FUNDS.quote - NOTIONAL - TAKER_FEE,
      locked: 0n,
    });
    expect((await balance(buyer.userId, SOL)).available).toBe(FUNDS.base + ONE_SOL);
    expect(await balance(seller.userId, SOL)).toEqual({
      available: FUNDS.base - ONE_SOL,
      locked: 0n,
    });
    expect((await balance(seller.userId, quote)).available).toBe(
      FUNDS.quote + NOTIONAL - MAKER_FEE,
    );

    const orders = createOrderRepository(h.app.appDeps.db);
    expect((await orders.findById(maker.id))?.status).toBe('FILLED');
    expect((await orders.findById(taker.id))?.status).toBe('FILLED');

    // The stream entries were acknowledged only after their commits.
    const pending = (await redis!.xpending(STREAM, 'settlement')) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });

  it('a deleted stream is recovered through the engine’s own re-emission', async () => {
    if (!available) return;
    const seller = await trader();
    const buyer = await trader();
    await place(seller.cookie, 'sell');
    await place(buyer.cookie, 'buy');
    // Everything the engine published since the last settlement is gone, and
    // the consumer group with it.
    await redis!.del(STREAM);

    await settle();
    expect((await fills()).map((fill) => fill.fill_id)).toEqual([
      `${MARKET_ID}:2:0`,
      `${MARKET_ID}:4:0`,
    ]);
    expect((await balance(buyer.userId, SOL)).available).toBe(FUNDS.base + ONE_SOL);
    expect(
      h.logs
        .entries()
        .some((entry) => entry.event === 'settlement.recovered' && entry.targetId === MARKET),
    ).toBe(true);
  });

  it('the fee account and all three reconciliation checks agree with what was traded', async () => {
    if (!available) return;
    const seller = await trader();
    // Leave something resting, and cancel something else, so the book has a
    // level to compare and the gateway and the worker both saw a `Cancelled`.
    const resting = await place(seller.cookie, 'sell', { price: '160000000' });
    const cancelled = await place(seller.cookie, 'sell', { price: '170000000' });
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/orders/${cancelled.id}`,
      headers: browserHeaders(seller.cookie),
    });
    expect((response.json() as { order: { status: string } }).order.status).toBe('CANCELLED');
    await settle();

    const ledger = createLedgerRepository(h.app.appDeps.db);
    const totals = new Map(
      (await ledger.getClearingTotals(TEST_CLUSTER)).map((row) => [row.asset, row]),
    );
    const report = await createClearingReconciliationService({
      db: h.app.appDeps.db,
      // The chain is not part of this test: it agrees with the ledger.
      reader: {
        getBalance: async (_address: string, asset: string) =>
          totals.get(asset)?.clearingAssets ?? '0',
      } as unknown as ChainReader,
      cluster: TEST_CLUSTER,
      clearingAddress: CLEARING_ADDRESS,
      nativeAsset: SOL,
      reserve: 0n,
      markets: [h.app.trading!.markets.get(MARKET)!],
      consumer: 'settlement',
    }).run();

    const finding = (check: string, subject: string) =>
      report.findings.find((f) => f.check === check && f.subject === subject);
    // Two fills so far, each charging both sides.
    expect(finding('equation', quote)).toMatchObject({
      status: 'clean',
      detail: { houseTradingFees: (2n * (TAKER_FEE + MAKER_FEE)).toString(), unexplained: '0' },
    });
    expect(finding('reserve', quote)?.status).toBe('clean');
    // The engine's real book, at the sequence settlement has reached.
    expect(finding('book', MARKET)).toMatchObject({
      status: 'clean',
      detail: { levelsOnlyInEngine: '0', levelsOnlyInDatabase: '0', levelsDiffering: '0' },
    });
    expect((await engine.depth())?.asks).toEqual([{ price: 160_000_000n, qty: ONE_SOL }]);
    expect((await createOrderRepository(h.app.appDeps.db).findById(resting.id))?.status).toBe(
      'OPEN',
    );
    expect((await balance(seller.userId, SOL)).locked).toBe(ONE_SOL);
  });
});
