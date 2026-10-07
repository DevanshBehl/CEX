import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The trading stack the end-to-end suite runs against: one market, on a real
 * matching engine, unique to this run.
 *
 * UNIQUE PER RUN, because the database outlives the run and the engine's
 * journal does not. A market that kept its name would find `engine_offsets`
 * ahead of a fresh engine's sequence 1, and settlement would skip every event
 * as already applied. A new quote token gives a new market id, a new stream
 * and a new offset.
 *
 * Playwright evaluates its config once in the main process and again in every
 * worker. Each value is therefore written to the environment the FIRST time
 * and read from it afterwards, so the worker that runs the spec sees the
 * market the servers were started with.
 */

const once = (name: string, make: () => string): string => {
  process.env[name] ??= make();
  return process.env[name];
};

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The Ed25519 public key for a 32-byte seed, as the engine wants it. */
function publicKeyOf(seedBase64: string): string {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seedBase64, 'base64'),
  ]);
  const jwk = createPublicKey(
    createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  ).export({
    format: 'jwk',
  });
  return Buffer.from(jwk.x!, 'base64url').toString('base64');
}

const run = once('E2E_TRADING_RUN', () => randomBytes(4).toString('hex').toUpperCase());
const quoteSymbol = `E${run}`;
const quoteMint = once('E2E_TRADING_MINT', () => base58(randomBytes(32)));
const callerSeed = once('E2E_TRADING_SEED', () => randomBytes(32).toString('base64'));
const dataDir = once('E2E_TRADING_DATA', () => mkdtempSync(join(tmpdir(), 'matching-e2e-')));
const cluster = process.env.SOLANA_NETWORK ?? 'localnet';
const symbol = `SOL-${quoteSymbol}`;
const enginePort = 18_480;

/** Built by `pnpm build:rust`. Without it there is no engine, and no journey. */
const binary = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../services/matching/target/release/wallet-matching',
);

const RULES = { tick: '10000', lot: '1000000', minNotional: '1000000', collarBps: '5000' };

export const trading = {
  available: existsSync(binary),
  binary,
  symbol,
  quoteSymbol,
  quoteMint,
  enginePort,

  /** The engine process: one market, open, publishing to the suite's Redis. */
  engineEnv: {
    PATH: process.env.PATH ?? '',
    MATCHING_DATA_DIR: dataDir,
    MATCHING_SNAPSHOT_EVERY_N: '10000',
    MATCHING_MARKET_ID: `${cluster}:${symbol}`,
    MATCHING_TICK_SIZE: RULES.tick,
    MATCHING_LOT_SIZE: RULES.lot,
    MATCHING_MIN_NOTIONAL: RULES.minNotional,
    MATCHING_COLLAR_BPS: RULES.collarBps,
    MATCHING_MARKET_STATUS: 'open',
    MATCHING_LISTEN: `127.0.0.1:${String(enginePort)}`,
    MATCHING_CALLER_PUBLIC_KEY: publicKeyOf(callerSeed),
    MATCHING_REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380',
  },

  /**
   * What the API needs to trade that market, settle it and show it.
   *
   * `SIGNER_KIND=mock`, as the rest of this suite: the journey is about the
   * trading screen, and no test here moves a coin on a chain.
   */
  apiEnv: {
    SIGNER_KIND: 'mock',
    SIGNER_KEY_REF: 'e2e-treasury',
    SEGREGATED_CUSTODY: 'false',
    INDEXER_ENABLED: 'false',
    WITHDRAWAL_WORKERS_ENABLED: 'false',
    RECONCILIATION_ENABLED: 'false',
    PRICE_SOURCE: 'none',
    TOKEN_MINTS: `${quoteSymbol}:${quoteMint}:6`,
    TOKEN_MINTS_LOCALNET: '',
    RISK_ASSET_LIMITS: `${quoteMint}:1000000000000:1000000000000:1000000000000`,
    RISK_ASSET_LIMITS_LOCALNET: '',
    TRADING_ENABLED: 'true',
    CLEARING_ADDRESS: 'So11111111111111111111111111111111111111112',
    TRADING_MARKETS: `${symbol}:${RULES.tick}:${RULES.lot}:${RULES.minNotional}:${RULES.collarBps}`,
    TRADING_ENGINE_URLS: `${symbol}=http://127.0.0.1:${String(enginePort)}`,
    TRADING_ENGINE_CALLER_SEED: callerSeed,
    TRADING_MAX_ORDER_QTY: `${symbol}=1000000000000`,
    TRADING_MAX_OPEN_NOTIONAL: `${symbol}=1000000000000`,
    TRADING_SETTLEMENT_ENABLED: 'true',
    TRADING_SETTLEMENT_START: `${symbol}=0:0`,
    TRADING_SETTLEMENT_STREAMS: '',
    TRADING_MARKET_DATA_ENABLED: 'true',
    TRADING_MARKET_DATA_START: `${symbol}=0:0`,
    TRADING_MARKET_MAKER_ENABLED: 'false',
    // A second stays plenty for a person, and lets a test watch a socket's
    // session end without waiting half a minute.
    WS_SESSION_RECHECK_SECONDS: '2',
  } satisfies Record<string, string>,
} as const;
