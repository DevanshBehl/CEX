import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedgerRepository } from '@wallet/db';
import { createReconciliationService } from '../src/services/reconciliation.service.js';
import {
  creditUser,
  seedSession,
  startHarness,
  SOL_KEY,
  TEST_CHAIN,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * Segregated custody, end to end (ADR-0020).
 *
 * The property under test is the one the whole model exists for: each user's
 * funds are identifiable, exclusively theirs, and reconcilable against their
 * own address — not against a pool.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.cleanup();
});

/** A chain reader returning balances we control, per address. */
function reader(balances: Record<string, string>) {
  return {
    chain: TEST_CHAIN,
    validator: { isValid: () => true, isSignable: () => true } as never,
    async getBalance(address: string) {
      return balances[address] ?? '0';
    },
    async getMinimumAccountBalance() {
      return '0';
    },
    async getConfirmation() {
      return 'final' as const;
    },
    async getPosition() {
      return 0n;
    },
    async accountExists() {
      return true;
    },
    async getNetworkIdentity() {
      return 'fake';
    },
    async isHealthy() {
      return true;
    },
  };
}

function reconciler(balances: Record<string, string>) {
  return createReconciliationService({
    db: h.app.appDeps.db,
    reader: reader(balances) as never,
    chain: TEST_CHAIN,
    cluster: TEST_CLUSTER,
    logger: h.logs.logger,
    platformAddresses: [],
  });
}

async function userWithAddress() {
  const session = await seedSession(h);
  const response = await h.app.inject({
    method: 'POST',
    url: '/wallets/addresses',
    headers: {
      cookie: session.cookie,
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    },
  });
  const body = response.json() as { address: { address: string } };
  return { userId: session.userId, address: body.address.address };
}

describe('segregated positions', () => {
  it('gives each user their own on-chain account, never a pool', async () => {
    const alice = await userWithAddress();
    const bob = await userWithAddress();
    await creditUser(h, alice.userId, SOL_KEY, '5000000000');
    await creditUser(h, bob.userId, SOL_KEY, '3000000000');

    const positions = await createLedgerRepository(h.app.appDeps.db).getSegregatedPositions(
      TEST_CLUSTER,
    );
    const forAlice = positions.find((p) => p.ownerId === alice.userId && p.asset === SOL_KEY);
    const forBob = positions.find((p) => p.ownerId === bob.userId && p.asset === SOL_KEY);

    expect(forAlice?.chainAssets).toBe('5000000000');
    expect(forBob?.chainAssets).toBe('3000000000');
    // And each user's on-chain position equals what they are owed.
    expect(forAlice?.liability).toBe('5000000000');
    expect(forBob?.liability).toBe('3000000000');
  });

  it('CATCHES A PER-USER DIVERGENCE THE AGGREGATE CANNOT SEE', async () => {
    /*
     * The reason per-user reconciliation exists.
     *
     * One user is short by exactly what another is long. The TOTAL on-chain
     * balance matches the TOTAL ledger position perfectly, so the aggregate
     * check reports a clean bill of health — while one user's money is
     * somewhere it should not be. That is the failure segregation is meant to
     * prevent, and only the per-user comparison sees it.
     */
    const alice = await userWithAddress();
    const bob = await userWithAddress();
    await creditUser(h, alice.userId, SOL_KEY, '5000000000');
    await creditUser(h, bob.userId, SOL_KEY, '3000000000');

    const report = await reconciler({
      [alice.address]: '4000000000', // 1 SOL short
      [bob.address]: '4000000000', // 1 SOL long
    }).run();

    const aliceResult = report.users.find((u) => u.userId === alice.userId && u.asset === SOL_KEY);
    const bobResult = report.users.find((u) => u.userId === bob.userId && u.asset === SOL_KEY);

    expect(aliceResult?.diverged).toBe(true);
    expect(bobResult?.diverged).toBe(true);
    expect(aliceResult?.residual).toBe('-1000000000');
    expect(bobResult?.residual).toBe('1000000000');
    expect(report.divergedUsers).toBeGreaterThanOrEqual(2);
    expect(report.healthy).toBe(false);
  });

  it('reports healthy when every user matches their own address', async () => {
    const alice = await userWithAddress();
    await creditUser(h, alice.userId, SOL_KEY, '2000000000');

    const report = await reconciler({ [alice.address]: '2000000000' }).run();
    const result = report.users.find((u) => u.userId === alice.userId && u.asset === SOL_KEY);

    expect(result?.diverged).toBe(false);
    expect(result?.residual).toBe('0');
  });

  it('does not call an unreadable address a divergence', async () => {
    // An RPC failure is an incomplete reading, not evidence that funds are
    // missing. Paging someone at 3am for a timeout destroys the alert.
    const alice = await userWithAddress();
    await creditUser(h, alice.userId, SOL_KEY, '2000000000');

    const failing = createReconciliationService({
      db: h.app.appDeps.db,
      reader: {
        ...reader({}),
        async getBalance() {
          throw new Error('rpc down');
        },
      } as never,
      chain: TEST_CHAIN,
      cluster: TEST_CLUSTER,
      logger: h.logs.logger,
      platformAddresses: [],
    });

    const report = await failing.run();
    const result = report.users.find((u) => u.userId === alice.userId && u.asset === SOL_KEY);

    expect(result?.diverged).toBe(false);
    expect(result?.addressesChecked).toBe(0);
  });

  it('logs a critical event naming no user and no amount', async () => {
    const alice = await userWithAddress();
    await creditUser(h, alice.userId, SOL_KEY, '9000000000');
    h.logs.clear();

    await reconciler({ [alice.address]: '1' }).run();

    const text = h.logs.text();
    expect(text).toContain('reconciliation.user_diverged');
    // A count, never the identity or the size of the gap — those are in the
    // report, which an operator reads deliberately.
    expect(text).not.toContain(alice.userId);
    expect(text).not.toContain('9000000000');
  });
});
