import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { loadApiConfigOrExit, parseEnv, toApiConfig } from '@wallet/config';
import type { ChainAdapter, Signer } from '@wallet/blockchain';
import type { NonceManager, WithdrawalBroadcaster } from '@wallet/solana';
import { createPrismaClient, newId } from '@wallet/db';
import { createCapturingLogger, type CapturedLogger } from '@wallet/logger';
import { buildServer } from '../src/server.js';

export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

export interface Harness {
  app: FastifyInstance;
  logs: CapturedLogger;
  cleanup: () => Promise<void>;
  createdUserIds: string[];
}

export interface HarnessOptions {
  chainAdapter?: ChainAdapter;
  signer?: Signer;
  nonceManager?: NonceManager;
  broadcaster?: WithdrawalBroadcaster;
  operatorUserIds?: string[];
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = toApiConfig(parseEnv(process.env));
  const logs = createCapturingLogger('trace');
  const db = createPrismaClient({ url: config.database.url });
  const redis = new Redis(config.redis.url, { maxRetriesPerRequest: 3 });

  const effectiveConfig =
    options.operatorUserIds === undefined
      ? config
      : {
          ...config,
          withdrawal: { ...config.withdrawal, operatorUserIds: options.operatorUserIds },
        };

  const app = await buildServer({
    config: effectiveConfig,
    logger: logs.logger,
    db,
    redis,
    ...(options.chainAdapter !== undefined ? { chainAdapter: options.chainAdapter } : {}),
    ...(options.signer !== undefined ? { signer: options.signer } : {}),
    ...(options.nonceManager !== undefined ? { nonceManager: options.nonceManager } : {}),
    ...(options.broadcaster !== undefined ? { broadcaster: options.broadcaster } : {}),
    // Tests drive the withdrawal workers by hand, so "what happened after N
    // cycles" is answerable rather than a race with a timer.
    startWithdrawalWorkers: false,
    // Tests drive `runOnce()` by hand. A timer-driven indexer would poll in the
    // background and make "what happened after N cycles" unanswerable.
    startIndexer: false,
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
        const protectedIds = new Set(withHistory.map((row) => row.userId));
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

  await ledger.ensureAccounts([
    { ownerId: null, asset, type: 'chain_assets' },
    { ownerId: userId, asset, type: 'user_available' },
  ]);

  await withTransaction(harness.app.appDeps.db, async (tx) =>
    createLedgerRepository(tx).postTransaction(
      {
        kind: 'deposit',
        referenceType: 'test-credit',
        referenceId: newId(),
        entries: [
          {
            account: { ownerId: null, asset, type: 'chain_assets' },
            asset,
            amount,
            direction: 'debit',
          },
          {
            account: { ownerId: userId, asset, type: 'user_available' },
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
    await repo.create({ chain: 'solana', address, currentNonce: nonce });
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
     VALUES (gen_random_uuid(), $1::uuid, 'solana', $2, 1, $3,
             'SETTLED'::"WithdrawalStatus", $4, now() - interval '1 day',
             now() - interval '1 day', now() - interval '1 day')`,
    userId,
    asset,
    destination,
    `history-${newId()}`,
  );
}
