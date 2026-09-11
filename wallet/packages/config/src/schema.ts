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
