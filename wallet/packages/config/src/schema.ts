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
