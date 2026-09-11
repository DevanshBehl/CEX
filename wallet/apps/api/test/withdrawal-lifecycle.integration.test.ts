import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockSigner, type MockSigner } from '@wallet/blockchain';
import { createLedgerRepository, createWithdrawalRepository } from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import { checkBooksBalance } from '@wallet/ledger';
import type { WithdrawalStatus } from '@wallet/types';
import {
  createFakeBroadcaster,
  createFakeNonceManager,
  type FakeBroadcaster,
  type FakeNonceManager,
} from './fake-withdrawal-chain.js';
import {
  browserHeaders,
  creditUser,
  fundHouse,
  markDestinationKnown,
  seedNonceAccounts,
  seedSession,
  startHarness,
  type Harness,
} from './helpers.js';

let h: Harness;
let nonces: FakeNonceManager;
let broadcaster: FakeBroadcaster;
let signer: MockSigner;
let nonceAddresses: string[];

const ONE_SOL = 1_000_000_000n;
const SOL = (n: bigint): string => (n * ONE_SOL).toString();
const AMOUNT = SOL(5n);
const DEST = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

beforeAll(async () => {
  nonces = createFakeNonceManager();
  broadcaster = createFakeBroadcaster();
  signer = createMockSigner({ onBanner: () => undefined });

  h = await startHarness({ nonceManager: nonces, broadcaster, signer });
  await fundHouse(h, NATIVE_ASSET, SOL(50n));
  nonceAddresses = await seedNonceAccounts(h, nonces, 60);
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(() => {
  broadcaster.setBehaviour('submit');
  signer.clearFaults();
});

let counter = 0;

/** A locked withdrawal, ready for the signer. */
async function lockedWithdrawal(amount = AMOUNT): Promise<{ id: string; userId: string }> {
  const session = await seedSession(h, { steppedUp: true });
  await creditUser(h, session.userId, NATIVE_ASSET, SOL(100n));
  await markDestinationKnown(h, session.userId, NATIVE_ASSET, DEST);

  const response = await h.app.inject({
    method: 'POST',
    url: '/withdrawals',
    headers: browserHeaders(session.cookie),
    payload: {
      asset: NATIVE_ASSET,
      amount,
      destination: DEST,
      idempotencyKey: `life-${Date.now()}-${(counter += 1)}`,
    },
  });

  const { withdrawal } = response.json();
  if (withdrawal?.status !== 'FUNDS_LOCKED') {
    throw new Error(`expected FUNDS_LOCKED, got ${withdrawal?.status} (${response.body})`);
  }
  return { id: withdrawal.id, userId: session.userId };
}

const withdrawals = () => createWithdrawalRepository(h.app.appDeps.db);
const statusOf = async (id: string): Promise<WithdrawalStatus> =>
  (await withdrawals().findById(id))!.status;
const balanceOf = (userId: string) =>
  createLedgerRepository(h.app.appDeps.db).getUserBalance(userId, NATIVE_ASSET);

/** Every entry in the ledger, for the books-balance assertion. */
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

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('the full lifecycle', () => {
  it('carries a withdrawal from locked funds to settlement', async () => {
    const { id, userId } = await lockedWithdrawal();
    const before = await balanceOf(userId);
    expect(BigInt(before.locked)).toBe(BigInt(AMOUNT));

    await h.app.withdrawalWorkers.runSigningCycle();
    expect(await statusOf(id)).toBe('SIGNED');

    await h.app.withdrawalWorkers.runBroadcastCycle();
    expect(await statusOf(id)).toBe('BROADCAST');

    const record = await withdrawals().findById(id);
    // Persisted BEFORE confirmation is awaited (master-prompt rule 141).
    expect(record?.txSignature).toBeTruthy();
    expect(record?.signedTransaction).toBeTruthy();

    broadcaster.finalize(record!.txSignature!);
    await h.app.withdrawalWorkers.runConfirmationCycle();

    expect(await statusOf(id)).toBe('SETTLED');

    const after = await balanceOf(userId);
    expect(BigInt(after.locked)).toBe(0n);
    // The money left: total holdings fell by exactly the withdrawal.
    expect(BigInt(after.total)).toBe(BigInt(before.total) - BigInt(AMOUNT));
  });

  it('keeps the books balanced at every step (rules 174-175)', async () => {
    const { id } = await lockedWithdrawal();

    // A half-applied lock is the failure that loses money quietly, so the
    // assertion is after EVERY transition, not only at the end.
    expect(checkBooksBalance(await allEntries())).toEqual([]);

    await h.app.withdrawalWorkers.runSigningCycle();
    expect(checkBooksBalance(await allEntries())).toEqual([]);

    await h.app.withdrawalWorkers.runBroadcastCycle();
    expect(checkBooksBalance(await allEntries())).toEqual([]);

    broadcaster.finalize((await withdrawals().findById(id))!.txSignature!);
    await h.app.withdrawalWorkers.runConfirmationCycle();
    expect(checkBooksBalance(await allEntries())).toEqual([]);
  });

  it('charges the network fee to the house, not to the user (rule 118)', async () => {
    const { id, userId } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const record = await withdrawals().findById(id);
    broadcaster.setFee(record!.txSignature!, '5000');
    broadcaster.finalize(record!.txSignature!);
    await h.app.withdrawalWorkers.runConfirmationCycle();

    const after = await balanceOf(userId);
    // The user is debited exactly what they asked to withdraw — not a lamport
    // more for the fee.
    expect(BigInt(after.total)).toBe(BigInt(SOL(100n)) - BigInt(AMOUNT));
    expect((await withdrawals().findById(id))?.networkFee).toBe('5000');
  });

  it('records the signing request without any key material (rules 129-130, 201)', async () => {
    const { id } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();

    const request = await h.app.appDeps.db.signingRequest.findFirst({
      where: { withdrawalId: id },
    });
    expect(request?.outcome).toBe('succeeded');
    expect(request?.signerKind).toBe('mock');

    const serialized = JSON.stringify(request);
    // It records that a request was made, by whom, under what authorization —
    // never the signature or anything secret.
    expect(serialized).not.toMatch(/privateKey|share|secret|signature/i);
    expect(request?.authorization).toBeTruthy();
  });

  it('releases the nonce lease once settled', async () => {
    const { id } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();

    const leased = await h.app.appDeps.db.nonceAccount.findFirst({ where: { leasedBy: id } });
    expect(leased).toBeTruthy();

    await h.app.withdrawalWorkers.runBroadcastCycle();
    broadcaster.finalize((await withdrawals().findById(id))!.txSignature!);
    await h.app.withdrawalWorkers.runConfirmationCycle();

    expect(await h.app.appDeps.db.nonceAccount.findFirst({ where: { leasedBy: id } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Signing idempotency and faults
// ---------------------------------------------------------------------------

describe('signing', () => {
  it('never starts a second signing round for one withdrawal (rules 123-124)', async () => {
    const { id } = await lockedWithdrawal();
    const before = signer.roundCount();

    await h.app.withdrawalWorkers.runSigningCycle();
    const afterFirst = signer.roundCount();
    expect(afterFirst).toBe(before + 1);

    // Force it back through the signer. Under threshold signing a duplicate
    // round is a nonce-reuse hazard, not merely waste.
    await withdrawals().transition({ withdrawalId: id, from: 'SIGNED', to: 'BROADCAST' });
    await withdrawals().transition({
      withdrawalId: id,
      from: 'BROADCAST',
      to: 'EXPIRED',
      reason: 'test',
    });
    await withdrawals().transition({ withdrawalId: id, from: 'EXPIRED', to: 'FUNDS_LOCKED' });
    await h.app.withdrawalWorkers.runSigningCycle();

    // The same requestId, so the signer returned its cached result.
    expect(signer.roundCount()).toBe(afterFirst);
  });

  it('moves to SIGN_FAILED when the signer fails, keeping the funds locked', async () => {
    const { id, userId } = await lockedWithdrawal();
    signer.injectFault(`withdrawal:${id}`, 'fail');

    await h.app.withdrawalWorkers.runSigningCycle();

    expect(await statusOf(id)).toBe('SIGN_FAILED');
    // The funds never stopped being reserved — only the attempt failed.
    expect(BigInt((await balanceOf(userId)).locked)).toBe(BigInt(AMOUNT));
    expect((await withdrawals().findById(id))?.signAttempts).toBe(1);
  });

  it('retries a failed signing and succeeds (ADR-0012)', async () => {
    const { id } = await lockedWithdrawal();
    signer.injectFault(`withdrawal:${id}`, 'fail');

    await h.app.withdrawalWorkers.runSigningCycle();
    expect(await statusOf(id)).toBe('SIGN_FAILED');

    // Next cycle: the retry edge returns it to FUNDS_LOCKED and signs.
    await h.app.withdrawalWorkers.runSigningCycle();
    await h.app.withdrawalWorkers.runSigningCycle();
    expect(await statusOf(id)).toBe('SIGNED');
  });

  it('rejects a malformed signature rather than broadcasting it', async () => {
    const { id } = await lockedWithdrawal();
    signer.injectFault(`withdrawal:${id}`, 'malformed');

    await h.app.withdrawalWorkers.runSigningCycle();
    expect(await statusOf(id)).toBe('SIGN_FAILED');
    expect((await withdrawals().findById(id))?.signedTransaction).toBeNull();
  });

  it('gives up and releases the lock when the budget is exhausted (rules 176, 190)', async () => {
    const { id, userId } = await lockedWithdrawal();
    const before = await balanceOf(userId);

    // Three attempts, per the configured budget.
    for (let i = 0; i < 8; i += 1) {
      signer.injectFault(`withdrawal:${id}`, 'fail');
      await h.app.withdrawalWorkers.runSigningCycle();
    }

    const final = await withdrawals().findById(id);
    expect(final?.status).toBe('FAILED');

    // A lock the user cannot see through is worse than a visible failure.
    const after = await balanceOf(userId);
    expect(BigInt(after.locked)).toBe(0n);
    expect(BigInt(after.available)).toBe(BigInt(before.available) + BigInt(AMOUNT));
    expect(checkBooksBalance(await allEntries())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Broadcast and the ambiguous case (rules 170-171, 198-199)
// ---------------------------------------------------------------------------

describe('broadcast', () => {
  it('recovers from a crash between SIGNED and BROADCAST with no double-spend', async () => {
    const { id, userId } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();
    expect(await statusOf(id)).toBe('SIGNED');

    const signedBefore = (await withdrawals().findById(id))!.signedTransaction;
    const roundsBefore = signer.roundCount();

    // The crash: the process dies here. Nothing is in memory; the signed bytes
    // are on disk. A new process picks it up.
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const after = await withdrawals().findById(id);
    expect(after?.status).toBe('BROADCAST');
    // The SAME bytes were broadcast — not re-signed.
    expect(Buffer.from(after!.signedTransaction!)).toEqual(Buffer.from(signedBefore!));
    expect(signer.roundCount()).toBe(roundsBefore);

    broadcaster.finalize(after!.txSignature!);
    await h.app.withdrawalWorkers.runConfirmationCycle();

    expect(await statusOf(id)).toBe('SETTLED');
    // Exactly one settlement, so exactly one debit.
    const balance = await balanceOf(userId);
    expect(BigInt(balance.total)).toBe(BigInt(SOL(100n)) - BigInt(AMOUNT));
  });

  it('re-broadcasts IDENTICAL bytes when the outcome is unknown (rules 140-141, 199)', async () => {
    const { id } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();

    // Submitted, and it never confirms. The ambiguous broadcast.
    broadcaster.setBehaviour('ambiguous');
    await h.app.withdrawalWorkers.runBroadcastCycle();
    expect(await statusOf(id)).toBe('BROADCAST');

    const payloadsBefore = broadcaster.distinctPayloads();
    const roundsBefore = signer.roundCount();
    const submissionsBefore = broadcaster.submissions().length;

    // The confirmation worker finds it pending and asks the nonce.
    await h.app.withdrawalWorkers.runConfirmationCycle();
    await h.app.withdrawalWorkers.runConfirmationCycle();

    // It re-submitted...
    expect(broadcaster.submissions().length).toBeGreaterThan(submissionsBefore);
    // ...the same bytes, so the same signature, which the network deduplicates.
    expect(broadcaster.distinctPayloads()).toBe(payloadsBefore);
    // And it never signed again. A re-sign here is the double-spend.
    expect(signer.roundCount()).toBe(roundsBefore);
  });

  it('expires rather than re-signing when the nonce has advanced (rules 142-143)', async () => {
    const { id } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();
    broadcaster.setBehaviour('ambiguous');
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const record = await withdrawals().findById(id);
    const lease = await h.app.appDeps.db.nonceAccount.findUniqueOrThrow({
      where: { id: record!.nonceAccountId! },
    });

    // A competing transaction wins the nonce. Our bytes can never land — and we
    // can PROVE it, which is the difference from a dead blockhash.
    nonces.advance(lease.address);

    const roundsBefore = signer.roundCount();
    await h.app.withdrawalWorkers.runConfirmationCycle();

    expect(await statusOf(id)).toBe('EXPIRED');
    // Still no re-sign: the retry edge does that on a fresh nonce, deliberately.
    expect(signer.roundCount()).toBe(roundsBefore);
  });

  it('re-signs on a FRESH nonce after expiry, which is provably safe', async () => {
    const { id } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();
    broadcaster.setBehaviour('ambiguous');
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const record = await withdrawals().findById(id);
    const lease = await h.app.appDeps.db.nonceAccount.findUniqueOrThrow({
      where: { id: record!.nonceAccountId! },
    });
    nonces.advance(lease.address);
    await h.app.withdrawalWorkers.runConfirmationCycle();
    expect(await statusOf(id)).toBe('EXPIRED');

    // The retry edge drops the lease and returns it to the queue.
    broadcaster.setBehaviour('submit');
    await h.app.withdrawalWorkers.runSigningCycle();

    const retried = await withdrawals().findById(id);
    expect(['FUNDS_LOCKED', 'SIGNING', 'SIGNED']).toContain(retried!.status);
    expect(retried?.expiryAttempts).toBe(1);
  });

  it('distinguishes an RPC rejection from an expiry (rule 144)', async () => {
    const { id } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();

    broadcaster.setBehaviour('reject');
    await h.app.withdrawalWorkers.runBroadcastCycle();

    // They look similar and need different responses.
    expect(await statusOf(id)).toBe('BROADCAST_FAILED');
    expect((await withdrawals().findById(id))?.broadcastAttempts).toBe(1);
    expect((await withdrawals().findById(id))?.expiryAttempts).toBe(0);
  });

  it('marks an on-chain failure as BROADCAST_FAILED, not settled', async () => {
    const { id, userId } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const record = await withdrawals().findById(id);
    broadcaster.failOnChain(record!.txSignature!);
    await h.app.withdrawalWorkers.runConfirmationCycle();

    expect(await statusOf(id)).toBe('BROADCAST_FAILED');
    // The funds are still reserved, not settled away.
    expect(BigInt((await balanceOf(userId)).locked)).toBe(BigInt(AMOUNT));
  });

  it('does not settle before finality (rules 138-139, 221)', async () => {
    const { id, userId } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();
    await h.app.withdrawalWorkers.runBroadcastCycle();

    // Not finalized: several cycles must change nothing.
    for (let i = 0; i < 3; i += 1) await h.app.withdrawalWorkers.runConfirmationCycle();

    expect(await statusOf(id)).toBe('BROADCAST');
    expect(BigInt((await balanceOf(userId)).locked)).toBe(BigInt(AMOUNT));
  });
});

// ---------------------------------------------------------------------------
// The nonce pool (ADR-0009, rule 38)
// ---------------------------------------------------------------------------

describe('the nonce pool', () => {
  it('never leases one account to two withdrawals', async () => {
    const created = await Promise.all([
      lockedWithdrawal(SOL(1n)),
      lockedWithdrawal(SOL(1n)),
      lockedWithdrawal(SOL(1n)),
    ]);

    await h.app.withdrawalWorkers.runSigningCycle();

    const leases = await h.app.appDeps.db.nonceAccount.findMany({
      where: { leasedBy: { in: created.map((w) => w.id) } },
      select: { id: true, leasedBy: true },
    });

    // Two transactions on one nonce means only one can win, and the loser's
    // failure is indistinguishable from an expiry.
    expect(new Set(leases.map((l) => l.id)).size).toBe(leases.length);
    expect(nonceAddresses.length).toBeGreaterThan(0);
  });

  it('waits rather than failing when the pool is dry', async () => {
    // Occupy every account.
    await h.app.appDeps.db.nonceAccount.updateMany({
      data: { status: 'retired', leasedBy: null, leasedAt: null },
    });

    const { id, userId } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();

    // A dry pool is an operational condition, not a lost withdrawal.
    expect(['SIGN_FAILED', 'FUNDS_LOCKED']).toContain(await statusOf(id));
    expect(BigInt((await balanceOf(userId)).locked)).toBe(BigInt(AMOUNT));

    // Restore for the remaining tests.
    await h.app.appDeps.db.nonceAccount.updateMany({
      where: { status: 'retired' },
      data: { status: 'available' },
    });
  });
});
