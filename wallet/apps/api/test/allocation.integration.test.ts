import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockSigner } from '@wallet/blockchain';
import { createLedgerRepository, createWithdrawalRepository } from '@wallet/db';
import { checkAllInvariants } from '@wallet/ledger';
import { NATIVE_ASSET } from '@wallet/solana';
import { createFakeEngine } from './fake-engine.js';
import {
  createFakeBroadcaster,
  createFakeNonceManager,
  type FakeBroadcaster,
} from './fake-withdrawal-chain.js';
import {
  browserHeaders,
  creditUser,
  fundHouse,
  seedDepositAddress,
  seedNonceAccounts,
  seedSession,
  SOL_KEY,
  startHarness,
  TEST_CLUSTER,
  type Harness,
} from './helpers.js';

/**
 * Moving funds between the vault and clearing tiers (prompt_phase_s3.md §7).
 *
 * An allocation is a withdrawal whose destination is the clearing address, run
 * by the real withdrawal workers — so what is tested here is the whole
 * lifecycle, not a shortcut, and the assertion that matters is the last one in
 * each test: that both reconciliation equations still hold.
 */

const CLEARING = 'So11111111111111111111111111111111111111112';
const ONE = 1_000_000_000n;

let h: Harness;
let broadcaster: FakeBroadcaster;

beforeAll(async () => {
  const nonces = createFakeNonceManager();
  broadcaster = createFakeBroadcaster();
  h = await startHarness({
    nonceManager: nonces,
    broadcaster,
    signer: createMockSigner({ onBanner: () => undefined }),
    trading: {
      engines: new Map([
        [
          'SOL-XUSD',
          createFakeEngine({
            market: 'SOL-XUSD',
            marketId: `${TEST_CLUSTER}:SOL-XUSD`,
            tickSize: 1_000n,
            lotSize: 1_000_000n,
            minNotional: 1_000n,
            collarBps: 5_000,
          }),
        ],
      ]),
      clearingAddress: CLEARING,
      markets: [
        {
          symbol: 'SOL-XUSD',
          tickSize: '1000',
          lotSize: '1000000',
          minNotional: '1000',
          collarBps: 5_000,
        },
      ],
    },
    tokens: [
      {
        symbol: 'XUSD',
        mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        decimals: 6,
        perTransactionLimit: '1000000000000',
        dailyLimit: '1000000000000',
        manualReviewAbove: '1000000000000',
      },
    ],
  });
  await fundHouse(h, SOL_KEY, (50n * ONE).toString());
  await seedNonceAccounts(h, nonces, 40);
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(() => {
  broadcaster.setBehaviour('submit');
});

let n = 0;
const key = () => `alloc-${Date.now()}-${(n += 1)}`;

/**
 * The entries THIS test is responsible for: every leg of every transaction
 * that touches no OTHER user, in the test asset — this user's transactions and
 * the house-only ones (funding) whose slack covers network fees.
 *
 * Whole transactions, not "this user's accounts plus the house's": the house
 * legs of other users' transactions would come along without their
 * counterparts and show up as a books_balance residual on any database that
 * has seen another run.
 *
 * Not the whole ledger. The integration database is shared and append-only, and
 * other suites deliberately write states the invariants reject — the orders
 * suite posts holds with no balance behind them to PROVE the database does not
 * refuse an overdrawn hold. Asserting "every invariant holds for all of it"
 * would fail on evidence that is working as intended.
 */
async function entries(userId: string) {
  const rows = await h.app.appDeps.db.$queryRawUnsafe<
    Array<{ asset: string; amount: string; direction: string; type: string; owner: string | null }>
  >(
    `SELECT e.asset, e.amount::text AS amount, e.direction::text AS direction,
            a.type::text AS type, a.owner_id::text AS owner
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.asset = $1
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries o JOIN ledger_accounts oa ON oa.id = o.account_id
           WHERE o.transaction_id = e.transaction_id
             AND oa.owner_id IS NOT NULL AND oa.owner_id <> $2::uuid)`,
    SOL_KEY,
    userId,
  );
  return rows.map((row) => ({
    account: { ownerId: row.owner, asset: row.asset, type: row.type as never },
    asset: row.asset,
    amount: BigInt(row.amount),
    direction: row.direction as 'debit' | 'credit',
  }));
}

/** Drive a withdrawal-lifecycle movement from FUNDS_LOCKED to SETTLED. */
async function settle(id: string): Promise<void> {
  const repo = createWithdrawalRepository(h.app.appDeps.db);
  await h.app.withdrawalWorkers.runSigningCycle();
  await h.app.withdrawalWorkers.runBroadcastCycle();
  broadcaster.finalize((await repo.findById(id))!.txSignature!);
  await h.app.withdrawalWorkers.runConfirmationCycle();
}

const tradingBalance = async (userId: string) =>
  (
    await createLedgerRepository(h.app.appDeps.db).getUserTradingBalances(userId, TEST_CLUSTER)
  ).find((b) => b.asset === SOL_KEY) ?? { available: '0', locked: '0' };

describe('allocation', () => {
  // ADR-0033: value moves on-chain, so the same step-up a withdrawal needs.
  it('demands a fresh step-up', async () => {
    const session = await seedSession(h);
    await creditUser(h, session.userId, SOL_KEY, (5n * ONE).toString());
    const response = await h.app.inject({
      method: 'POST',
      url: '/allocations',
      headers: browserHeaders(session.cookie),
      payload: { asset: NATIVE_ASSET, amount: ONE.toString(), idempotencyKey: key() },
    });
    expect(response.statusCode).toBe(403);
  });

  // Rule 74: an allocation whose destination a client can choose is a
  // withdrawal wearing a costume. A destination in the body is ignored.
  it('sends to the configured clearing address whatever the body says', async () => {
    const session = await seedSession(h, { steppedUp: true });
    await creditUser(h, session.userId, SOL_KEY, (5n * ONE).toString());
    const response = await h.app.inject({
      method: 'POST',
      url: '/allocations',
      headers: browserHeaders(session.cookie),
      payload: {
        asset: NATIVE_ASSET,
        amount: ONE.toString(),
        idempotencyKey: key(),
        destination: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T',
      },
    });
    expect(response.statusCode).toBe(200);
    const { withdrawal } = response.json();
    expect(withdrawal.destination).toBe(CLEARING);
    expect(withdrawal.purpose).toBe('allocation');
    expect(withdrawal.status).toBe('FUNDS_LOCKED');
  });

  it('moves value into the trading tier on settlement, with both tiers covered throughout', async () => {
    const session = await seedSession(h, { steppedUp: true });
    await creditUser(h, session.userId, SOL_KEY, (5n * ONE).toString());
    const { withdrawal } = (
      await h.app.inject({
        method: 'POST',
        url: '/allocations',
        headers: browserHeaders(session.cookie),
        payload: { asset: NATIVE_ASSET, amount: (2n * ONE).toString(), idempotencyKey: key() },
      })
    ).json();

    // IN FLIGHT: the coins are still at the user's address and the liability
    // is still locked in the vault — so the vault equation holds unchanged and
    // clearing is simply not yet credited. No in-flight term exists.
    expect(checkAllInvariants(await entries(session.userId))).toEqual([]);
    expect((await tradingBalance(session.userId)).available).toBe('0');

    await settle(withdrawal.id);
    const settled = await createWithdrawalRepository(h.app.appDeps.db).findById(withdrawal.id);
    expect(settled?.status).toBe('SETTLED');

    expect(BigInt((await tradingBalance(session.userId)).available)).toBe(2n * ONE);
    const vault = await createLedgerRepository(h.app.appDeps.db).getUserBalance(
      session.userId,
      SOL_KEY,
    );
    expect(BigInt(vault.available)).toBe(3n * ONE);
    expect(BigInt(vault.locked)).toBe(0n);
    expect(checkAllInvariants(await entries(session.userId))).toEqual([]);
  });

  it('refuses an allocation the vault balance cannot cover', async () => {
    const session = await seedSession(h, { steppedUp: true });
    await creditUser(h, session.userId, SOL_KEY, ONE.toString());
    const response = await h.app.inject({
      method: 'POST',
      url: '/allocations',
      headers: browserHeaders(session.cookie),
      payload: { asset: NATIVE_ASSET, amount: (2n * ONE).toString(), idempotencyKey: key() },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('deallocation', () => {
  it('returns value to the vault from the clearing address, both tiers covered', async () => {
    const session = await seedSession(h, { steppedUp: true });
    await seedDepositAddress(h, session.userId);
    await creditUser(h, session.userId, SOL_KEY, (5n * ONE).toString());
    const alloc = (
      await h.app.inject({
        method: 'POST',
        url: '/allocations',
        headers: browserHeaders(session.cookie),
        payload: { asset: NATIVE_ASSET, amount: (3n * ONE).toString(), idempotencyKey: key() },
      })
    ).json().withdrawal;
    await settle(alloc.id);

    const response = await h.app.inject({
      method: 'POST',
      url: '/deallocations',
      headers: browserHeaders(session.cookie),
      payload: { asset: NATIVE_ASSET, amount: ONE.toString(), idempotencyKey: key() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const dealloc = response.json().withdrawal;
    expect(dealloc.purpose).toBe('deallocation');

    // In flight, the lock sits in the CLEARING tier, where the coins still are.
    expect((await tradingBalance(session.userId)).locked).toBe(ONE.toString());
    expect(checkAllInvariants(await entries(session.userId))).toEqual([]);

    await settle(dealloc.id);
    expect(BigInt((await tradingBalance(session.userId)).available)).toBe(2n * ONE);
    expect((await tradingBalance(session.userId)).locked).toBe('0');
    const vault = await createLedgerRepository(h.app.appDeps.db).getUserBalance(
      session.userId,
      SOL_KEY,
    );
    expect(BigInt(vault.available)).toBe(3n * ONE);
    expect(checkAllInvariants(await entries(session.userId))).toEqual([]);
  });

  it('refuses a deallocation the trading balance cannot cover', async () => {
    const session = await seedSession(h, { steppedUp: true });
    await seedDepositAddress(h, session.userId);
    const response = await h.app.inject({
      method: 'POST',
      url: '/deallocations',
      headers: browserHeaders(session.cookie),
      payload: { asset: NATIVE_ASSET, amount: ONE.toString(), idempotencyKey: key() },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('the clearing address is not a withdrawal destination', () => {
  // An external withdrawal to it would move value into the pool with no
  // liability to match — a surplus that belongs to nobody.
  it('refuses an ordinary withdrawal addressed to the clearing pool', async () => {
    const session = await seedSession(h, { steppedUp: true });
    await creditUser(h, session.userId, SOL_KEY, (5n * ONE).toString());
    const response = await h.app.inject({
      method: 'POST',
      url: '/withdrawals',
      headers: browserHeaders(session.cookie),
      payload: {
        asset: NATIVE_ASSET,
        amount: ONE.toString(),
        destination: CLEARING,
        idempotencyKey: key(),
      },
    });
    expect(response.statusCode).toBe(403);
  });
});
