import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import type { ApiConfig } from '@wallet/config';
import { createPrivateKey } from 'node:crypto';
import {
  createMockSigner,
  createRustSigner,
  type ChainAdapter,
  type KeyProvisioner,
  type Signer,
} from '@wallet/blockchain';
import {
  createRedisChallengeStore,
  createEncryptor,
  createSessionManager,
  createTotpService,
  createWebAuthnService,
} from '@wallet/auth';
import {
  createAuditLogRepository,
  createCredentialRepository,
  createPrismaClient,
  createRecoveryCodeRepository,
  createSessionRepository,
  createUserRepository,
  type PrismaClient,
} from '@wallet/db';
import { createLogger, type Logger } from '@wallet/logger';
import { GENESIS_HASHES, type NonceManager, type WithdrawalBroadcaster } from '@wallet/solana';
import type { Cluster } from '@wallet/types';
import type { MpcRole } from '@wallet/blockchain';
import {
  createClusterRuntime,
  type ClusterOverrides,
  type ClusterRuntime,
} from './cluster/runtime.js';

import { requestContextPlugin } from './plugins/request-context.js';
import { clusterContextPlugin } from './plugins/cluster-context.js';
import { securityPlugin } from './plugins/security.js';
import { registerErrorHandler } from './errors/handler.js';
import {
  createCsrfGuard,
  createSessionGuard,
  createStepUpGuard,
  createWithdrawalStepUpGuard,
} from './middleware/guards.js';
import { createAuthControllers } from './controllers/auth.controller.js';
import { createCustodyControllers } from './controllers/custody.controller.js';
import { createPortfolioControllers } from './controllers/portfolio.controller.js';
import {
  createReconciliationWorker,
  type ReconciliationWorker,
} from './workers/reconciliation-worker.js';
import type { Indexer } from './workers/indexer.js';
import { createCustodyRoutes } from './routes/custody.routes.js';
import { createPortfolioRoutes } from './routes/portfolio.routes.js';
import { createWithdrawalControllers } from './controllers/withdrawal.controller.js';
import type { WithdrawalWorkers } from './workers/withdrawal-workers.js';
import { createPricer, type Pricer } from './workers/pricer.js';
import { createCoinGeckoSource } from './services/prices/coingecko.js';
import { createPythSource } from './services/prices/pyth.js';
import { createStaticSource } from './services/prices/static.js';
import type { PriceSource } from './services/prices/source.js';
import { createWalletMetrics } from './observability/metrics.js';
import { createDeadLetterQueue } from './observability/dead-letter.js';
import { createOperationsRoutes } from './routes/operations.routes.js';
import { createWithdrawalRoutes } from './routes/withdrawal.routes.js';
import { createAccountService } from './services/account.service.js';
import { createHealthService } from './services/health.service.js';
import { createLoginService } from './services/login.service.js';
import { createRegistrationService } from './services/registration.service.js';
import { createStepUpService } from './services/step-up.service.js';
import { createTotpEnrollmentService } from './services/totp.service.js';
import type { AppDeps } from './services/deps.js';
import { createAuthRoutes } from './routes/auth.routes.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { createMeRoutes } from './routes/me.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    log2: Logger;
    appDeps: AppDeps;
    /** The DEFAULT cluster's indexer. Others live in `clusters` (ADR-0021). */
    indexer: Indexer | null;
    /** The DEFAULT cluster's workers. */
    withdrawalWorkers: WithdrawalWorkers;
    /** Every served cluster's object graph, keyed by cluster. */
    clusters: ReadonlyMap<Cluster, ClusterRuntime>;
    /** The price ingestion worker. Tests drive `runOnce()` (Task 3). */
    pricer: Pricer;
    signer: Signer;
    reconcile: () => Promise<unknown>;
    reconciliationWorker: ReconciliationWorker;
    shutdown: () => Promise<void>;
  }
}

export interface BuildServerOptions {
  readonly config: ApiConfig;
  /** Injected by tests; production builds its own. */
  readonly logger?: Logger;
  readonly db?: PrismaClient;
  readonly redis?: Redis;
  /**
   * Injected by tests so the deposit pipeline can be driven without a
   * validator (prompt_phase2.md rule 147 needs deterministic restart points).
   * Production builds a real Solana adapter.
   */
  readonly chainAdapter?: ChainAdapter;
  /** Tests drive the indexer by hand rather than on a timer. */
  readonly startIndexer?: boolean;
  /**
   * Off in tests by default, like the other timers: a background reconciliation
   * running mid-assertion reads a half-written ledger and reports drift that
   * the test itself created.
   */
  readonly startReconciliation?: boolean;
  /**
   * Injected so a test can make the signer fail, hang, or return garbage on
   * demand — which is the entire reason the mock exists (rules 127-128).
   */
  readonly signer?: Signer;
  readonly nonceManager?: NonceManager;
  readonly broadcaster?: WithdrawalBroadcaster;
  readonly startWithdrawalWorkers?: boolean;
  readonly startPricer?: boolean;
  /** Per-cluster test seams. See `overridesFor`. */
  readonly clusterOverrides?: Partial<Record<Cluster, ClusterOverrides>>;
}

/**
 * The configured price source (Task 3).
 *
 * `none` still returns a source — one that prices nothing. The alternative is
 * an optional worker and a null check at every call site, and the behaviour is
 * identical: no ticks, so the dashboard says it has no prices.
 */
function buildPriceSource(config: ApiConfig): PriceSource {
  const shared = {
    apiKey: config.prices.apiKey.trim() === '' ? undefined : config.prices.apiKey,
    requestTimeoutMs: config.prices.requestTimeoutMs,
    ...(config.prices.endpoint.trim() === '' ? {} : { endpoint: config.prices.endpoint }),
  };

  switch (config.prices.source) {
    case 'coingecko':
      return createCoinGeckoSource({ ...shared, ids: config.prices.feeds });
    case 'pyth':
      return createPythSource({ ...shared, feeds: config.prices.feeds });
    case 'static':
      return createStaticSource(config.prices.fixed);
    case 'none':
      return { name: 'none', fetch: async () => Promise.resolve([]) };
  }
}

/** A signer that can also create per-user threshold keys (ADR-0020). */
function isKeyProvisioner(signer: Signer): signer is Signer & KeyProvisioner {
  return typeof (signer as { provisionKey?: unknown }).provisionKey === 'function';
}

/** A signer that can report its own liveness. Only the real one can. */
function isHealthCheckable(signer: Signer): signer is Signer & { isHealthy(): Promise<boolean> } {
  return typeof (signer as { isHealthy?: unknown }).isHealthy === 'function';
}

/** A signer that can say what the service behind it actually is. */
function isDescribable(
  signer: Signer,
): signer is Signer & { describe(): Promise<MpcRole | undefined> } {
  return typeof (signer as { describe?: unknown }).describe === 'function';
}

/**
 * Choose a signer from configuration.
 *
 * `real` is declared in the config schema so a production deployment is
 * expressible, but nothing implements it until Phase 4. Failing loudly here
 * beats silently falling back to the mock, which is the one outcome that must
 * never happen (prompt_phase3.md rules 125, 227).
 */
function buildSigner(config: ApiConfig): Signer {
  if (config.withdrawal.signerKind === 'real') {
    // Phase 4a. Key generation, storage, signing and idempotency all live in
    // services/mpc; this is transport (ADR-0013).
    return createRustSigner({
      endpoint: config.withdrawal.mpc.endpoint,
      clientPrivateKey: createPrivateKey(
        Buffer.from(config.withdrawal.mpc.clientPrivateKey, 'base64').toString('utf8'),
      ),
      callerName: config.withdrawal.mpc.callerName,
      requestTimeoutMs: config.withdrawal.mpc.timeoutMs,
    });
  }
  return createMockSigner({ nodeEnv: config.shared.nodeEnv, seed: config.session.secret });
}

/**
 * THE COMPOSITION ROOT (prompt_phase1.md rules 146-147).
 *
 * Every dependency in this application is constructed here and passed down.
 * Nothing below this file imports a singleton or reaches for global state, and
 * that is not tidiness for its own sake — it is what lets Phase 3 inject a mock
 * signer and Phase 4 swap in the real Rust one without touching a single call
 * site. If that swap ever requires editing a service, the abstraction leaked
 * and the leak is the bug.
 */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config } = options;

  const logger =
    options.logger ??
    createLogger({ level: config.shared.logLevel, base: { status: config.shared.nodeEnv } });

  const db =
    options.db ??
    createPrismaClient({ url: config.database.url, log: !config.shared.isProduction });
  const redis = options.redis ?? new Redis(config.redis.url, { maxRetriesPerRequest: 3 });

  // --- Infrastructure ------------------------------------------------------
  const users = createUserRepository(db);
  const credentials = createCredentialRepository(db);
  const sessionsRepo = createSessionRepository(db);
  const recoveryCodes = createRecoveryCodeRepository(db);
  const audit = createAuditLogRepository(db);

  // --- Domain services -----------------------------------------------------
  const challenges = createRedisChallengeStore(redis, config.webauthn.challengeTtlSeconds);
  const webauthn = createWebAuthnService(
    {
      rpId: config.webauthn.rpId,
      rpName: config.webauthn.rpName,
      origin: config.webauthn.origin,
    },
    challenges,
  );
  const sessions = createSessionManager(sessionsRepo, {
    idleTtlSeconds: config.session.idleTtlSeconds,
    absoluteTtlSeconds: config.session.absoluteTtlSeconds,
    stepUpMaxAgeSeconds: config.session.stepUpMaxAgeSeconds,
  });
  const totpService = createTotpService(createEncryptor(config.crypto.totpEncryptionKey));

  const appDeps: AppDeps = {
    db,
    users,
    credentials,
    sessionsRepo,
    recoveryCodes,
    audit,
    sessions,
    webauthn,
    totp: totpService,
    challenges,
    logger,
  };

  // --- Application services ------------------------------------------------
  const registration = createRegistrationService(appDeps);
  const login = createLoginService(appDeps);
  const stepUp = createStepUpService(appDeps);
  const account = createAccountService(appDeps);
  const totp = createTotpEnrollmentService(appDeps);
  /**
   * Observability, created before anything that records into it
   * (master-prompt rules 171, 173).
   *
   * One registry per server instance rather than a module-level singleton, so
   * a test harness gets its own and two servers in one process do not share
   * counters.
   */
  const metrics = createWalletMetrics();
  const deadLetters = createDeadLetterQueue({
    logger,
    deadLettered: metrics.deadLettered,
    queueDepth: metrics.queueDepth,
  });

  const signer = options.signer ?? buildSigner(config);

  /*
   * Per-user threshold keys (ADR-0020), when the deployment is segregated.
   *
   * `SEGREGATED_CUSTODY` is validated at config load, so by here a true value
   * means the signer really is the MPC client. The narrowing is checked: only
   * that client implements `provisionKey`.
   */
  const keyProvisioner: KeyProvisioner | undefined =
    config.withdrawal.segregatedCustody && isKeyProvisioner(signer) ? signer : undefined;

  if (config.withdrawal.segregatedCustody && !keyProvisioner) {
    throw new Error(
      'SEGREGATED_CUSTODY is enabled but the signer cannot provision keys — ' +
        'a user would be handed a seed-derived address, which is the opposite of segregation',
    );
  }

  const approvalKey =
    config.withdrawal.mpc.approvalPrivateKey.trim() !== ''
      ? createPrivateKey(
          Buffer.from(config.withdrawal.mpc.approvalPrivateKey, 'base64').toString('utf8'),
        )
      : undefined;

  /*
   * ONE OBJECT GRAPH PER CLUSTER (ADR-0021).
   *
   * Each runtime holds its own RPC connection, adapter, nonce pool, indexer,
   * allowlist and risk limits. Nothing is shared between them except the
   * database, the signer and this process — so code holding the devnet runtime
   * has no reference through which mainnet could be reached.
   *
   * The test seams apply to the DEFAULT cluster only. A fake broadcaster has
   * no notion of which cluster it belongs to, and injecting one into two
   * clusters would make "did this land?" ambiguous in exactly the way durable
   * nonces exist to prevent.
   */
  /**
   * Test seams, per cluster.
   *
   * The unsuffixed options belong to the DEFAULT cluster, which is what every
   * single-cluster suite means by "the chain". `clusterOverrides` is for the
   * suites that serve more than one and need each to behave differently —
   * without it a fake injected into two clusters would make "did this land?"
   * ambiguous in exactly the way durable nonces exist to prevent.
   */
  function overridesFor(cluster: Cluster): ClusterOverrides | undefined {
    const explicit = options.clusterOverrides?.[cluster];
    if (explicit) return explicit;
    if (cluster !== config.chain.defaultCluster) return undefined;
    return {
      adapter: options.chainAdapter,
      nonceManager: options.nonceManager,
      broadcaster: options.broadcaster,
    };
  }

  const clusters = new Map<Cluster, ClusterRuntime>();
  for (const cluster of config.chain.clusters) {
    const chain = config.chain.byCluster[cluster];
    if (!chain) {
      // Unreachable: config guarantees an entry for every served cluster.
      throw new Error(`cluster ${cluster} is served but has no configuration`);
    }

    clusters.set(
      cluster,
      createClusterRuntime({
        config,
        chain,
        db,
        logger,
        signer,
        keyProvisioner,
        metrics,
        deadLetters,
        approvalKey,
        ...(overridesFor(cluster) ? { overrides: overridesFor(cluster)! } : {}),
      }),
    );
  }

  const defaultRuntime = clusters.get(config.chain.defaultCluster);
  if (!defaultRuntime) throw new Error('the default cluster has no runtime');

  /** The runtime for a request's cluster. Never a silent fallback. */
  function runtimeFor(cluster: Cluster): ClusterRuntime {
    const runtime = clusters.get(cluster);
    if (!runtime) {
      // A cluster this deployment does not serve is a client error, and it is
      // reported as one by the plugin before any handler runs. Reaching here
      // means the plugin was bypassed.
      throw new Error(`cluster ${cluster} is not served by this deployment`);
    }
    return runtime;
  }

  /**
   * Readiness covers every dependency a request can fail on
   * (master-prompt rule 170, prompt_phase4.md rule 223).
   *
   * One probe PER CLUSTER: an unreachable devnet endpoint and an unreachable
   * mainnet endpoint are different incidents with different urgency, and a
   * single `solana` check would report the more optimistic of the two.
   */
  /*
   * Probed once, at boot. The role changes on deploy, not while someone is
   * looking at a page, and probing per request would put the signing service
   * on the path of an unauthenticated endpoint.
   */
  const signerRole = isDescribable(signer) ? await signer.describe() : undefined;

  const health = createHealthService(db, redis, [
    ...[...clusters.values()].map((runtime) => ({
      name: `solana:${runtime.cluster}`,
      check: () => runtime.adapter.isHealthy(),
    })),
    ...(isHealthCheckable(signer) ? [{ name: 'mpc', check: () => signer.isHealthy() }] : []),
  ]);

  /**
   * VERIFY THAT EACH ENDPOINT SERVES THE CLUSTER WE CLAIM (rule 172).
   *
   * A cluster name is a label. It is rendered on the deposit page as the
   * network the user must send on — and until this check existed, nothing tied
   * it to the URL. A deployment naming `mainnet-beta` while pointing at devnet
   * would tell people to send real funds to an address the indexer watches on
   * another cluster: the money is real, the credit never comes, and the
   * interface said it was fine.
   *
   * The genesis hash is the authoritative answer and works with any provider;
   * hostname matching does not, because a custom RPC has an arbitrary hostname
   * and that is precisely the case worth catching.
   *
   * `localnet` is skipped: a fresh validator generates a new genesis hash on
   * every reset, so there is nothing to compare against.
   */
  for (const runtime of clusters.values()) {
    const expectedGenesis = GENESIS_HASHES[runtime.cluster];
    if (expectedGenesis === undefined) continue;

    const actual = await runtime.adapter.getNetworkIdentity();
    if (actual !== expectedGenesis) {
      throw new Error(
        `the RPC endpoint for ${runtime.cluster} does not serve it: the endpoint reports ` +
          `genesis ${actual}, expected ${expectedGenesis}. Deposit addresses would be ` +
          'advertised for a network nothing is watching.',
      );
    }
    logger.info('chain network verified', {
      event: 'indexer.network_verified',
      outcome: 'success',
      targetType: 'chain',
      targetId: runtime.cluster,
    });
  }

  const reconciliationWorker = createReconciliationWorker({
    // Every served cluster, one after another. A drift streak is counted
    // across the whole run, because an operator wants one alert saying
    // "reconciliation is drifting", not one per cluster per cycle.
    run: async () => {
      const reports = await Promise.all(
        [...clusters.values()].map(async (runtime) => runtime.reconcile()),
      );
      return {
        ...reports[0]!,
        assets: reports.flatMap((report) => report.assets),
        healthy: reports.every((report) => report.healthy),
      };
    },
    logger,
    consecutiveCyclesBeforeAlert: config.reconciliation.alertAfterCycles,
    intervalMs: config.reconciliation.intervalMs,
  });

  const withdrawalControllers = createWithdrawalControllers({
    db,
    runtimeFor,
    bootstrapOperatorUserIds: config.withdrawal.operatorUserIds,
  });

  const custodyControllers = createCustodyControllers({ db, runtimeFor });

  const portfolioControllers = createPortfolioControllers({ runtimeFor });

  const controllers = createAuthControllers({
    app: appDeps,
    registration,
    login,
    stepUp,
    account,
    totp,
    stepUpMaxAgeSeconds: config.session.stepUpMaxAgeSeconds,
  });

  // --- HTTP ----------------------------------------------------------------
  const app = Fastify({
    // Fastify's own logger is disabled: every line in this system goes through
    // @wallet/logger so the allowlist applies to all of it without exception
    // (rules 68, 73).
    logger: false,
    trustProxy: true,
    bodyLimit: 256 * 1024,
    disableRequestLogging: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('log2', logger);
  app.decorate('appDeps', appDeps);

  // Order matters: context first so everything downstream is correlated
  // (rule 148), then the error handler so even plugin failures are formatted.
  await app.register(requestContextPlugin, { logger });
  // Before the error handler is irrelevant; before any route matters — the
  // cluster is part of a request's meaning, and a handler that ran without one
  // would answer for the default and look correct.
  await app.register(clusterContextPlugin, {
    served: config.chain.clusters,
    defaultCluster: config.chain.defaultCluster,
  });
  registerErrorHandler(app, logger);
  await app.register(securityPlugin, {
    webOrigin: config.http.webOrigin,
    cookieSecret: config.session.secret,
    redis,
    globalPerMinute: config.rateLimit.globalPerMinute,
  });

  const guardDeps = {
    sessions,
    cookieName: config.session.cookieName,
    webOrigin: config.http.webOrigin,
    logger,
  };
  const csrfGuard = createCsrfGuard(guardDeps);
  const sessionGuard = createSessionGuard(guardDeps);
  const stepUpGuard = createStepUpGuard(guardDeps);
  const withdrawalStepUpGuard = createWithdrawalStepUpGuard({
    ...guardDeps,
    reviewThreshold: BigInt(config.risk.manualReviewAbove),
    strictMaxAgeSeconds: config.withdrawal.stepUpMaxAgeSeconds,
  });

  await app.register(
    createHealthRoutes(health, {
      signing: {
        /*
         * What it IS, PROBED from the service rather than read from a flag.
         *
         * This said `single-key-mpc` while the deployment was running 3-of-5
         * — under-claiming, which is the safe direction, but still a false
         * statement about custody in the one place users are told about it.
         * Configuration cannot answer it: `SIGNER_KIND=real` is true of both
         * a single-key service and a coordinator.
         *
         * An unreachable service leaves `signerRole` undefined and the
         * WEAKER claim stands. A platform that cannot say what its signing is
         * must not make the stronger statement.
         */
        mode:
          config.withdrawal.signerKind !== 'real'
            ? 'mock'
            : signerRole === 'coordinator'
              ? 'threshold-mpc'
              : 'single-key-mpc',
        thresholdProtected: signerRole === 'coordinator',
      },
      clusters: {
        served: [...config.chain.clusters],
        default: config.chain.defaultCluster,
      },
      /**
       * Every asset on every served cluster, cluster-qualified.
       *
       * The union rather than the default cluster's list: this endpoint
       * describes the DEPLOYMENT, and a client choosing a cluster in the
       * switcher needs to know what it will find there before switching.
       */
      assets: {
        supported: [...clusters.values()].flatMap((runtime) => [...runtime.assets.keys]),
        labels: Object.fromEntries(
          [...clusters.values()].flatMap((runtime) =>
            runtime.assets.keys.map((key) => [key, runtime.assets.symbolOf(key)]),
          ),
        ),
      },
      auditedForProduction: false,
    }),
  );
  await app.register(
    createAuthRoutes({
      controllers,
      cookiePolicy: {
        name: config.session.cookieName,
        // Secure cookies over plain HTTP would simply never be stored, so
        // localhost development would break. Anything else is https-only.
        secure: !config.http.webOrigin.startsWith('http://localhost'),
        maxAgeSeconds: config.session.absoluteTtlSeconds,
      },
      sessionGuard: sessionGuard as never,
      stepUpGuard: stepUpGuard as never,
      csrfGuard: csrfGuard as never,
      authRateLimit: { max: config.rateLimit.authPerIpPerMinute, timeWindow: '1 minute' },
    }),
  );
  await app.register(
    createMeRoutes({ account, sessionGuard: sessionGuard as never, csrfGuard: csrfGuard as never }),
  );
  await app.register(
    createCustodyRoutes({
      controllers: custodyControllers,
      sessionGuard: sessionGuard as never,
      csrfGuard: csrfGuard as never,
    }),
  );

  await app.register(
    createPortfolioRoutes({
      controllers: portfolioControllers,
      sessionGuard: sessionGuard as never,
    }),
  );

  await app.register(
    createWithdrawalRoutes({
      controllers: withdrawalControllers,
      sessionGuard: sessionGuard as never,
      csrfGuard: csrfGuard as never,
      withdrawalStepUpGuard: withdrawalStepUpGuard as never,
      // The operator queue always demands the strict tier: Phase 3 has no role
      // model, so freshness is doing the work a role check would.
      operatorStepUpGuard: createStepUpGuard(
        guardDeps,
        config.withdrawal.stepUpMaxAgeSeconds,
      ) as never,
      rateLimit: { max: config.rateLimit.withdrawalPerMinute, timeWindow: '1 minute' },
    }),
  );

  await app.register(
    createOperationsRoutes({
      metrics: metrics.registry,
      deadLetters,
      sessionGuard: sessionGuard as never,
      operatorStepUpGuard: createStepUpGuard(
        guardDeps,
        config.withdrawal.stepUpMaxAgeSeconds,
      ) as never,
      /**
       * Retrying a dead-lettered job means letting the worker pick the
       * withdrawal up again. The worker claims by state, so the retry is
       * expressed as "make this eligible again" rather than as a second code
       * path that does the work itself — a parallel implementation here would
       * be a parallel set of bugs (ADR-0017's argument, applied to jobs).
       */
      retryHandler: async (_queue, reference) => {
        // A dead-lettered job names a withdrawal, not a cluster, so the retry
        // is offered to every cluster's workers. Each one claims by state and
        // by `chain`, so exactly the cluster that owns the withdrawal acts and
        // the rest find nothing.
        for (const runtime of clusters.values()) {
          await runtime.withdrawalWorkers.retry(reference);
        }
      },
    }),
  );

  // --- Workers --------------------------------------------------------------
  //
  // One indexer and one set of withdrawal workers PER CLUSTER. They are not
  // parameterised by cluster: each holds its own adapter, its own nonce pool
  // and its own cursors, and the `chain` value they claim rows by is what
  // keeps two clusters' work from colliding in one database.

  /*
   * The DEFAULT cluster's workers, exposed for the test suite and for the
   * operator surfaces that predate clusters.
   *
   * Named `withdrawalWorkers` rather than `defaultWithdrawalWorkers` because
   * that is what it has always been from outside; what changed is that it is
   * now one of several.
   */
  /*
   * ONE pricer for the whole process, not one per cluster.
   *
   * A price is a fact about a market, not about a chain: devnet USDC and
   * mainnet USDC are the same market, and two workers polling separately would
   * write ticks that differ by whatever moved between two HTTP calls. Two
   * charts of the same asset disagreeing looks like a bug in the ledger.
   */
  const pricer = createPricer({
    db,
    logger,
    source: buildPriceSource(config),
    clusters: new Map([...clusters].map(([cluster, runtime]) => [cluster, runtime.assets])),
    intervalMs: config.prices.pollIntervalMs,
  });

  app.decorate('pricer', pricer);
  app.decorate('indexer', defaultRuntime.indexer);
  app.decorate('withdrawalWorkers', defaultRuntime.withdrawalWorkers);
  app.decorate('clusters', clusters);
  app.decorate('signer', signer);
  app.decorate('reconcile', () => defaultRuntime.reconcile());
  app.decorate('reconciliationWorker', reconciliationWorker);

  // Tests call `runOnce()` by hand so a valuation is a fixed number rather
  // than whatever the market did during the assertion.
  if ((options.startPricer ?? config.prices.source !== 'none') && config.prices.source !== 'none') {
    pricer.start();
  }

  // Tests drive `runOnce()` by hand; production runs it on a timer.
  const shouldStart = options.startIndexer ?? config.indexer.enabled;
  if (shouldStart) {
    for (const runtime of clusters.values()) runtime.indexer.start();
  }

  // The withdrawal workers run on their own timer in production. Tests call
  // `runAllCycles()` so "what happened after N cycles" is answerable.
  let withdrawalTimer: NodeJS.Timeout | undefined;
  const runWorkers = options.startWithdrawalWorkers ?? config.withdrawal.workersEnabled;
  if (runWorkers) {
    const tick = async (): Promise<void> => {
      try {
        for (const runtime of clusters.values()) {
          await runtime.withdrawalWorkers.runAllCycles();
        }
      } catch (error) {
        logger.error('withdrawal worker cycle failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
      withdrawalTimer = setTimeout(() => void tick(), config.withdrawal.workerIntervalMs);
    };
    withdrawalTimer = setTimeout(() => void tick(), config.withdrawal.workerIntervalMs);
  }

  // Reconciliation on its own, much slower timer (rule 140). Tests call
  // `runOnce()` so a drift streak is assertable without waiting on a clock.
  if (options.startReconciliation ?? config.reconciliation.enabled) {
    reconciliationWorker.start();
  }

  app.decorate('shutdown', async () => {
    // Workers stop first so no cycle is mid-transaction when the connection
    // closes.
    if (withdrawalTimer) clearTimeout(withdrawalTimer);
    pricer.stop();
    reconciliationWorker.stop();
    await Promise.all([...clusters.values()].map(async (runtime) => runtime.indexer.stop()));
    await db.$disconnect();
    redis.disconnect();
  });

  return app;
}
