import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSigner } from '@wallet/blockchain';
import { createPriceRepository, createRiskDecisionRepository } from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import { createFakeBroadcaster, createFakeNonceManager } from './fake-withdrawal-chain.js';
import {
  browserHeaders,
  creditUser,
  fundHouse,
  seedNonceAccounts,
  seedSession,
  SOL_KEY,
  startHarness,
  TEST_CLUSTER,
  type Harness,
  type HarnessOptions,
} from './helpers.js';

/**
 * Value-based review (ADR-0024), end to end through the API.
 *
 * The policy under test: a withdrawal worth more than $1,000 at the latest
 * recorded price waits for an operator; one worth less that passes every hard
 * check is approved and locked by code — including to a first-time
 * destination. An asset with no fresh price is reviewed.
 */

const ONE_SOL = 1_000_000_000n;
const SOL = (n: bigint): string => (n * ONE_SOL).toString();
const DEST = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

let counter = 0;
const nextKey = (): string => `value-${Date.now()}-${(counter += 1)}`;

async function setup(options: HarnessOptions) {
  const nonces = createFakeNonceManager();
  const harness = await startHarness({
    nonceManager: nonces,
    broadcaster: createFakeBroadcaster(),
    signer: createMockSigner({ onBanner: () => undefined }),
    ...options,
  });
  await fundHouse(harness, SOL_KEY, SOL(10n));
  await seedNonceAccounts(harness, nonces, 3);
  return harness;
}

async function fundedUser(harness: Harness): Promise<string> {
  const session = await seedSession(harness, { steppedUp: true });
  await creditUser(harness, session.userId, SOL_KEY, SOL(100n));
  return session.cookie;
}

async function submit(harness: Harness, cookie: string, amount: string) {
  return harness.app.inject({
    method: 'POST',
    url: '/withdrawals',
    headers: browserHeaders(cookie),
    payload: { asset: NATIVE_ASSET, amount, destination: DEST, idempotencyKey: nextKey() },
  });
}

/** SOL at $100, recorded now, so it is the latest tick the valuation reads. */
async function priceSolAt100(harness: Harness): Promise<void> {
  await createPriceRepository(harness.app.appDeps.db).record([
    { cluster: TEST_CLUSTER, asset: NATIVE_ASSET, priceUsd: '100.000000', source: 'test' },
  ]);
}

describe('value-based review with a fresh price', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setup({ risk: { manualReviewAboveUsd: '1000', reviewNewDestinations: false } });
  });
  afterAll(async () => h.cleanup());

  it('auto-approves and locks a small withdrawal to a first-time destination', async () => {
    const cookie = await fundedUser(h);
    await priceSolAt100(h);

    // 5 SOL × $100 = $500.
    const response = await submit(h, cookie, SOL(5n));
    expect(response.json().withdrawal.status).toBe('FUNDS_LOCKED');
  });

  it('approves exactly $1,000 — the threshold is strictly greater than', async () => {
    const cookie = await fundedUser(h);
    await priceSolAt100(h);

    const response = await submit(h, cookie, SOL(10n));
    expect(response.json().withdrawal.status).toBe('FUNDS_LOCKED');
  });

  it('sends a withdrawal worth more than $1,000 to manual review', async () => {
    const cookie = await fundedUser(h);
    await priceSolAt100(h);

    // 15 SOL × $100 = $1,500.
    const response = await submit(h, cookie, SOL(15n));
    const { withdrawal } = response.json();
    expect(withdrawal.status).toBe('MANUAL_REVIEW');

    const decision = await createRiskDecisionRepository(h.app.appDeps.db).findByWithdrawal(
      withdrawal.id,
    );
    expect(decision?.codes).toContain('USD_REVIEW_THRESHOLD');
  });

  it('still rejects an auto-approvable amount the user cannot cover', async () => {
    const session = await seedSession(h, { steppedUp: true });
    await creditUser(h, session.userId, SOL_KEY, SOL(1n));
    await priceSolAt100(h);

    const response = await submit(h, session.cookie, SOL(5n));
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('value-based review with no fresh price', () => {
  let h: Harness;

  beforeAll(async () => {
    // A one-second freshness window, so every tick already written is stale.
    h = await setup({
      risk: { manualReviewAboveUsd: '1000', reviewNewDestinations: false, priceMaxAgeSeconds: 1 },
    });
  });
  afterAll(async () => h.cleanup());

  it('reviews rather than auto-approves when the value is unknown', async () => {
    const cookie = await fundedUser(h);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const response = await submit(h, cookie, SOL(1n));
    const { withdrawal } = response.json();
    expect(withdrawal.status).toBe('MANUAL_REVIEW');

    const decision = await createRiskDecisionRepository(h.app.appDeps.db).findByWithdrawal(
      withdrawal.id,
    );
    expect(decision?.codes).toContain('VALUE_UNPRICED');
  });
});
