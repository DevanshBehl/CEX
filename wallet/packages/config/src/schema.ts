import { z } from 'zod';
import { clusterSchema, type Cluster } from '@wallet/types';
import { tokenAssetSchema } from '@wallet/types';

const nodeEnv = z.enum(['development', 'test', 'production']);
const logLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const port = z.coerce.number().int().min(1).max(65535);
const positiveSeconds = z.coerce.number().int().positive();
const httpUrl = z
  .string()
  .url()
  .refine((v) => !v.endsWith('/'), 'must not have a trailing slash');

/**
 * Secrets carry a minimum length rather than a format, so a placeholder copied
 * out of .env.example fails validation instead of booting a server with a
 * guessable key.
 */
const secret = (minLength: number) => z.string().min(minLength);

const assetLimitsSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z.string().superRefine((entry, ctx) => {
        const parts = entry.split(':');
        if (parts.length !== 4) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${entry}" must be ASSET:PER_TX:DAILY:REVIEW_ABOVE`,
          });
          return;
        }
        for (const [index, part] of parts.slice(1).entries()) {
          if (!/^\d+$/.test(part)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"${parts[0] ?? ''}" field ${String(index + 2)} must be base units`,
            });
          }
        }
      }),
    ),
  )
  .transform((entries) =>
    entries.map((entry) => {
      const [asset = '', perTx = '0', daily = '0', review = '0'] = entry.split(':');
      return {
        asset,
        perTransactionLimit: perTx,
        dailyLimit: daily,
        manualReviewAbove: review,
      };
    }),
  );

/**
 * `KEY=VALUE,KEY=VALUE`, used where a value may itself contain a colon — an
 * engine URL does — so the colon-separated list shape above cannot carry it.
 */
const keyValueList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(
    z.array(
      z.string().refine((entry) => {
        const at = entry.indexOf('=');
        return at > 0 && at < entry.length - 1;
      }, 'must be KEY=VALUE'),
    ),
  )
  .transform(
    (entries) =>
      Object.fromEntries(
        entries.map((entry) => {
          const at = entry.indexOf('=');
          return [entry.slice(0, at), entry.slice(at + 1)];
        }),
      ) as Record<string, string>,
  );

/** `SYMBOL:TICK:LOT:MIN_NOTIONAL:COLLAR_BPS` — a market (ADR-0027). */
const tradingMarketList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(
    z.array(
      z.string().superRefine((entry, ctx) => {
        const parts = entry.split(':');
        if (parts.length !== 5 || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(parts[0] ?? '')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${entry}" must be SYMBOL:TICK:LOT:MIN_NOTIONAL:COLLAR_BPS, e.g. SOL-USDC:1000:1000000:1000000:1000`,
          });
          return;
        }
        for (const part of parts.slice(1)) {
          if (!/^[1-9]\d*$/.test(part)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"${parts[0] ?? ''}" has a field that is not a positive integer`,
            });
          }
        }
      }),
    ),
  )
  .transform((entries) =>
    entries.map((entry) => {
      const [symbol = '', tickSize = '1', lotSize = '1', minNotional = '1', collar = '1'] =
        entry.split(':');
      return { symbol, tickSize, lotSize, minNotional, collarBps: Number(collar) };
    }),
  );

export const envSchema = z
  .object({
    NODE_ENV: nodeEnv.default('development'),
    LOG_LEVEL: logLevel.default('info'),

    DATABASE_URL: z.string().min(1).startsWith('postgres'),
    REDIS_URL: z.string().min(1).startsWith('redis'),

    API_PORT: port.default(4000),
    API_HOST: z.string().default('0.0.0.0'),
    WEB_ORIGIN: httpUrl,

    WEBAUTHN_RP_ID: z.string().min(1),
    WEBAUTHN_RP_NAME: z.string().min(1),
    WEBAUTHN_ORIGIN: httpUrl,

    SESSION_COOKIE_NAME: z.string().min(1).default('wallet_session'),
    SESSION_SECRET: secret(32),
    SESSION_IDLE_TTL_SECONDS: positiveSeconds.default(1800),
    SESSION_ABSOLUTE_TTL_SECONDS: positiveSeconds.default(86400),
    STEP_UP_MAX_AGE_SECONDS: positiveSeconds.default(300),

    /** base64-encoded 32 bytes; encrypts TOTP secrets at rest (rule 100). */
    TOTP_ENCRYPTION_KEY: secret(44),

    WEBAUTHN_CHALLENGE_TTL_SECONDS: positiveSeconds.default(120),

    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19456).default(65536),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(4),

    RATE_LIMIT_AUTH_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_AUTH_PER_ACCOUNT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    /**
     * Withdrawals get their own limit (master-prompt rule 162).
     *
     * Borrowing the auth limit was the first thing the integration suite tripped
     * over, and it was right to: the two endpoints are throttled for different
     * reasons. Auth limits exist to slow credential guessing; a withdrawal limit
     * exists to bound the damage of a compromised session, and the risk engine's
     * velocity rule is the real control there.
     */
    RATE_LIMIT_WITHDRAWAL_PER_MINUTE: z.coerce.number().int().positive().default(30),
    /**
     * A coarse ceiling across every endpoint.
     *
     * Was hardcoded at 300 until an end-to-end run tripped it: the suite drives
     * a real browser through two dozen journeys from one IP, `/auth/session` was
     * throttled, and the app correctly concluded the user was signed out. The
     * failures pointed at the pages, not at the limit.
     */
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(300),

    // --- Phase 2: chain and custody -----------------------------------------
    SOLANA_RPC_URL: z.string().url(),
    /**
     * The DEFAULT cluster: what a request that names no cluster gets, and
     * what `SOLANA_RPC_URL`, `TOKEN_MINTS` and `RISK_ASSET_LIMITS` describe.
     *
     * Kept under its old name so an existing single-cluster deployment is
     * unchanged by clusters existing.
     */
    SOLANA_NETWORK: clusterSchema.default('localnet'),
    /**
     * Every cluster this process serves, comma-separated (ADR-0021).
     *
     * Defaults to just `SOLANA_NETWORK`. Each additional cluster needs its own
     * RPC URL; its mints and risk limits fall back to the unsuffixed variables
     * only for the default cluster, because a devnet mint address is not a
     * mainnet mint address and inheriting one would allowlist the wrong token.
     */
    SOLANA_CLUSTERS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      )
      .pipe(z.array(clusterSchema)),

    // Per-cluster endpoints. `MAINNET_BETA` because a hyphen is not legal in
    // an environment variable name.
    SOLANA_RPC_URL_LOCALNET: z.string().url().or(z.literal('')).default(''),
    SOLANA_RPC_URL_DEVNET: z.string().url().or(z.literal('')).default(''),
    SOLANA_RPC_URL_TESTNET: z.string().url().or(z.literal('')).default(''),
    SOLANA_RPC_URL_MAINNET_BETA: z.string().url().or(z.literal('')).default(''),

    // Per-cluster allowlists. Same format as TOKEN_MINTS.
    TOKEN_MINTS_LOCALNET: tokenAssetSchema.default(''),
    TOKEN_MINTS_DEVNET: tokenAssetSchema.default(''),
    TOKEN_MINTS_TESTNET: tokenAssetSchema.default(''),
    TOKEN_MINTS_MAINNET_BETA: tokenAssetSchema.default(''),
    /**
     * ADR-0006. `finalized` is the only value that may be used to credit —
     * anything below it can be rolled back on a fork. Configurable so a test
     * harness can run against a local validator, and validated in superRefine
     * so a production deployment cannot weaken it.
     */
    SOLANA_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('finalized'),
    SOLANA_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    SOLANA_RPC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

    /**
     * Master seed for deposit-address derivation (ADR-0004), base64, >=32 bytes.
     *
     * Phase 2 derives ADDRESSES only and never signs, so no private key is
     * persisted anywhere. This value is nonetheless the most sensitive one in
     * the system — it can regenerate every deposit key — and Phase 4 moves it
     * behind the MPC boundary (ADR-0005).
     */
    DEPOSIT_SEED: z.string().min(44),

    /**
     * ADR-0016: the SPL mint allowlist, `SYMBOL:MINT:DECIMALS` comma-separated.
     *
     * Empty by default, so an existing deployment keeps behaving exactly as it
     * did before tokens existed. Adding a mint is a deliberate act.
     */
    TOKEN_MINTS: tokenAssetSchema.default(''),

    /** ADR-0008: the native asset allowlist. SOL only; mints live above. */
    SUPPORTED_ASSETS: z
      .string()
      .default('SOL')
      .transform((value) =>
        value
          .split(',')
          .map((asset) => asset.trim())
          .filter(Boolean),
      ),

    INDEXER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    INDEXER_PAGE_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    INDEXER_MAX_ADDRESSES_PER_CYCLE: z.coerce.number().int().positive().default(200),

    /** Reconciliation as a scheduled job (prompt_phase4.md rule 140). */
    RECONCILIATION_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /** Default 15 minutes: frequent enough to catch drift, cheap enough to run. */
    RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(900_000),
    /**
     * Consecutive drifting cycles before an alert (rule 144).
     *
     * Three, because a residual is the normal steady state whenever a deposit
     * is between detection and finality. One cycle would alert on every busy
     * minute; three means the drift outlived ~45 minutes of finality, which
     * timing cannot explain.
     */
    RECONCILIATION_ALERT_AFTER_CYCLES: z.coerce.number().int().min(1).default(3),

    // --- Phase S3: trading (ADR-0025, ADR-0032, ADR-0033) -------------------
    /**
     * Off by default, so a wallet deployment that has not configured an engine
     * or a clearing address is unaffected. When off, no trading route is
     * registered at all — refused by absence rather than by a check.
     */
    TRADING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /**
     * The house CLEARING address (ADR-0025 §2). Never the treasury: the
     * treasury's balance moves with every fee paid, and pooling them would make
     * the clearing reserve check unable to tell customer money from fee float.
     */
    CLEARING_ADDRESS: z.string().default(''),
    /** The signing key reference for the clearing address, created by DKG. */
    CLEARING_KEY_REF: z.string().min(1).default('house:clearing'),
    /** Markets on the DEFAULT cluster: SYMBOL:TICK:LOT:MIN_NOTIONAL:COLLAR_BPS. */
    TRADING_MARKETS: tradingMarketList,
    /** One engine per market (S1 rule 77): SYMBOL=URL,SYMBOL=URL. */
    TRADING_ENGINE_URLS: keyValueList,
    /**
     * The gateway's Ed25519 seed for signing engine requests (ADR-0031), base64
     * of 32 bytes. The ENGINE holds only the public half, which the API prints
     * at boot so it need not be derived by hand.
     *
     *   openssl rand -base64 32
     */
    TRADING_ENGINE_CALLER_SEED: z.string().default(''),
    TRADING_ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
    /**
     * MUST equal the engine's MATCHING_TOLERANCE_SECONDS (ADR-0031).
     *
     * It is what makes "the engine never saw this order" conclusive. A request
     * the gateway gave up on can still be queued inside the engine and applied
     * later — for as long as its signed timestamp stays inside this window.
     * Only after it does the engine refuse that request forever, so only then
     * may the sweeper release the hold of an order the engine reports unseen.
     */
    TRADING_ENGINE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
    /** Largest single order per market, base units: SYMBOL=QTY. Unlisted = refused. */
    TRADING_MAX_ORDER_QTY: keyValueList,
    /** Largest open notional per user per market, quote base units: SYMBOL=AMOUNT. */
    TRADING_MAX_OPEN_NOTIONAL: keyValueList,
    TRADING_MAX_OPEN_ORDERS: z.coerce.number().int().positive().default(50),
    TRADING_ORDER_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    TRADING_ORDER_RATE_MAX: z.coerce.number().int().positive().default(120),
    TRADING_SWEEPER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /** How long an order may sit in PENDING_ENGINE before the sweeper asks. */
    TRADING_SWEEPER_AFTER_MS: z.coerce.number().int().positive().default(5_000),
    TRADING_SWEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
    /**
     * After this many attempts an unresolved order is a dead letter, not a log
     * line. It must cover the engine tolerance: attempts x interval shorter
     * than TRADING_ENGINE_TOLERANCE_SECONDS dead-letters every stuck order
     * before "never seen" can ever be proven — so the API refuses that
     * combination at boot.
     */
    TRADING_SWEEPER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(500),

    // --- Phase S4: settlement (ADR-0034) and clearing reconciliation (ADR-0035) ---
    /**
     * Off by default. With trading on and settlement off, fills match and move
     * no money — S3's behaviour. Turning it on requires TRADING_SETTLEMENT_START
     * for every market that has no stored offset; the API refuses to boot
     * otherwise rather than guess where settlement begins.
     */
    TRADING_SETTLEMENT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /**
     * SYMBOL=SEQ:IDX — the last event key to treat as ALREADY applied, used
     * only when a market has no row in engine_offsets. `0:0` settles the whole
     * journal, including every S3-era fill (their holds are still held). Never
     * defaulted (ADR-0034 §5).
     */
    TRADING_SETTLEMENT_START: keyValueList,
    /** SYMBOL=STREAM, overriding the engine's default `orders:events:<market id>`. */
    TRADING_SETTLEMENT_STREAMS: keyValueList,
    /** This process's name in each stream's `settlement` consumer group. */
    TRADING_SETTLEMENT_CONSUMER: z.string().min(1).default('settlement-1'),
    TRADING_SETTLEMENT_BATCH_SIZE: z.coerce.number().int().positive().default(100),
    TRADING_SETTLEMENT_BLOCK_MS: z.coerce.number().int().positive().default(1_000),
    /**
     * Base units of the NATIVE asset the house parks at the clearing address
     * (rent, dust). Check 1 expects exactly this much more on-chain than the
     * ledger's clearing_assets (ADR-0035).
     */
    TRADING_CLEARING_RESERVE: z
      .string()
      .regex(/^\d+$/, 'must be a non-negative integer in base units')
      .default('0'),

    // --- Phase 3: risk policy (ADR-0010) ------------------------------------
    // Base units. Educational-project defaults, chosen so every rule is
    // reachable in testing rather than to model a real institution's appetite.
    RISK_PER_TRANSACTION_LIMIT: z.string().default('100000000000'), // 100 SOL
    RISK_DAILY_LIMIT: z.string().default('250000000000'), // 250 SOL
    RISK_VELOCITY_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
    RISK_VELOCITY_MAX_COUNT: z.coerce.number().int().positive().default(10),
    RISK_MANUAL_REVIEW_ABOVE: z.string().default('25000000000'), // 25 SOL
    /**
     * First-time destinations are reviewed only when this is on (ADR-0010).
     *
     * Off by default since ADR-0024: review is decided by value, so a small
     * withdrawal to a new address is approved automatically once every hard
     * check passes. Turn it back on for the stricter posture.
     */
    RISK_NEW_DESTINATION_REVIEW: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /**
     * Value-based review (ADR-0024), in whole US dollars as a decimal string.
     *
     * A withdrawal worth MORE than this, at the latest recorded price, goes to
     * an operator; everything else that passes the hard checks is approved by
     * code. An asset with no recent price is always reviewed. Replaces the
     * per-asset `REVIEW_ABOVE` base-unit thresholds when set; an empty value
     * restores them.
     */
    RISK_MANUAL_REVIEW_ABOVE_USD: z
      .string()
      .trim()
      .default('5000')
      .refine((v) => v === '' || /^\d+(\.\d{1,6})?$/.test(v), 'must be a dollar amount like 1000'),
    /**
     * How old a price may be and still value a withdrawal. Older than this and
     * the withdrawal is treated as unpriced, and reviewed.
     */
    RISK_PRICE_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(3600),
    RISK_KNOWN_DESTINATION_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

    /**
     * Per-asset withdrawal limits, `ASSET:PER_TX:DAILY:REVIEW_ABOVE`,
     * comma-separated (prompt_phase4.md rule 127, ADR-0016).
     *
     *   RISK_ASSET_LIMITS=EPjF...Dt1v:1000000000:5000000000:250000000
     *
     * `ASSET` is the ledger asset key — a mint address for a token. The native
     * asset's limits keep their own `RISK_*` variables, so an existing
     * deployment is unchanged.
     *
     * An allowlisted mint absent from this list is not withdrawable. That is
     * deliberate: the fallback would be a limit denominated in 10^9 units
     * applied to an asset denominated in 10^6.
     */
    RISK_ASSET_LIMITS: assetLimitsSchema,
    /**
     * The same, per cluster (ADR-0021).
     *
     * A mint address is not portable between clusters, so these do NOT inherit
     * from `RISK_ASSET_LIMITS` — inheriting would apply a mainnet USDC limit
     * to whatever mint happens to share that address on devnet. The default
     * cluster is the exception: its unsuffixed variables are its own.
     */
    RISK_ASSET_LIMITS_LOCALNET: assetLimitsSchema,
    RISK_ASSET_LIMITS_DEVNET: assetLimitsSchema,
    RISK_ASSET_LIMITS_TESTNET: assetLimitsSchema,
    RISK_ASSET_LIMITS_MAINNET_BETA: assetLimitsSchema,

    // --- Valuation (Task 3) -------------------------------------------------
    /**
     * Where spot prices come from.
     *
     * `coingecko` needs no credentials and covers SOL, USDC and USDT.
     * `pyth` needs an endpoint that actually serves price updates — the public
     * `hermes.pyth.network/v2/updates/price/latest` answers 401 — so it is for
     * a deployment with a key or a self-hosted Hermes.
     * `static` reads `PRICE_STATIC` and is for development with no internet.
     * `none` disables valuation: the dashboard shows balances and no dollars,
     * which is the honest state when nothing can price them.
     */
    PRICE_SOURCE: z.enum(['coingecko', 'pyth', 'static', 'none']).default('coingecko'),
    PRICE_ENDPOINT: z.string().url().or(z.literal('')).default(''),
    PRICE_API_KEY: z.string().default(''),
    /** How often to poll. Minutes, not seconds: free tiers rate-limit hard. */
    PRICE_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
    PRICE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    /**
     * `SYMBOL:IDENTIFIER` pairs, overriding the built-in mapping.
     *
     * The identifier is a CoinGecko coin id or a Pyth feed id depending on the
     * source. A symbol with no mapping is not priced — never guessed, because
     * guessing an id is how a balance gets valued at another token's price.
     */
    PRICE_FEEDS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    /** `SYMBOL:PRICE` pairs for `PRICE_SOURCE=static`. */
    PRICE_STATIC: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),

    // --- Phase 3: step-up tiering (ADR-0011) --------------------------------
    /** Freshness demanded for a withdrawal at or above the review threshold. */
    WITHDRAWAL_STEP_UP_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(60),

    // --- Phase 3: retry budgets (ADR-0012) ----------------------------------
    WITHDRAWAL_SIGN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    WITHDRAWAL_BROADCAST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    WITHDRAWAL_EXPIRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),

    // --- Phase 3: signing and treasury --------------------------------------
    /**
     * `mock` produces signatures that verify against nothing. The superRefine
     * below refuses it in production, and MockSigner itself refuses to
     * construct there — two independent guards, because this one matters.
     */
    /**
     * `mock` produces signatures that verify against nothing, and is refused in
     * production by the guard below AND by MockSigner itself (ADR-0013).
     * `real` speaks to `services/mpc`.
     */
    SIGNER_KIND: z.enum(['mock', 'real']).default('mock'),
    /**
     * Segregated custody (ADR-0020).
     *
     * True means every user's deposit address is their OWN 3-of-5 FROST group,
     * provisioned by the coordinator, and withdrawals are paid from it. False
     * means the omnibus model: addresses are derived from `DEPOSIT_SEED` and
     * withdrawals are paid from the treasury.
     *
     * Explicit rather than inferred from the signing service, because the two
     * models have different custody properties and a deployment must not
     * discover which one it got by looking at an address.
     */
    SEGREGATED_CUSTODY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    MPC_ENDPOINT: z.string().url().default('http://127.0.0.1:7070'),
    /**
     * The caller's Ed25519 private key, PEM, base64-encoded.
     *
     * The MPC service holds only the public half, so compromising the service
     * does not yield the ability to impersonate this caller.
     */
    MPC_CLIENT_PRIVATE_KEY: z.string().default(''),
    MPC_CALLER_NAME: z.string().default('wallet-api'),
    /**
     * The approval authority's Ed25519 private key (PEM, base64).
     *
     * Separate from MPC_CLIENT_PRIVATE_KEY on purpose: the caller key proves
     * who is asking, this one proves the request was approved. Compromising the
     * first lets an attacker ask; this is what stops asking from being enough
     * (ADR-0015).
     */
    MPC_APPROVAL_PRIVATE_KEY: z.string().default(''),
    MPC_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    SIGNER_KEY_REF: z.string().min(1).default('treasury-hot-1'),
    /**
     * The address withdrawals are paid from, and the nonce authority.
     *
     * A blank value is treated as absent rather than as a too-short string:
     * `FOO=` in a .env file means "not set", and rejecting it with a length
     * error would be a confusing way to say so.
     */
    TREASURY_ADDRESS: z
      .string()
      .transform((v) => (v.trim() === '' ? undefined : v.trim()))
      .refine((v) => v === undefined || (v.length >= 32 && v.length <= 44), {
        message: 'must be a base58 address of 32-44 characters, or empty',
      })
      .optional(),
    NONCE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(5),

    WITHDRAWAL_WORKERS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    WITHDRAWAL_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
    WITHDRAWAL_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),

    /** Comma-separated user ids permitted to use the operator queue. */
    OPERATOR_USER_IDS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  })
  // -------------------------------------------------------------------------
  // Cross-field invariants. These catch the misconfigurations that otherwise
  // surface as "WebAuthn just doesn't work" or "sessions never expire".
  // -------------------------------------------------------------------------
  .superRefine((env, ctx) => {
    if (env.SESSION_IDLE_TTL_SECONDS > env.SESSION_ABSOLUTE_TTL_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_IDLE_TTL_SECONDS'],
        message: 'must not exceed SESSION_ABSOLUTE_TTL_SECONDS',
      });
    }

    // prompt_phase1.md rules 112-113: rpId must be a registrable suffix of the
    // WebAuthn origin's host, or every ceremony fails verification.
    let originHost: string | undefined;
    try {
      originHost = new URL(env.WEBAUTHN_ORIGIN).hostname;
    } catch {
      /* the field-level url() check already reported this */
    }
    if (originHost !== undefined) {
      const rpId = env.WEBAUTHN_RP_ID;
      const matches = originHost === rpId || originHost.endsWith(`.${rpId}`);
      if (!matches) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBAUTHN_RP_ID'],
          message: `must equal the WEBAUTHN_ORIGIN host or be a registrable suffix of it (host is "${originHost}")`,
        });
      }
    }

    // ADR-0006: crediting below finality is a double-credit vector. A
    // non-production environment may loosen it to test against a validator
    // that does not finalize quickly; production may not.
    /*
     * Every cluster this process serves must have somewhere to talk to
     * (ADR-0021).
     *
     * Without the check the failure is a cluster that accepts requests,
     * resolves addresses, and then cannot read a balance or broadcast — which
     * looks like an outage rather than a missing line of configuration.
     */
    {
      const served = env.SOLANA_CLUSTERS.length > 0 ? env.SOLANA_CLUSTERS : [env.SOLANA_NETWORK];

      for (const cluster of served) {
        if (rpcUrlFor(env, cluster) === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [rpcUrlVariable(cluster)],
            message: `is required: SOLANA_CLUSTERS serves "${cluster}"`,
          });
        }
      }

      // The default cluster is what a request with no header gets. Serving
      // every cluster except that one would make the default unreachable.
      if (env.SOLANA_CLUSTERS.length > 0 && !served.includes(env.SOLANA_NETWORK)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SOLANA_CLUSTERS'],
          message: `must include SOLANA_NETWORK ("${env.SOLANA_NETWORK}"), which is the default cluster`,
        });
      }
    }

    // A source that cannot reach anything would poll forever and record
    // nothing, and the dashboard would show a portfolio worth $0 rather than
    // one that says it has no prices.
    if (env.PRICE_SOURCE === 'pyth' && env.PRICE_ENDPOINT.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PRICE_ENDPOINT'],
        message:
          'is required when PRICE_SOURCE is "pyth": the public Hermes price-update endpoint ' +
          'returns 401, so an authenticated or self-hosted one is needed',
      });
    }

    if (env.PRICE_SOURCE === 'static' && env.PRICE_STATIC.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PRICE_STATIC'],
        message: 'is required when PRICE_SOURCE is "static"',
      });
    }

    for (const [name, entries] of [
      ['PRICE_FEEDS', env.PRICE_FEEDS],
      ['PRICE_STATIC', env.PRICE_STATIC],
    ] as const) {
      for (const [index, entry] of entries.entries()) {
        if (!/^[^:]+:[^:]+$/.test(entry)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name, index],
            message: `"${entry}" must be SYMBOL:VALUE`,
          });
        }
      }
    }

    if (env.NODE_ENV === 'production' && env.SOLANA_COMMITMENT !== 'finalized') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SOLANA_COMMITMENT'],
        message: 'must be "finalized" in production (ADR-0006)',
      });
    }

    if (env.SUPPORTED_ASSETS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPPORTED_ASSETS'],
        message: 'must list at least one asset',
      });
    }

    /**
     * Cross-field checks only. Per-entry shape — base58, decimals, the three
     * fields — belongs to `tokenAssetSchema` and has already run.
     *
     * Zod runs an object-level `superRefine` even when a field's own schema
     * failed, handing it the PARTIALLY parsed value — here, an array of raw
     * strings rather than of `TokenAsset`. Reading `.mint` off those throws a
     * TypeError that replaces the real, useful validation message with a
     * stack trace. Hence the shape guard rather than `Array.isArray` alone.
     */
    const tokens = Array.isArray(env.TOKEN_MINTS)
      ? env.TOKEN_MINTS.filter(
          (token): token is (typeof env.TOKEN_MINTS)[number] =>
            typeof token === 'object' && token !== null && 'mint' in token && 'symbol' in token,
        )
      : [];

    {
      const seenMints = new Set<string>();
      const seenSymbols = new Set<string>();

      for (const [index, token] of tokens.entries()) {
        const path = ['TOKEN_MINTS', index] as const;

        // Two entries for one mint means two ledger asset keys for one asset,
        // which splits a user's balance in half without telling anyone.
        if (seenMints.has(token.mint)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'mint'],
            message: 'is listed more than once',
          });
        }
        seenMints.add(token.mint);

        // Symbols are display-only, but a duplicate makes the interface lie
        // about which asset a balance belongs to.
        const symbol = token.symbol.toUpperCase();
        if (seenSymbols.has(symbol)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'symbol'],
            message: 'is listed more than once',
          });
        }
        seenSymbols.add(symbol);

        // A mint calling itself SOL would collide with the native asset key in
        // the ledger — the exact confusion the allowlist exists to prevent.
        if (env.SUPPORTED_ASSETS.some((asset) => asset.toUpperCase() === symbol)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'symbol'],
            message: 'collides with a native asset symbol',
          });
        }
      }
    }

    // The mock signer produces signatures that verify against nothing. This is
    // the outer of two guards; MockSigner also refuses to construct in
    // production (prompt_phase3.md rules 125, 227).
    // A `real` signer with no client key cannot authenticate, so the service
    // would refuse every request — better to fail at boot than at first
    // withdrawal.
    if (env.SIGNER_KIND === 'real' && env.MPC_CLIENT_PRIVATE_KEY.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MPC_CLIENT_PRIVATE_KEY'],
        message: 'is required when SIGNER_KIND is "real"',
      });
    }

    if (env.NODE_ENV === 'production' && env.SIGNER_KIND === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SIGNER_KIND'],
        message:
          'must not be "mock" in production — it produces signatures that verify against nothing',
      });
    }

    for (const key of [
      'RISK_PER_TRANSACTION_LIMIT',
      'RISK_DAILY_LIMIT',
      'RISK_MANUAL_REVIEW_ABOVE',
    ] as const) {
      if (!/^\d+$/.test(env[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'must be a non-negative integer in base units, as a string',
        });
      }
    }

    if (env.TRADING_SETTLEMENT_ENABLED && !env.TRADING_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRADING_SETTLEMENT_ENABLED'],
        message: 'requires TRADING_ENABLED: there is nothing to settle without a gateway',
      });
    }

    // --- Trading (S3). Validated only when enabled, and then strictly. ---
    if (env.TRADING_ENABLED) {
      if (env.CLEARING_ADDRESS.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CLEARING_ADDRESS'],
          message: 'is required when TRADING_ENABLED is true',
        });
      } else if (env.CLEARING_ADDRESS.trim() === (env.TREASURY_ADDRESS ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CLEARING_ADDRESS'],
          message:
            'must not be the treasury: pooling them makes the clearing reserve check unable ' +
            'to tell customer money from fee float (ADR-0025)',
        });
      }
      if (env.TRADING_MARKETS.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRADING_MARKETS'],
          message: 'must name at least one market when TRADING_ENABLED is true',
        });
      }
      for (const market of env.TRADING_MARKETS) {
        if (env.TRADING_ENGINE_URLS[market.symbol] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TRADING_ENGINE_URLS'],
            message: `has no engine for ${market.symbol}: one engine serves one market`,
          });
        }
      }
      // ADR-0034 §9: tier volume is summed across markets, which is only
      // meaningful in ONE quote asset. A second quote asset needs a decision
      // about valuation, not a configuration change.
      // Guarded: this refinement runs even when a field failed its own parse.
      const markets = Array.isArray(env.TRADING_MARKETS) ? env.TRADING_MARKETS : [];
      const quotes = new Set(markets.map((m) => String(m.symbol).split('-')[1]));
      if (env.TRADING_SETTLEMENT_ENABLED && quotes.size > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRADING_MARKETS'],
          message:
            'must all share one quote asset while settlement is enabled: fee tiers sum ' +
            'quote volume across markets (ADR-0034 §9)',
        });
      }
      const known = new Set(markets.map((m) => m.symbol));
      const starts =
        typeof env.TRADING_SETTLEMENT_START === 'object' ? env.TRADING_SETTLEMENT_START : {};
      for (const [symbol, value] of Object.entries(starts)) {
        if (!known.has(symbol)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TRADING_SETTLEMENT_START'],
            message: `names ${symbol}, which is not in TRADING_MARKETS`,
          });
        } else if (!/^\d+:\d+$/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TRADING_SETTLEMENT_START'],
            message: `${symbol} must be SEQ:IDX, the last event key already applied`,
          });
        }
      }
      if (!/^[A-Za-z0-9+/]{43}=$/.test(env.TRADING_ENGINE_CALLER_SEED.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRADING_ENGINE_CALLER_SEED'],
          message: 'must be base64 of exactly 32 bytes when TRADING_ENABLED is true',
        });
      }
      for (const [name, map] of [
        ['TRADING_MAX_ORDER_QTY', env.TRADING_MAX_ORDER_QTY],
        ['TRADING_MAX_OPEN_NOTIONAL', env.TRADING_MAX_OPEN_NOTIONAL],
      ] as const) {
        for (const [symbol, value] of Object.entries(map)) {
          if (!/^[1-9]\d*$/.test(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [name],
              message: `${symbol} must be a positive integer in base units`,
            });
          }
        }
      }
    }

    if (env.NODE_ENV === 'production') {
      for (const key of ['WEB_ORIGIN', 'WEBAUTHN_ORIGIN'] as const) {
        if (!env[key].startsWith('https://')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'must be https in production (master-prompt rule 160)',
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * The environment variable naming a cluster's endpoint.
 *
 * `mainnet-beta` becomes `MAINNET_BETA`: a hyphen is not legal in an
 * environment variable name, and the mapping lives in one function so the
 * validator and the reader cannot disagree about it.
 */
export function clusterSuffix(cluster: Cluster): string {
  return cluster.toUpperCase().replace(/-/g, '_');
}

export function rpcUrlVariable(cluster: Cluster): string {
  return `SOLANA_RPC_URL_${clusterSuffix(cluster)}`;
}

/**
 * A cluster's RPC endpoint: its own variable, or the unsuffixed one when this
 * is the default cluster.
 */
export function rpcUrlFor(
  env: { readonly SOLANA_NETWORK: Cluster; readonly SOLANA_RPC_URL: string } & Record<
    string,
    unknown
  >,
  cluster: Cluster,
): string {
  const specific = env[rpcUrlVariable(cluster)];
  if (typeof specific === 'string' && specific.trim() !== '') return specific;
  return cluster === env.SOLANA_NETWORK ? env.SOLANA_RPC_URL : '';
}
