import { readProcessEnv, type RawEnv } from './env.js';
import { envSchema, type Env } from './schema.js';
import { ConfigValidationError, type ConfigIssue } from './errors.js';

export { ConfigValidationError, type ConfigIssue } from './errors.js';
export type { Env } from './schema.js';

// ---------------------------------------------------------------------------
// Shapes, split by surface (prompt_phase1.md rule 63).
// ---------------------------------------------------------------------------

export interface SharedConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly logLevel: Env['LOG_LEVEL'];
}

export interface ApiConfig {
  readonly shared: SharedConfig;
  readonly http: { readonly port: number; readonly host: string; readonly webOrigin: string };
  readonly database: { readonly url: string };
  readonly redis: { readonly url: string };
  readonly webauthn: {
    readonly rpId: string;
    readonly rpName: string;
    readonly origin: string;
    readonly challengeTtlSeconds: number;
  };
  readonly session: {
    readonly cookieName: string;
    readonly secret: string;
    readonly idleTtlSeconds: number;
    readonly absoluteTtlSeconds: number;
    readonly stepUpMaxAgeSeconds: number;
  };
  readonly crypto: {
    readonly totpEncryptionKey: string;
    readonly argon2: {
      readonly memoryCostKib: number;
      readonly timeCost: number;
      readonly parallelism: number;
    };
  };
  readonly rateLimit: {
    readonly authPerIpPerMinute: number;
    readonly authPerAccountPerMinute: number;
  };
}

/**
 * Everything here is shipped to the browser. Adding a secret to this object is
 * a security incident, not a bug (prompt_phase1.md rule 64).
 */
export interface PublicConfig {
  readonly environment: Env['NODE_ENV'];
  readonly appName: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Pure and testable: no process access, no exit. Throws ConfigValidationError. */
export function parseEnv(raw: RawEnv): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
    variable: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    problem:
      issue.code === 'invalid_type' && issue.received === 'undefined'
        ? 'is required but was not set'
        : issue.message,
  }));
  throw new ConfigValidationError(issues);
}

export function toApiConfig(env: Env): ApiConfig {
  return Object.freeze({
    shared: Object.freeze({
      nodeEnv: env.NODE_ENV,
      isProduction: env.NODE_ENV === 'production',
      isTest: env.NODE_ENV === 'test',
      logLevel: env.LOG_LEVEL,
    }),
    http: Object.freeze({
      port: env.API_PORT,
      host: env.API_HOST,
      webOrigin: env.WEB_ORIGIN,
    }),
    database: Object.freeze({ url: env.DATABASE_URL }),
    redis: Object.freeze({ url: env.REDIS_URL }),
    webauthn: Object.freeze({
      rpId: env.WEBAUTHN_RP_ID,
      rpName: env.WEBAUTHN_RP_NAME,
      origin: env.WEBAUTHN_ORIGIN,
      challengeTtlSeconds: env.WEBAUTHN_CHALLENGE_TTL_SECONDS,
    }),
    session: Object.freeze({
      cookieName: env.SESSION_COOKIE_NAME,
      secret: env.SESSION_SECRET,
      idleTtlSeconds: env.SESSION_IDLE_TTL_SECONDS,
      absoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
      stepUpMaxAgeSeconds: env.STEP_UP_MAX_AGE_SECONDS,
    }),
    crypto: Object.freeze({
      totpEncryptionKey: env.TOTP_ENCRYPTION_KEY,
      argon2: Object.freeze({
        memoryCostKib: env.ARGON2_MEMORY_KIB,
        timeCost: env.ARGON2_TIME_COST,
        parallelism: env.ARGON2_PARALLELISM,
      }),
    }),
    rateLimit: Object.freeze({
      authPerIpPerMinute: env.RATE_LIMIT_AUTH_PER_IP_PER_MINUTE,
      authPerAccountPerMinute: env.RATE_LIMIT_AUTH_PER_ACCOUNT_PER_MINUTE,
    }),
  });
}

export function toPublicConfig(env: Env): PublicConfig {
  return Object.freeze({ environment: env.NODE_ENV, appName: 'Wallet' });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let cached: ApiConfig | undefined;

/**
 * Call this as the first statement of a process entrypoint. On failure it
 * prints the offending variable names and exits non-zero immediately, before
 * any port is bound or any connection opened (rules 59-61).
 *
 * It is a function rather than a module-level constant so that unit tests can
 * exercise `parseEnv` without a real environment, and so that importing any
 * package that transitively depends on config does not kill the test runner.
 */
export function loadApiConfigOrExit(raw: RawEnv = readProcessEnv()): ApiConfig {
  if (cached) return cached;
  try {
    cached = toApiConfig(parseEnv(raw));
    return cached;
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(error.report());
      process.exit(1);
    }
    throw error;
  }
}

/** Test-only escape hatch; never call from application code. */
export function __resetConfigCache(): void {
  cached = undefined;
}
