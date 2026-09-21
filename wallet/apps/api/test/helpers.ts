import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { loadApiConfigOrExit, parseEnv, toApiConfig, type ApiConfig } from '@wallet/config';
import type { ChainAdapter, Signer } from '@wallet/blockchain';
import {
  NATIVE_ASSET,
  NATIVE_DECIMALS,
  solanaChainId,
  type NonceManager,
  type WithdrawalBroadcaster,
} from '@wallet/solana';
import { createAssetRegistry } from '@wallet/types';
import { ledgerAssetKey, type Cluster } from '@wallet/types';
import { createPrismaClient, newId } from '@wallet/db';
import { createCapturingLogger, type CapturedLogger } from '@wallet/logger';
import { buildServer, type BuildServerOptions } from '../src/server.js';

export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

/**
 * The cluster the suite runs against (ADR-0021).
 *
 * Read from the same variable the server reads, so a fixture written directly
 * to the database lands in the cluster the API will look in. Hardcoding
 * `localnet` here would make the suite pass while the server looked elsewhere.
 */
export const TEST_CLUSTER = (process.env.SOLANA_NETWORK ?? 'localnet') as Cluster;
export const TEST_CHAIN = solanaChainId(TEST_CLUSTER);

/** A ledger asset key on the test cluster: `localnet:SOL`. */
export const assetKey = (asset: string): string => ledgerAssetKey(TEST_CLUSTER, asset);
export const SOL_KEY = assetKey(NATIVE_ASSET);

export interface Harness {
  app: FastifyInstance;
  logs: CapturedLogger;
  cleanup: () => Promise<void>;
  createdUserIds: string[];
}

/** True when the suite should use the signer `SIGNER_KIND` names. */
export function usesConfiguredSigner(): boolean {
  return process.env.USE_CONFIGURED_SIGNER === 'true';
}

export interface HarnessOptions {
  chainAdapter?: ChainAdapter;
  signer?: Signer;
  nonceManager?: NonceManager;
  broadcaster?: WithdrawalBroadcaster;
  operatorUserIds?: string[];
  /**
   * Segregated custody (ADR-0020): per-user addresses and per-user keys.
   *
   * An override rather than an environment variable so one suite can exercise
   * the segregated path while the rest of the suite keeps exercising the
   * omnibus one. Both models exist in the code and both need testing.
   */
  segregatedCustody?: boolean;
  /**
   * Serve a SECOND cluster alongside the default one (ADR-0021).
   *
   * Built here rather than from environment variables so one suite can be
   * multi-cluster while the rest stay single-cluster. Its adapter must be
   * supplied through `clusterOverrides`: the real one would be pointed at a
   * localnet validator whose genesis hash does not match the cluster it claims
   * to be, and the boot-time check would refuse to start — correctly.
   */
  extraCluster?: Cluster;
  clusterOverrides?: BuildServerOptions['clusterOverrides'];
  /**
   * Leave the price worker stopped.
   *
   * A suite that asserts on a valuation needs the prices it wrote, not
   * whatever the live market did during the assertion.
   */
  startPricer?: boolean;
  /**
   * Risk policy overrides.
   *
   * The suite defaults to the BASE-UNIT review policy (no USD threshold,
   * first-time destinations reviewed), because most suites assert on
   * lifecycle and ledger behaviour rather than on pricing, and a USD policy
   * with no seeded prices reviews everything. The value-based suite opts in.
   */
  risk?: Partial<ApiConfig['risk']>;
  /**
   * Allowlist a token on the DEFAULT cluster, with its withdrawal limits.
   *
   * Built here rather than read from `TOKEN_MINTS` so a token suite does not
   * depend on what happens to be in the developer's `.env`, and so the two
   * halves a token needs cannot drift apart: a mint in the allowlist with no
   * entry in `RISK_ASSET_LIMITS` is depositable and NOT withdrawable
   * (`ASSET_LIMITS_NOT_CONFIGURED`), which is the exact configuration gap this
   * option exists to make impossible to reproduce by accident.
   */
  tokens?: readonly {
    readonly symbol: string;
    readonly mint: string;
    readonly decimals: number;
    readonly perTransactionLimit: string;
    readonly dailyLimit: string;
    readonly manualReviewAbove: string;
  }[];
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = toApiConfig(parseEnv(process.env));
  const logs = createCapturingLogger('trace');
  const db = createPrismaClient({ url: config.database.url });
  const redis = new Redis(config.redis.url, { maxRetriesPerRequest: 3 });

  /*
   * The default cluster's registry, with any suite-declared tokens added.
   *
   * `config.chain.assets` and `config.chain.byCluster[default].assets` are two
   * references to the same allowlist, and BOTH are read: the runtime takes the
   * per-cluster one, and a few call sites take the flat one. Replacing only
   * one produces a server that credits a token and cannot price or withdraw
   * it, which looks exactly like the bug this suite is about.
   */
  const declaredTokens = options.tokens ?? [];
  const defaultAssets =
    declaredTokens.length === 0
      ? config.chain.assets
      : createAssetRegistry({
          cluster: config.chain.defaultCluster,
          nativeDecimals: NATIVE_DECIMALS,
          tokens: [
            ...config.chain.assets.tokens,
            ...declaredTokens.map((token) => ({
              symbol: token.symbol,
              mint: token.mint,
              decimals: token.decimals,
            })),
          ],
        });

  const tokenAssetLimits = Object.fromEntries(
    declaredTokens.map((token) => [
      assetKey(token.mint),
      {
        perTransactionLimit: token.perTransactionLimit,
        dailyLimit: token.dailyLimit,
        manualReviewAbove: token.manualReviewAbove,
      },
    ]),
  );

  const extra = options.extraCluster;
  const chainConfig = extra
    ? {
        ...config.chain,
        assets: defaultAssets,
        supportedAssets: defaultAssets.keys,
        clusters: [...config.chain.clusters, extra],
        byCluster: {
          ...config.chain.byCluster,
          [config.chain.defaultCluster]: {
            ...config.chain.byCluster[config.chain.defaultCluster],
            assets: defaultAssets,
          },
          [extra]: {
            cluster: extra,
            // The same endpoint. What makes the two clusters distinct in this
            // suite is the adapter injected for each, not the URL — and the
            // isolation under test is in the ledger and the routing, not in
            // the transport.
            rpcUrl: config.chain.rpcUrl,
            assets: createAssetRegistry({
              cluster: extra,
              nativeDecimals: NATIVE_DECIMALS,
              tokens: [],
            }),
          },
        },
      }
    : {
        ...config.chain,
        assets: defaultAssets,
        supportedAssets: defaultAssets.keys,
        byCluster: {
          ...config.chain.byCluster,
          [config.chain.defaultCluster]: {
            ...config.chain.byCluster[config.chain.defaultCluster],
            assets: defaultAssets,
          },
        },
      };

  const effectiveConfig = {
    ...config,
    chain: chainConfig,
    risk: {
      ...config.risk,
      manualReviewAboveUsd: null,
      reviewNewDestinations: true,
      assetLimits: { ...config.risk.assetLimits, ...tokenAssetLimits },
      ...options.risk,
    },
    withdrawal: {
      ...config.withdrawal,
      ...(options.operatorUserIds === undefined
        ? {}
        : { operatorUserIds: options.operatorUserIds }),
      ...(options.segregatedCustody === undefined
        ? {}
        : { segregatedCustody: options.segregatedCustody }),
    },
  };

  const app = await buildServer({
    config: effectiveConfig,
    logger: logs.logger,
    db,
    redis,
    ...(options.chainAdapter !== undefined ? { chainAdapter: options.chainAdapter } : {}),
    /**
     * The suite normally injects a MockSigner, because most of what it tests —
     * the retry, timeout and expiry paths — needs a signer that can be made to
     * fail on demand.
     *
     * `USE_CONFIGURED_SIGNER=true` suppresses that injection so the server
     * builds whatever `SIGNER_KIND` names. That is what makes
     * prompt_phase4.md rule 67 checkable rather than assumed: the first run
     * against the real signer passed 111 tests without a single request
     * reaching the service, because every one of them had injected the mock.
     */
    ...(options.signer !== undefined && !usesConfiguredSigner() ? { signer: options.signer } : {}),
    ...(options.nonceManager !== undefined ? { nonceManager: options.nonceManager } : {}),
    ...(options.broadcaster !== undefined ? { broadcaster: options.broadcaster } : {}),
    ...(options.clusterOverrides !== undefined
      ? { clusterOverrides: options.clusterOverrides }
      : {}),
    // Tests drive the withdrawal workers by hand, so "what happened after N
    // cycles" is answerable rather than a race with a timer.
    startWithdrawalWorkers: false,
    startPricer: options.startPricer ?? false,
    // Tests drive `runOnce()` by hand. A timer-driven indexer would poll in the
    // background and make "what happened after N cycles" unanswerable.
    startIndexer: false,
    startReconciliation: false,
  });
  await app.ready();

  const createdUserIds: string[] = [];

  return {
    app,
    logs,
    createdUserIds,
    async cleanup() {
      if (createdUserIds.length > 0) {
        /**
         * A user with withdrawal history CANNOT be deleted, and that is the
         * system working.
         *
         * Deleting a user cascades to their withdrawals, which cascades to
         * `withdrawal_transitions` — and that table is append-only at the
         * database level, so the DELETE is refused. The same is true of
         * `ledger_entries`.
         *
         * So cleanup removes only the users who left no evidence behind. The
         * rest stay, which is the honest consequence of making history
         * undeletable: test data accumulates, and that is cheaper than a
         * ledger someone can quietly edit.
         */
        const withHistory = await db.withdrawal.findMany({
          where: { userId: { in: createdUserIds } },
          select: { userId: true },
          distinct: ['userId'],
        });

        /*
         * Operator grants protect a user too.
         *
         * `operator_roles` is append-mostly: the app role has no DELETE, and a
         * trigger refuses it regardless — because "who could approve
         * withdrawals in March" must stay answerable (rule 166). So a user who
         * was ever granted a role cannot be deleted by this application, which
         * is the same property withdrawals already had.
         */
        const withRoles = await db.operatorRole.findMany({
          where: { userId: { in: createdUserIds } },
          select: { userId: true },
          distinct: ['userId'],
        });

        const protectedIds = new Set([
          ...withHistory.map((row) => row.userId),
          ...withRoles.map((row) => row.userId),
        ]);
        const deletable = createdUserIds.filter((id) => !protectedIds.has(id));

        if (deletable.length > 0) {
          await db.deposit.deleteMany({ where: { userId: { in: deletable } } });
          await db.user.deleteMany({ where: { id: { in: deletable } } });
        }
      }
      await app.close();
      await db.$disconnect();
      redis.disconnect();
    },
  };
}

/**
 * Same-origin headers — the shape a real browser sends.
 *
 * Deliberately no content-type: Fastify sets it when a payload is present, and
 * declaring application/json on a bodyless request makes Fastify reject it as
 * an empty JSON body before any guard runs.
 */
export function browserHeaders(cookie?: string): Record<string, string> {
  return {
    origin: WEB_ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...(cookie !== undefined ? { cookie } : {}),
  };
}

/**
 * Creates a user and a live session directly through the app's own dependency
 * graph, bypassing the WebAuthn ceremony.
 *
 * Justified because the full ceremony needs a real authenticator and is covered
 * by the Playwright E2E suite with a CDP virtual authenticator. What these
 * tests are about is what happens AFTER authentication — guards, step-up,
 * ownership scoping, the error contract.
 */
export async function seedSession(
  harness: Harness,
  options: { steppedUp?: boolean } = {},
): Promise<{ userId: string; sessionId: string; cookie: string; cookieName: string }> {
  const deps = harness.app.appDeps;
  const user = await deps.users.create({ email: `${newId()}@example.test`, displayName: 'Test' });
  harness.createdUserIds.push(user.id);

  const issued = await deps.sessions.issue({
    userId: user.id,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    ...(options.steppedUp === true ? { steppedUp: true } : {}),
  });

  const cookieName = process.env.SESSION_COOKIE_NAME ?? 'wallet_session';
  return {
    userId: user.id,
    sessionId: issued.session.id,
    cookie: `${cookieName}=${issued.token}`,
    cookieName,
  };
}

export { loadApiConfigOrExit };

/** Gives a seeded user a wallet and one deposit address. */
export async function seedDepositAddress(
  harness: Harness,
  userId: string,
): Promise<{ walletId: string; addressId: string; address: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/wallets/addresses',
    headers: browserHeaders(await cookieFor(harness, userId)),
  });
  if (response.statusCode !== 200) {
    throw new Error(`could not create deposit address: ${response.body}`);
  }
  const body = response.json() as { walletId: string; address: { id: string; address: string } };
  return { walletId: body.walletId, addressId: body.address.id, address: body.address.address };
}

async function cookieFor(harness: Harness, userId: string): Promise<string> {
  const issued = await harness.app.appDeps.sessions.issue({ userId, ip: '127.0.0.1' });
  const cookieName = process.env.SESSION_COOKIE_NAME ?? 'wallet_session';
  return `${cookieName}=${issued.token}`;
}

export { cookieFor };

/**
 * Credit a user directly through the ledger, so a withdrawal test does not have
 * to run the whole deposit pipeline to have a balance.
 */
export async function creditUser(
  harness: Harness,
  userId: string,
  asset: string,
  amount: string,
): Promise<void> {
  const { createLedgerRepository, withTransaction, newId } = await import('@wallet/db');
  const ledger = createLedgerRepository(harness.app.appDeps.db);

  // Segregated: the funds sit at THIS user's own address (ADR-0020), so the
  // test fixture must post them there. Crediting the pooled account would make
  // every per-user reconciliation test read zero and pass for the wrong reason.
  await ledger.ensureAccounts([
    { ownerId: userId, asset, type: 'chain_assets' },
    { ownerId: userId, asset, type: 'user_custody_available' },
  ]);

  await withTransaction(harness.app.appDeps.db, async (tx) =>
    createLedgerRepository(tx).postTransaction(
      {
        kind: 'deposit',
        referenceType: 'test-credit',
        referenceId: newId(),
        entries: [
          {
            account: { ownerId: userId, asset, type: 'chain_assets' },
            asset,
            amount,
            direction: 'debit',
          },
          {
            account: { ownerId: userId, asset, type: 'user_custody_available' },
            asset,
            amount,
            direction: 'credit',
          },
        ],
      },
      tx,
    ),
  );
}

/**
 * Credit a user AT A CHOSEN INSTANT.
 *
 * `creditUser` stamps `now()`, which is correct for every test about a
 * balance and useless for one about history: a chart of the last 24 hours
 * needs entries that are actually 24 hours old. Written through raw SQL
 * because the repository deliberately offers no way to backdate an entry —
 * that is a fixture's privilege, not the application's.
 *
 * Still a BALANCED transaction: the deferred trigger checks it at commit like
 * any other, so a fixture cannot write books that do not balance.
 */
export async function creditUserAt(
  harness: Harness,
  userId: string,
  asset: string,
  amount: string,
  at: Date,
): Promise<void> {
  const { createLedgerRepository, newId } = await import('@wallet/db');
  const ledger = createLedgerRepository(harness.app.appDeps.db);

  await ledger.ensureAccounts([
    { ownerId: userId, asset, type: 'chain_assets' },
    { ownerId: userId, asset, type: 'user_custody_available' },
  ]);

  const db = harness.app.appDeps.db;
  const transactionId = newId();

  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO ledger_transactions (id, kind, reference_type, reference_id, created_at)
       VALUES ($1::uuid, 'deposit'::"LedgerTransactionKind", 'test-backdated', $2, $3)`,
      transactionId,
      newId(),
      at,
    );

    for (const [type, direction] of [
      ['chain_assets', 'debit'],
      ['user_custody_available', 'credit'],
    ] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_entries
           (id, transaction_id, account_id, asset, amount, direction, created_at)
         SELECT $1::uuid, $2::uuid, a.id, $3, $4::numeric, $5::"EntryDirection", $6
           FROM ledger_accounts a
          WHERE a.owner_id = $7::uuid AND a.asset = $3 AND a.type = $8::"LedgerAccountType"`,
        newId(),
        transactionId,
        asset,
        amount,
        direction,
        at,
        userId,
        type,
      );
    }
  });
}

/** Fund the house so network fees are not paid from customer money. */
export async function fundHouse(harness: Harness, asset: string, amount: string): Promise<void> {
  const { createLedgerRepository, withTransaction, newId } = await import('@wallet/db');
  const ledger = createLedgerRepository(harness.app.appDeps.db);

  await ledger.ensureAccounts([
    { ownerId: null, asset, type: 'chain_assets' },
    { ownerId: null, asset, type: 'house_fees' },
  ]);

  await withTransaction(harness.app.appDeps.db, async (tx) =>
    createLedgerRepository(tx).postTransaction(
      {
        kind: 'fee',
        referenceType: 'house_funding',
        referenceId: newId(),
        entries: [
          {
            account: { ownerId: null, asset, type: 'chain_assets' },
            asset,
            amount,
            direction: 'debit',
          },
          {
            account: { ownerId: null, asset, type: 'house_fees' },
            asset,
            amount,
            direction: 'credit',
          },
        ],
      },
      tx,
    ),
  );
}

/** A session that has just stepped up, as a withdrawal requires. */
export async function seedSteppedUpSession(
  harness: Harness,
): Promise<{ userId: string; cookie: string; sessionId: string }> {
  const session = await seedSession(harness, { steppedUp: true });
  return { userId: session.userId, cookie: session.cookie, sessionId: session.sessionId };
}

/** Provision nonce accounts so the signer has something to lease. */
export async function seedNonceAccounts(
  harness: Harness,
  nonces: { provision: (address: string, nonce: string) => void },
  count = 3,
): Promise<string[]> {
  const { createNonceAccountRepository } = await import('@wallet/db');
  const repo = createNonceAccountRepository(harness.app.appDeps.db);
  const addresses: string[] = [];

  /**
   * Park any withdrawal left mid-flight by an earlier run.
   *
   * The worker processes a bounded batch, and every run leaves withdrawals in
   * BROADCAST that nothing will ever finalize. They accumulate across runs
   * until they fill the batch, at which point a cycle appears to do nothing and
   * the failure looks like a worker bug rather than stale data.
   *
   * Moved to a terminal state rather than deleted, because the transition
   * history is append-only and deleting the withdrawal would orphan it.
   */
  await harness.app.appDeps.db.withdrawal.updateMany({
    where: { status: { in: ['BROADCAST', 'SIGNED', 'SIGNING', 'CONFIRMED'] } },
    data: { status: 'FAILED', failureReason: 'abandoned by an earlier test run' },
  });

  // Clear the pool first.
  //
  // Rows survive between runs, and the lease picks the least-recently-used
  // account — so a stale row from a previous run, whose address THIS fake has
  // never heard of, gets leased before any freshly seeded one. The worker then
  // fails with "nonce account has no on-chain state", which is the correct
  // behaviour and a completely misleading test failure.
  await harness.app.appDeps.db.withdrawal.updateMany({ data: { nonceAccountId: null } });
  await harness.app.appDeps.db.nonceAccount.deleteMany({});

  // Real keypairs, because the transaction builder decodes these as base58 and
  // a made-up string fails there rather than in the test that means to fail.
  const { Keypair } = await import('@solana/web3.js');

  for (let i = 0; i < count; i += 1) {
    const address = Keypair.generate().publicKey.toBase58();
    const nonce = Keypair.generate().publicKey.toBase58();
    await repo.create({ chain: TEST_CHAIN, address, currentNonce: nonce });
    nonces.provision(address, nonce);
    addresses.push(address);
  }
  return addresses;
}

/**
 * Give a user genuine history with a destination.
 *
 * `listPriorDestinations` counts only SETTLED, CONFIRMED, and BROADCAST
 * withdrawals — a withdrawal sitting in review has not been *sent* anywhere, so
 * it must not make a destination familiar. That means a test cannot establish
 * history by submitting; it has to seed a completed one, which is what this
 * does.
 */
export async function markDestinationKnown(
  harness: Harness,
  userId: string,
  asset: string,
  destination: string,
): Promise<void> {
  const { newId } = await import('@wallet/db');
  await harness.app.appDeps.db.$executeRawUnsafe(
    `INSERT INTO withdrawals
       (id, user_id, chain, asset, amount, destination, status, idempotency_key, created_at, updated_at, settled_at)
     VALUES (gen_random_uuid(), $1::uuid, $5, $2, 1, $3,
             'SETTLED'::"WithdrawalStatus", $4, now() - interval '1 day',
             now() - interval '1 day', now() - interval '1 day')`,
    userId,
    asset,
    destination,
    `history-${newId()}`,
    TEST_CHAIN,
  );
}
