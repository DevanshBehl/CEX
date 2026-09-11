import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import type { ApiConfig } from '@wallet/config';
import type { ChainAdapter } from '@wallet/blockchain';
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
import {
  createSolanaAdapter,
  createSolanaAddressDeriver,
  createSolanaAddressValidator,
  NATIVE_ASSET,
  NATIVE_DECIMALS,
  SOLANA_CHAIN_ID,
} from '@wallet/solana';

import { requestContextPlugin } from './plugins/request-context.js';
import { securityPlugin } from './plugins/security.js';
import { registerErrorHandler } from './errors/handler.js';
import { createCsrfGuard, createSessionGuard, createStepUpGuard } from './middleware/guards.js';
import { createAuthControllers } from './controllers/auth.controller.js';
import { createCustodyControllers } from './controllers/custody.controller.js';
import { createCustodyService } from './services/custody.service.js';
import { createDepositPipeline } from './services/deposit.service.js';
import { createReconciliationService } from './services/reconciliation.service.js';
import { createIndexer, type Indexer } from './workers/indexer.js';
import { createCustodyRoutes } from './routes/custody.routes.js';
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
    indexer: Indexer | null;
    reconcile: () => Promise<unknown>;
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
  const health = createHealthService(db, redis);

  // --- Chain and custody (Phase 2) -----------------------------------------
  const chainAdapter =
    options.chainAdapter ??
    createSolanaAdapter({
      endpoint: config.chain.rpcUrl,
      commitment: config.chain.commitment,
      requestTimeoutMs: config.chain.rpcTimeoutMs,
      maxRetries: config.chain.rpcMaxRetries,
      pageSize: config.indexer.pageSize,
    });

  const custodyService = createCustodyService({
    db,
    // Phase 2 derives addresses only; no private key is stored (ADR-0005).
    deriver: createSolanaAddressDeriver(Buffer.from(config.chain.depositSeed, 'base64')),
    validator: createSolanaAddressValidator(),
    chain: SOLANA_CHAIN_ID,
    assets: config.chain.supportedAssets,
    logger,
  });

  const depositPipeline = createDepositPipeline({ db, logger });
  const reconciliation = createReconciliationService({
    db,
    reader: chainAdapter,
    chain: SOLANA_CHAIN_ID,
    logger,
  });

  const custodyControllers = createCustodyControllers({
    db,
    custody: custodyService,
    chain: SOLANA_CHAIN_ID,
    network: config.chain.network,
    nativeAsset: NATIVE_ASSET,
    decimals: { [NATIVE_ASSET]: NATIVE_DECIMALS },
  });

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
  registerErrorHandler(app, logger);
  await app.register(securityPlugin, {
    webOrigin: config.http.webOrigin,
    cookieSecret: config.session.secret,
    redis,
    globalPerMinute: 300,
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

  await app.register(createHealthRoutes(health));
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

  // --- Workers --------------------------------------------------------------
  const indexer = createIndexer({
    db,
    adapter: chainAdapter,
    pipeline: depositPipeline,
    logger,
    options: {
      chain: SOLANA_CHAIN_ID,
      pollIntervalMs: config.indexer.pollIntervalMs,
      pageSize: config.indexer.pageSize,
      maxAddressesPerCycle: config.indexer.maxAddressesPerCycle,
    },
  });

  app.decorate('indexer', indexer);
  app.decorate('reconcile', () => reconciliation.run());

  // Tests drive `runOnce()` by hand; production runs it on a timer.
  const shouldStart = options.startIndexer ?? config.indexer.enabled;
  if (shouldStart) indexer.start();

  app.decorate('shutdown', async () => {
    // The indexer stops first so no cycle is mid-transaction when the
    // connection closes.
    await indexer.stop();
    await db.$disconnect();
    redis.disconnect();
  });

  return app;
}
