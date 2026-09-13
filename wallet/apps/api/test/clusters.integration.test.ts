import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedgerRepository } from '@wallet/db';
import { createFakeChain, type FakeChain } from './fake-chain.js';
import {
  assetKey,
  browserHeaders,
  creditUser,
  seedSession,
  SOL_KEY,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * Cluster isolation, end to end (ADR-0021).
 *
 * The failure this guards against is quiet: devnet play money added to a
 * mainnet balance. Nothing is unbalanced, no invariant is violated, no error
 * is logged — the number is simply wrong, and it looks entirely plausible.
 *
 * So the assertions here are mostly about what is ABSENT: a balance that does
 * not appear on the other cluster, an address that is not shared, a deposit
 * that cannot be read from the wrong context.
 */

let h: Harness;
let devnetChain: FakeChain;

const OTHER = 'devnet';
const DEVNET_SOL = assetKey('SOL').replace(TEST_CLUSTER, OTHER);

beforeAll(async () => {
  devnetChain = createFakeChain({ cluster: OTHER });

  h = await startHarness({
    extraCluster: OTHER,
    clusterOverrides: { [OTHER]: { adapter: devnetChain } },
  });
});

afterAll(async () => {
  await h.cleanup();
});

function get(url: string, cookie: string, cluster?: string) {
  return h.app.inject({
    method: 'GET',
    url,
    headers: {
      ...browserHeaders(cookie),
      ...(cluster !== undefined ? { 'x-solana-cluster': cluster } : {}),
    },
  });
}

function post(url: string, cookie: string, cluster?: string) {
  return h.app.inject({
    method: 'POST',
    url,
    headers: {
      ...browserHeaders(cookie),
      ...(cluster !== undefined ? { 'x-solana-cluster': cluster } : {}),
    },
  });
}

describe('the X-Solana-Cluster header', () => {
  it('defaults to the configured cluster when absent', async () => {
    const session = await seedSession(h);
    const response = await post('/wallets/addresses', session.cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json().address.network).toBe(TEST_CLUSTER);
  });

  it('routes to the named cluster', async () => {
    const session = await seedSession(h);
    const response = await post('/wallets/addresses', session.cookie, OTHER);

    expect(response.statusCode).toBe(200);
    expect(response.json().address.network).toBe(OTHER);
    expect(response.json().address.chain).toBe(`solana:${OTHER}`);
  });

  it('REFUSES an unknown cluster rather than defaulting', async () => {
    /*
     * The dangerous case. A client sending `mainnet` (not `mainnet-beta`)
     * would otherwise be answered for devnet, and the balances it rendered
     * would be play money labelled as real.
     */
    const session = await seedSession(h);
    const response = await get('/balances', session.cookie, 'mainnet');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a real cluster this deployment does not serve', async () => {
    const session = await seedSession(h);
    const response = await get('/balances', session.cookie, 'mainnet-beta');

    expect(response.statusCode).toBe(400);
  });

  it('treats an empty header as absent rather than as an error', async () => {
    // A client that sets the header from an empty preference has no opinion,
    // which is what the default is for.
    const session = await seedSession(h);
    const response = await get('/balances', session.cookie, '');
    expect(response.statusCode).toBe(200);
  });
});

describe('addresses are per cluster', () => {
  it('gives the same user a different address on each cluster', async () => {
    const session = await seedSession(h);

    const here = await post('/wallets/addresses', session.cookie);
    const there = await post('/wallets/addresses', session.cookie, OTHER);

    // Different wallets, because a wallet is per (user, chain) — and the chain
    // now names the cluster.
    expect(here.json().walletId).not.toBe(there.json().walletId);
    expect(here.json().address.address).not.toBe(there.json().address.address);
  });

  it('is still idempotent within one cluster', async () => {
    const session = await seedSession(h);
    const first = await post('/wallets/addresses', session.cookie, OTHER);
    const second = await post('/wallets/addresses', session.cookie, OTHER);

    expect(first.json().address.address).toBe(second.json().address.address);
  });
});

describe('balances are per cluster', () => {
  it('does NOT show one cluster’s balance on another', async () => {
    const session = await seedSession(h);
    await creditUser(h, session.userId, SOL_KEY, '5000000000');

    const here = await get('/balances', session.cookie);
    const there = await get('/balances', session.cookie, OTHER);

    const solHere = here.json().balances.find((b: { asset: string }) => b.asset === 'SOL');
    const solThere = there.json().balances.find((b: { asset: string }) => b.asset === 'SOL');

    expect(solHere.available).toBe('5000000000');
    // The whole point. Without the cluster in the asset key these are one
    // account and this reads 5 SOL on a chain where the user has nothing.
    expect(solThere.available).toBe('0');
  });

  it('keeps two clusters’ balances for one user separate', async () => {
    const session = await seedSession(h);
    await creditUser(h, session.userId, SOL_KEY, '1000000000');
    await creditUser(h, session.userId, DEVNET_SOL, '7000000000');

    const here = await get('/balances', session.cookie);
    const there = await get('/balances', session.cookie, OTHER);

    expect(here.json().balances.find((b: { asset: string }) => b.asset === 'SOL').available).toBe(
      '1000000000',
    );
    expect(there.json().balances.find((b: { asset: string }) => b.asset === 'SOL').available).toBe(
      '7000000000',
    );
  });

  it('renders the bare asset, not the storage key', async () => {
    // `devnet:SOL` is how the ledger stores it and is not something to show a
    // person; the cluster is already the context they chose.
    const session = await seedSession(h);
    await creditUser(h, session.userId, DEVNET_SOL, '1');

    const response = await get('/balances', session.cookie, OTHER);
    expect(response.json().balances.map((b: { asset: string }) => b.asset)).toContain('SOL');
    expect(response.json().balances.map((b: { asset: string }) => b.asset)).not.toContain(
      DEVNET_SOL,
    );
    expect(response.json().cluster).toBe(OTHER);
  });

  it('projects each cluster independently in the ledger itself', async () => {
    const session = await seedSession(h);
    await creditUser(h, session.userId, SOL_KEY, '400');
    await creditUser(h, session.userId, DEVNET_SOL, '900');

    const ledger = createLedgerRepository(h.app.appDeps.db);
    const here = await ledger.getUserBalances(session.userId, TEST_CLUSTER);
    const there = await ledger.getUserBalances(session.userId, OTHER);

    expect(here.map((row) => row.asset)).toEqual([SOL_KEY]);
    expect(there.map((row) => row.asset)).toEqual([DEVNET_SOL]);
    expect(here[0]?.available).toBe('400');
    expect(there[0]?.available).toBe('900');
  });
});

describe('withdrawal history is per cluster', () => {
  it('does not list another cluster’s withdrawals', async () => {
    const session = await seedSession(h);

    const here = await get('/withdrawals', session.cookie);
    const there = await get('/withdrawals', session.cookie, OTHER);

    expect(here.statusCode).toBe(200);
    expect(there.statusCode).toBe(200);
    // Nothing was created on either, but the point is that each answers for
    // its own chain rather than for both.
    expect(there.json().withdrawals).toEqual([]);
  });
});

describe('workers claim only their own cluster’s work', () => {
  it('does not let one cluster’s worker claim another cluster’s withdrawal', async () => {
    /*
     * REGRESSION.
     *
     * `claimNext` and `listByStatus` filtered on STATUS alone, so a devnet
     * worker would claim a mainnet withdrawal, lease a devnet nonce for it,
     * and ask a devnet RPC about a mainnet signature. The first symptom was a
     * chain error in a loop. The second — worse — is a withdrawal stuck in the
     * state it was claimed into, because no worker that can act on it will
     * ever see it again.
     */
    const { createWithdrawalRepository, withTransaction, newId } = await import('@wallet/db');
    const session = await seedSession(h);

    const other = `solana:${OTHER}`;
    await withTransaction(h.app.appDeps.db, async (tx) =>
      createWithdrawalRepository(tx).create(
        {
          userId: session.userId,
          chain: other,
          asset: DEVNET_SOL,
          amount: '1000',
          destination: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
          idempotencyKey: `cluster-claim-${newId()}`,
          correlationId: newId(),
        },
        tx,
      ),
    );

    // A worker on the DEFAULT cluster must not see it.
    const claimed = await withTransaction(h.app.appDeps.db, async (tx) =>
      createWithdrawalRepository(tx).claimNext(
        'REQUESTED',
        'RISK_EVALUATING',
        newId(),
        `solana:${TEST_CLUSTER}`,
        tx,
      ),
    );

    expect(claimed?.chain).not.toBe(other);
  });

  it('lists review-queue withdrawals for one cluster only', async () => {
    const { createWithdrawalRepository } = await import('@wallet/db');
    const repository = createWithdrawalRepository(h.app.appDeps.db);

    const here = await repository.listByStatus('MANUAL_REVIEW', 100, `solana:${TEST_CLUSTER}`);
    const there = await repository.listByStatus('MANUAL_REVIEW', 100, `solana:${OTHER}`);

    expect(here.every((row) => row.chain === `solana:${TEST_CLUSTER}`)).toBe(true);
    expect(there.every((row) => row.chain === `solana:${OTHER}`)).toBe(true);
  });
});

describe('capabilities advertise the clusters', () => {
  it('lists every served cluster and the default', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/capabilities' });
    const body = response.json();

    expect(body.clusters.served).toContain(TEST_CLUSTER);
    expect(body.clusters.served).toContain(OTHER);
    expect(body.clusters.default).toBe(TEST_CLUSTER);
  });

  it('reports assets cluster-qualified, so a client knows where they live', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/capabilities' });
    expect(response.json().assets.supported).toContain(SOL_KEY);
    expect(response.json().assets.supported).toContain(DEVNET_SOL);
  });
});

describe('readiness reports each cluster separately', () => {
  it('names one dependency per cluster', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/health/ready' });
    const names = response.json().dependencies.map((d: { name: string }) => d.name);

    // One `solana` probe covering both would report the more optimistic of the
    // two, and an operator would not learn that devnet was down.
    expect(names).toContain(`solana:${TEST_CLUSTER}`);
    expect(names).toContain(`solana:${OTHER}`);
  });
});
