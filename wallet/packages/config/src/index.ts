import {
  createAssetRegistry,
  ledgerAssetKey,
  NATIVE_ASSET_KEY,
  type AssetRegistry,
  type Cluster,
} from '@wallet/types';
import {
  CRITICAL_SECRETS,
  resolveSecret,
  SecretResolutionError,
  type SecretAudit,
} from './secrets.js';

/**
 * Display fallback for the native asset. Config must not import a chain
 * package, so this is stated rather than imported from `packages/solana`
 * (where `NATIVE_DECIMALS` is the same value). It is metadata; nothing
 * computes with it.
 */
const NATIVE_ASSET_DECIMALS = 9;
import { readProcessEnv, type RawEnv } from './env.js';
import { clusterSuffix, envSchema, rpcUrlFor, type Env } from './schema.js';
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

/** One cluster's chain configuration (ADR-0021). */
export interface ClusterChainConfig {
  readonly cluster: Cluster;
  readonly rpcUrl: string;
  /**
   * The allowlist for THIS cluster. Its keys are cluster-qualified, so the
   * same mint address configured on two clusters yields two distinct assets.
   */
  readonly assets: AssetRegistry;
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
    readonly withdrawalPerMinute: number;
    readonly globalPerMinute: number;
  };
  readonly chain: {
    /**
     * The default cluster's endpoint. Equivalent to
     * `byCluster[defaultCluster].rpcUrl`, kept because a single-cluster
     * deployment is still the common case.
     */
    readonly rpcUrl: string;
    readonly network: Env['SOLANA_NETWORK'];
    /** Every cluster this process serves (ADR-0021). */
    readonly clusters: readonly Cluster[];
    /** What a request naming no cluster resolves to. */
    readonly defaultCluster: Cluster;
    /**
     * Per-cluster endpoint and allowlist.
     *
     * Partial: only the served clusters have an entry, so asking for one this
     * deployment does not serve is `undefined` rather than a silently empty
     * registry that would allowlist nothing and look like a chain outage.
     */
    readonly byCluster: Readonly<Partial<Record<Cluster, ClusterChainConfig>>>;
    readonly commitment: Env['SOLANA_COMMITMENT'];
    readonly rpcTimeoutMs: number;
    readonly rpcMaxRetries: number;
    readonly depositSeed: string;
    readonly supportedAssets: readonly string[];
    /**
     * The allowlist, resolved (ADR-0016). Lookup is by ledger asset key —
     * `SOL`, or a mint address — because that is what the ledger stores and
     * what arrives on a withdrawal request.
     */
    readonly assets: AssetRegistry;
  };
  readonly prices: {
    readonly source: Env['PRICE_SOURCE'];
    readonly endpoint: string;
    readonly apiKey: string;
    readonly pollIntervalMs: number;
    readonly requestTimeoutMs: number;
    /** Symbol → source identifier, from `PRICE_FEEDS`. */
    readonly feeds: Readonly<Record<string, string>>;
    /** Symbol → fixed price, from `PRICE_STATIC`. */
    readonly fixed: Readonly<Record<string, string>>;
  };
  readonly indexer: {
    readonly enabled: boolean;
    readonly pollIntervalMs: number;
    readonly pageSize: number;
    readonly maxAddressesPerCycle: number;
  };
  readonly reconciliation: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly alertAfterCycles: number;
  };
  readonly risk: {
    /**
     * Per-asset limits keyed by ledger asset key (ADR-0016, rule 127).
     *
     * The native asset is always present, from the `RISK_*` variables. A mint
     * appears only if `RISK_ASSET_LIMITS` names it — and one that does not
     * appear is not withdrawable, which is the safe reading of a gap.
     */
    readonly assetLimits: Readonly<
      Record<
        string,
        {
          readonly perTransactionLimit: string;
          readonly dailyLimit: string;
          readonly manualReviewAbove: string;
        }
      >
    >;
    readonly perTransactionLimit: string;
    readonly dailyLimit: string;
    readonly velocityWindowMinutes: number;
    readonly velocityMaxCount: number;
    readonly manualReviewAbove: string;
    readonly reviewNewDestinations: boolean;
    /** Whole dollars as a decimal string, or null for base-unit review (ADR-0024). */
    readonly manualReviewAboveUsd: string | null;
    readonly priceMaxAgeSeconds: number;
    readonly knownDestinationWindowDays: number;
  };
  readonly withdrawal: {
    readonly stepUpMaxAgeSeconds: number;
    readonly signerKind: Env['SIGNER_KIND'];
    readonly signerKeyRef: string;
    /**
     * Segregated custody (ADR-0020): per-user threshold keys, withdrawals paid
     * from the user's own address. False is the omnibus model.
     */
    readonly segregatedCustody: boolean;
    readonly mpc: {
      readonly endpoint: string;
      readonly clientPrivateKey: string;
      readonly callerName: string;
      readonly approvalPrivateKey: string;
      readonly timeoutMs: number;
    };
    readonly treasuryAddress: string | undefined;
    readonly noncePoolSize: number;
    readonly workersEnabled: boolean;
    readonly workerIntervalMs: number;
    readonly workerBatchSize: number;
    readonly budgets: {
      readonly sign: number;
      readonly broadcast: number;
      readonly expiry: number;
    };
    readonly operatorUserIds: readonly string[];
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
/**
 * Resolve secret REFERENCES into values before validation (rule 161).
 *
 * Runs first so the rest of the schema validates real values: a KEK that is
 * `file:/run/secrets/kek` must be 32 bytes of key, not 26 characters of path,
 * and validating the reference would pass while the value failed much later.
 *
 * A value with no scheme is passed through unchanged, so an existing `.env`
 * deployment behaves exactly as before.
 */
function resolveSecretReferences(raw: RawEnv): { raw: RawEnv; audit: SecretAudit[] } {
  const resolved: Record<string, string | undefined> = { ...raw };
  const audit: SecretAudit[] = [];

  for (const variable of SECRET_VARIABLES) {
    const reference = raw[variable];
    if (reference === undefined || reference.trim() === '') continue;

    // `raw` IS the environment here — `parseEnv` is called with
    // `process.env` by `loadApiConfigOrExit`, which is the one place that
    // reads it.
    const secret = resolveSecret(variable, reference, raw);
    resolved[variable] = secret.value;
    audit.push({ variable, scheme: secret.scheme, describe: secret.describe });
  }

  return { raw: resolved, audit };
}

/** Every variable whose value is a secret rather than configuration. */
const SECRET_VARIABLES = [
  'DEPOSIT_SEED',
  'SESSION_SECRET',
  'TOTP_ENCRYPTION_KEY',
  'MPC_KEK',
  'MPC_CLIENT_PRIVATE_KEY',
  'MPC_APPROVAL_PRIVATE_KEY',
] as const;

/** How each secret was obtained. Names and schemes only — never values. */
let lastSecretAudit: SecretAudit[] = [];

export function secretAudit(): readonly SecretAudit[] {
  return lastSecretAudit;
}

export function parseEnv(raw: RawEnv): Env {
  let resolved: RawEnv;
  try {
    const outcome = resolveSecretReferences(raw);
    resolved = outcome.raw;
    lastSecretAudit = outcome.audit;
  } catch (error) {
    // A reference that cannot be resolved is a configuration error and is
    // reported like one: the variable name and the reason, never a value.
    throw new ConfigValidationError([
      {
        variable: error instanceof SecretResolutionError ? error.variable : '(secret)',
        problem:
          error instanceof SecretResolutionError
            ? error.message.replace(`${error.variable}: `, '')
            : 'could not be resolved',
      },
    ]);
  }

  const result = envSchema.safeParse(resolved);

  if (result.success) {
    /*
     * The two secrets that can regenerate everything else must not be
     * literals in production (rule 162): the deposit seed derives every
     * deposit key, and the KEK decrypts the treasury key at rest.
     *
     * Checked AFTER parsing, so it only fires on an otherwise valid config,
     * and only in production — development is `.env` by design.
     */
    if (result.data.NODE_ENV === 'production') {
      const literals = lastSecretAudit.filter(
        (entry) =>
          entry.scheme === 'literal' &&
          (CRITICAL_SECRETS as readonly string[]).includes(entry.variable),
      );

      if (literals.length > 0) {
        throw new ConfigValidationError(
          literals.map((entry) => ({
            variable: entry.variable,
            problem:
              'must come from a secret manager in production, not the environment. ' +
              'Use file:/path or env:OTHER_VAR (master-prompt rule 157).',
          })),
        );
      }
    }

    return result.data;
  }

  const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
    variable: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    problem:
      issue.code === 'invalid_type' && issue.received === 'undefined'
        ? 'is required but was not set'
        : issue.message,
  }));
  throw new ConfigValidationError(issues);
}

/**
 * Read a suffixed environment value, falling back to the unsuffixed one for
 * the DEFAULT cluster only.
 *
 * The asymmetry is deliberate. A mint address means a different token on a
 * different cluster, so inheriting `TOKEN_MINTS` across clusters would
 * allowlist whatever happens to live at that address on devnet. The default
 * cluster is what the unsuffixed variables were always describing, so there it
 * is not inheritance at all.
 */
function perCluster<T>(env: Env, base: keyof Env, cluster: Cluster, defaultCluster: Cluster): T {
  const specific = (env as unknown as Record<string, unknown>)[
    `${String(base)}_${clusterSuffix(cluster)}`
  ];
  const hasSpecific = Array.isArray(specific) ? specific.length > 0 : specific !== undefined;
  if (hasSpecific) return specific as T;
  return (cluster === defaultCluster ? env[base] : ([] as unknown)) as T;
}

/** `SYMBOL:VALUE` entries as a record, symbols upper-cased for lookup. */
function pairs(entries: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const [symbol, value] = entry.split(':');
    if (symbol !== undefined && value !== undefined)
      out[symbol.trim().toUpperCase()] = value.trim();
  }
  return out;
}

export function toApiConfig(env: Env): ApiConfig {
  const defaultCluster = env.SOLANA_NETWORK;
  const served: Cluster[] =
    env.SOLANA_CLUSTERS.length > 0 ? [...env.SOLANA_CLUSTERS] : [defaultCluster];

  const byCluster: Partial<Record<Cluster, ClusterChainConfig>> = {};
  for (const cluster of served) {
    const tokens = perCluster<Env['TOKEN_MINTS']>(env, 'TOKEN_MINTS', cluster, defaultCluster);
    byCluster[cluster] = Object.freeze({
      cluster,
      rpcUrl: rpcUrlFor(env, cluster),
      assets: createAssetRegistry({
        cluster,
        // Native decimals are a display fallback only; see `assets.ts`.
        nativeDecimals: NATIVE_ASSET_DECIMALS,
        tokens: tokens.map((token) => ({
          symbol: token.symbol,
          mint: token.mint,
          decimals: Number(token.decimals),
        })),
      }),
    });
  }

  const defaultChain = byCluster[defaultCluster];
  if (!defaultChain) {
    // Unreachable: `served` always contains the default cluster, enforced in
    // superRefine. Stated rather than asserted so a future edit that breaks
    // the invariant fails here instead of producing an empty registry.
    throw new Error(`the default cluster ${defaultCluster} is not served`);
  }

  /*
   * Risk limits, keyed by CLUSTER-QUALIFIED asset key (ADR-0021).
   *
   * One flat map rather than a map per cluster, because the keys already carry
   * the cluster — the same property that keeps the ledger from merging them.
   * A lookup cannot reach the wrong cluster's limit by omission.
   */
  const assetLimits: Record<
    string,
    { perTransactionLimit: string; dailyLimit: string; manualReviewAbove: string }
  > = {};

  for (const cluster of served) {
    // The native asset keeps the variables it has always had, applied to each
    // served cluster: a per-transaction ceiling is a policy about SOL, and it
    // is no less true of devnet SOL.
    assetLimits[ledgerAssetKey(cluster, NATIVE_ASSET_KEY)] = Object.freeze({
      perTransactionLimit: env.RISK_PER_TRANSACTION_LIMIT,
      dailyLimit: env.RISK_DAILY_LIMIT,
      manualReviewAbove: env.RISK_MANUAL_REVIEW_ABOVE,
    });

    const limits = perCluster<Env['RISK_ASSET_LIMITS']>(
      env,
      'RISK_ASSET_LIMITS',
      cluster,
      defaultCluster,
    );
    for (const limit of limits) {
      assetLimits[ledgerAssetKey(cluster, limit.asset)] = Object.freeze({
        perTransactionLimit: limit.perTransactionLimit,
        dailyLimit: limit.dailyLimit,
        manualReviewAbove: limit.manualReviewAbove,
      });
    }
  }

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
      withdrawalPerMinute: env.RATE_LIMIT_WITHDRAWAL_PER_MINUTE,
      globalPerMinute: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
    }),
    chain: Object.freeze({
      rpcUrl: env.SOLANA_RPC_URL,
      network: env.SOLANA_NETWORK,
      defaultCluster: env.SOLANA_NETWORK,
      clusters: Object.freeze([...served]),
      byCluster: Object.freeze(
        Object.fromEntries(
          served.map((cluster) => [cluster, byCluster[cluster]] as const),
        ) as Partial<Record<Cluster, ClusterChainConfig>>,
      ),
      commitment: env.SOLANA_COMMITMENT,
      rpcTimeoutMs: env.SOLANA_RPC_TIMEOUT_MS,
      rpcMaxRetries: env.SOLANA_RPC_MAX_RETRIES,
      depositSeed: env.DEPOSIT_SEED,
      supportedAssets: Object.freeze([...env.SUPPORTED_ASSETS]),
      // The DEFAULT cluster's registry. Every other cluster is reached through
      // `byCluster`, and nothing may use this one as a stand-in for them.
      assets: defaultChain.assets,
    }),
    prices: Object.freeze({
      source: env.PRICE_SOURCE,
      endpoint: env.PRICE_ENDPOINT,
      apiKey: env.PRICE_API_KEY,
      pollIntervalMs: env.PRICE_POLL_INTERVAL_MS,
      requestTimeoutMs: env.PRICE_REQUEST_TIMEOUT_MS,
      feeds: Object.freeze(pairs(env.PRICE_FEEDS)),
      fixed: Object.freeze(pairs(env.PRICE_STATIC)),
    }),
    indexer: Object.freeze({
      enabled: env.INDEXER_ENABLED,
      pollIntervalMs: env.INDEXER_POLL_INTERVAL_MS,
      pageSize: env.INDEXER_PAGE_SIZE,
      maxAddressesPerCycle: env.INDEXER_MAX_ADDRESSES_PER_CYCLE,
    }),
    reconciliation: Object.freeze({
      enabled: env.RECONCILIATION_ENABLED,
      intervalMs: env.RECONCILIATION_INTERVAL_MS,
      alertAfterCycles: env.RECONCILIATION_ALERT_AFTER_CYCLES,
    }),
    risk: Object.freeze({
      assetLimits: Object.freeze(assetLimits),
      perTransactionLimit: env.RISK_PER_TRANSACTION_LIMIT,
      dailyLimit: env.RISK_DAILY_LIMIT,
      velocityWindowMinutes: env.RISK_VELOCITY_WINDOW_MINUTES,
      velocityMaxCount: env.RISK_VELOCITY_MAX_COUNT,
      manualReviewAbove: env.RISK_MANUAL_REVIEW_ABOVE,
      reviewNewDestinations: env.RISK_NEW_DESTINATION_REVIEW,
      manualReviewAboveUsd:
        env.RISK_MANUAL_REVIEW_ABOVE_USD === '' ? null : env.RISK_MANUAL_REVIEW_ABOVE_USD,
      priceMaxAgeSeconds: env.RISK_PRICE_MAX_AGE_SECONDS,
      knownDestinationWindowDays: env.RISK_KNOWN_DESTINATION_WINDOW_DAYS,
    }),
    withdrawal: Object.freeze({
      stepUpMaxAgeSeconds: env.WITHDRAWAL_STEP_UP_MAX_AGE_SECONDS,
      signerKind: env.SIGNER_KIND,
      signerKeyRef: env.SIGNER_KEY_REF,
      segregatedCustody: env.SEGREGATED_CUSTODY,
      mpc: Object.freeze({
        endpoint: env.MPC_ENDPOINT,
        clientPrivateKey: env.MPC_CLIENT_PRIVATE_KEY,
        callerName: env.MPC_CALLER_NAME,
        approvalPrivateKey: env.MPC_APPROVAL_PRIVATE_KEY,
        timeoutMs: env.MPC_TIMEOUT_MS,
      }),
      treasuryAddress: env.TREASURY_ADDRESS,
      noncePoolSize: env.NONCE_POOL_SIZE,
      workersEnabled: env.WITHDRAWAL_WORKERS_ENABLED,
      workerIntervalMs: env.WITHDRAWAL_WORKER_INTERVAL_MS,
      workerBatchSize: env.WITHDRAWAL_WORKER_BATCH_SIZE,
      budgets: Object.freeze({
        sign: env.WITHDRAWAL_SIGN_MAX_ATTEMPTS,
        broadcast: env.WITHDRAWAL_BROADCAST_MAX_ATTEMPTS,
        expiry: env.WITHDRAWAL_EXPIRY_MAX_ATTEMPTS,
      }),
      operatorUserIds: Object.freeze([...env.OPERATOR_USER_IDS]),
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
export * from './secrets.js';
