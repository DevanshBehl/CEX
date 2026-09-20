import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSigner } from '@wallet/blockchain';
import { createLedgerRepository, createWithdrawalRepository } from '@wallet/db';
import { checkBooksBalance } from '@wallet/ledger';
import { createFakeBroadcaster, createFakeNonceManager } from './fake-withdrawal-chain.js';
import {
  assetKey,
  browserHeaders,
  creditUser,
  fundHouse,
  seedNonceAccounts,
  seedSession,
  SOL_KEY,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * Sending a TOKEN, end to end (ADR-0016, ADR-0024).
 *
 * The platform could credit USDC from the first day tokens existed and could
 * not send it, which is the worst shape a gap can take in a wallet: the
 * balance is real, it is yours, and there is no way out of it.
 *
 * The transaction builder was never the missing piece — `buildTokenTransfer`
 * has existed and the signing worker has branched on `isToken` for as long as
 * the allowlist has. What was missing was everything AROUND it, and this suite
 * is the parts that are easy to leave SOL-shaped:
 *
 *   - decimals: six here against SOL's nine, so anything that assumes nine is
 *     out by a thousand;
 *   - the asset key: a 44-character mint, not a three-letter symbol;
 *   - the FEE: paid in SOL by the house, for a withdrawal denominated in USDC.
 *     One settlement posting, two assets. Every other settlement test uses SOL
 *     for both, which is exactly why the fee carried the mint unnoticed.
 */

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_KEY = assetKey(MINT);
const USDC_ONE = 1_000_000n;
const USDC = (n: bigint): string => (n * USDC_ONE).toString();
const ONE_SOL = 1_000_000_000n;
const SOL = (n: bigint): string => (n * ONE_SOL).toString();
const DEST = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

let h: Harness;
const broadcaster = createFakeBroadcaster();
let counter = 0;
const nextKey = (): string => `token-${Date.now()}-${(counter += 1)}`;

beforeAll(async () => {
  const nonces = createFakeNonceManager();
  h = await startHarness({
    nonceManager: nonces,
    broadcaster,
    signer: createMockSigner({ onBanner: () => undefined }),
    tokens: [
      {
        symbol: 'USDC',
        mint: MINT,
        decimals: 6,
        // In USDC's OWN base units. 10,000 / 50,000 / 5,000 USDC.
        perTransactionLimit: USDC(10_000n),
        dailyLimit: USDC(50_000n),
        manualReviewAbove: USDC(5_000n),
      },
    ],
    // Reviewed by value, so a routine token transfer is approved by code.
    risk: { manualReviewAboveUsd: '5000', reviewNewDestinations: false },
  });
  // The house pays every network fee, and pays it in SOL.
  await fundHouse(h, SOL_KEY, SOL(50n));
  await seedNonceAccounts(h, nonces, 30);
});

afterAll(async () => h.cleanup());

const withdrawals = () => createWithdrawalRepository(h.app.appDeps.db);
const ledger = () => createLedgerRepository(h.app.appDeps.db);

async function seedPrices(): Promise<void> {
  const { createPriceRepository } = await import('@wallet/db');
  await createPriceRepository(h.app.appDeps.db).record([
    // A dollar a token, so a USDC amount and its USD value are the same
    // number and the threshold assertions read plainly.
    { cluster: TEST_CLUSTER, asset: MINT, priceUsd: '1.000000', source: 'test' },
  ]);
}

async function submit(cookie: string, amount: string, asset = MINT) {
  return h.app.inject({
    method: 'POST',
    url: '/withdrawals',
    headers: browserHeaders(cookie),
    payload: { asset, amount, destination: DEST, idempotencyKey: nextKey() },
  });
}

/** A user holding USDC and no SOL at all — the case that must still work. */
async function tokenOnlyUser(amount = USDC(20_000n)) {
  const session = await seedSession(h, { steppedUp: true });
  await creditUser(h, session.userId, USDC_KEY, amount);
  return session;
}

async function allEntries() {
  const rows = await h.app.appDeps.db.$queryRawUnsafe<
    Array<{ asset: string; amount: string; direction: string; type: string; owner: string | null }>
  >(`SELECT e.asset, e.amount::text AS amount, e.direction::text AS direction,
            a.type::text AS type, a.owner_id::text AS owner
     FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id`);

  return rows.map((row) => ({
    account: { ownerId: row.owner, asset: row.asset, type: row.type as never },
    asset: row.asset,
    amount: BigInt(row.amount),
    direction: row.direction as 'debit' | 'credit',
  }));
}

describe('requesting a token withdrawal', () => {
  it("accepts a mint as the asset and locks the user's tokens", async () => {
    await seedPrices();
    const session = await tokenOnlyUser();

    const response = await submit(session.cookie, USDC(100n));
    const { withdrawal } = response.json();

    expect(withdrawal.status).toBe('FUNDS_LOCKED');
    // The wire carries the BARE mint, not the cluster-qualified storage key.
    expect(withdrawal.asset).toBe(MINT);
    // ...and the ticker beside it, so no interface has to join a mint against
    // a second endpoint to render it.
    expect(withdrawal.symbol).toBe('USDC');
    expect(withdrawal.decimals).toBe(6);

    const balance = await ledger().getUserBalance(session.userId, USDC_KEY);
    expect(BigInt(balance.locked)).toBe(BigInt(USDC(100n)));
  });

  it('holds no SOL and still sends — the house pays the fee (ADR-0020 §3)', async () => {
    await seedPrices();
    const session = await tokenOnlyUser();

    // Zero SOL, by construction: the user was credited USDC and nothing else.
    const sol = await ledger().getUserBalance(session.userId, SOL_KEY);
    expect(BigInt(sol.available)).toBe(0n);

    const response = await submit(session.cookie, USDC(50n));
    expect(response.json().withdrawal.status).toBe('FUNDS_LOCKED');
  });

  it("applies the TOKEN's limits, not the native asset's", async () => {
    await seedPrices();
    const session = await tokenOnlyUser(USDC(40_000n));

    // 20,000 USDC is above the token's 10,000 per-transaction limit. Under
    // SOL's limit of 100 SOL = 100000000000 base units it would pass, which is
    // what a fallback to the native asset's figures would have done.
    const response = await submit(session.cookie, USDC(20_000n));
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses more tokens than the user holds', async () => {
    await seedPrices();
    const session = await tokenOnlyUser(USDC(10n));

    const response = await submit(session.cookie, USDC(100n));
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const balance = await ledger().getUserBalance(session.userId, USDC_KEY);
    expect(BigInt(balance.locked)).toBe(0n);
  });
});

describe("step-up freshness is tiered by the TOKEN's own threshold (ADR-0011)", () => {
  /*
   * The guard compares the posted amount against a threshold in base units,
   * and base units are not comparable across assets.
   *
   * It used SOL's 25,000,000,000 for everything. Against USDC's six decimals
   * that reads as 25,000 USDC — so a 20,000 USDC withdrawal, far above the
   * 5,000 USDC this deployment calls large, was handed the LAX freshness
   * window. The token's own figure is the one that applies now.
   */
  it('asks a stale session for a fresher assertion on a large TOKEN amount', async () => {
    const stale = await seedSession(h, { steppedUp: false });
    await creditUser(h, stale.userId, USDC_KEY, USDC(40_000n));

    // 6,000 USDC: over the token's 5,000 review threshold, and far under the
    // 25,000 that SOL's number would have implied here.
    const response = await submit(stale.cookie, USDC(6_000n));
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('answers a malformed asset with a validation error, not a crash', async () => {
    const session = await seedSession(h, { steppedUp: true });

    /*
     * The guard runs at `preValidation`, so this reaches it before the schema
     * does. A colon is what `ledgerAssetKey` refuses, and an unhandled throw
     * there would answer 500 for a request the schema was about to reject
     * cleanly.
     */
    const response = await submit(session.cookie, USDC(1n), 'localnet:SOL');
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});

describe('the value threshold applies across assets', () => {
  it('auto-approves a token withdrawal worth less than the threshold', async () => {
    await seedPrices();
    const session = await tokenOnlyUser();

    // 1,000 USDC at $1 = $1,000, under $5,000.
    expect((await submit(session.cookie, USDC(1_000n))).json().withdrawal.status).toBe(
      'FUNDS_LOCKED',
    );
  });

  it('reviews a token withdrawal worth more than the threshold', async () => {
    await seedPrices();
    const session = await tokenOnlyUser();

    // 6,000 USDC at $1 = $6,000, over $5,000. The same dollar figure that
    // governs SOL — which is the whole point of stating it in dollars.
    expect((await submit(session.cookie, USDC(6_000n))).json().withdrawal.status).toBe(
      'MANUAL_REVIEW',
    );
  });
});

describe('settling a token withdrawal', () => {
  it('pays the fee in SOL and leaves the house USDC position alone', async () => {
    await seedPrices();
    const session = await tokenOnlyUser();

    const { withdrawal } = (await submit(session.cookie, USDC(250n))).json();
    expect(withdrawal.status).toBe('FUNDS_LOCKED');

    await h.app.withdrawalWorkers.runSigningCycle();
    // Asserted, not assumed: signing is where a token withdrawal used to die,
    // and a later assertion on the ledger would otherwise report the symptom
    // rather than the step that failed.
    expect((await withdrawals().findById(withdrawal.id))?.status).toBe('SIGNED');

    await h.app.withdrawalWorkers.runBroadcastCycle();

    const record = await withdrawals().findById(withdrawal.id);
    const fee = '5000'; // lamports
    broadcaster.setFee(record!.txSignature!, fee);
    broadcaster.finalize(record!.txSignature!);

    await h.app.withdrawalWorkers.runConfirmationCycle();

    const settled = await withdrawals().findById(withdrawal.id);
    expect(settled?.status).toBe('SETTLED');

    // The user is out exactly the tokens they sent, and no SOL.
    const usdc = await ledger().getUserBalance(session.userId, USDC_KEY);
    expect(BigInt(usdc.locked)).toBe(0n);
    expect(BigInt(usdc.total)).toBe(BigInt(USDC(20_000n)) - BigInt(USDC(250n)));
    const sol = await ledger().getUserBalance(session.userId, SOL_KEY);
    expect(BigInt(sol.total)).toBe(0n);

    /*
     * THE REGRESSION.
     *
     * The settlement posting took ONE asset and used it for both the amount
     * and the fee, so a USDC withdrawal recorded its lamport fee against the
     * mint — crediting the house's USDC chain assets with 5,000 of a token it
     * never spent, and leaving every token withdrawal's books drifted by
     * exactly its own fee. Per-asset balance is the invariant that catches it.
     */
    expect(checkBooksBalance(await allEntries())).toEqual([]);

    const feeEntries = (await allEntries()).filter(
      (entry) => entry.amount === BigInt(fee) && entry.account.ownerId === null,
    );
    expect(feeEntries.length).toBeGreaterThan(0);
    for (const entry of feeEntries) {
      // In SOL. Never the mint.
      expect(entry.asset).toBe(SOL_KEY);
    }
  });

  it('reports the fee in the asset it was actually paid in', async () => {
    await seedPrices();
    const session = await tokenOnlyUser();

    const { withdrawal } = (await submit(session.cookie, USDC(10n))).json();
    await h.app.withdrawalWorkers.runSigningCycle();
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const record = await withdrawals().findById(withdrawal.id);
    broadcaster.setFee(record!.txSignature!, '5000');
    broadcaster.finalize(record!.txSignature!);
    await h.app.withdrawalWorkers.runConfirmationCycle();

    const response = await h.app.inject({
      method: 'GET',
      url: `/withdrawals/${withdrawal.id}`,
      headers: browserHeaders(session.cookie),
    });
    const settled = response.json().withdrawal;

    expect(settled.networkFee).toBe('5000');
    /*
     * Nine and SOL, NOT six and the mint.
     *
     * Rendered with the withdrawal's own decimals, 5,000 lamports reads as
     * 0.005 USDC — a thousand times the true 0.000005 SOL, in the wrong unit,
     * on the one line that tells a user what the platform spent on their
     * behalf.
     */
    expect(settled.networkFeeDecimals).toBe(9);
    expect(settled.networkFeeSymbol).toBe('SOL');
  });
});
