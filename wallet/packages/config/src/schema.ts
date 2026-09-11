import { z } from 'zod';

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
    SOLANA_NETWORK: z.enum(['localnet', 'devnet', 'testnet', 'mainnet-beta']).default('localnet'),
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

    /** ADR-0008: the asset allowlist. SOL only in Phase 2. */
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

    // --- Phase 3: risk policy (ADR-0010) ------------------------------------
    // Base units. Educational-project defaults, chosen so every rule is
    // reachable in testing rather than to model a real institution's appetite.
    RISK_PER_TRANSACTION_LIMIT: z.string().default('100000000000'), // 100 SOL
    RISK_DAILY_LIMIT: z.string().default('250000000000'), // 250 SOL
    RISK_VELOCITY_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
    RISK_VELOCITY_MAX_COUNT: z.coerce.number().int().positive().default(10),
    RISK_MANUAL_REVIEW_ABOVE: z.string().default('25000000000'), // 25 SOL
    RISK_NEW_DESTINATION_REVIEW: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    RISK_KNOWN_DESTINATION_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

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
