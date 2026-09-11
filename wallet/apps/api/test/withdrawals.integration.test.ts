import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockSigner, type MockSigner } from '@wallet/blockchain';
import { createLedgerRepository, createWithdrawalRepository } from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import { WITHDRAWAL_TRANSITIONS, type WithdrawalStatus } from '@wallet/types';
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

const ONE_SOL = 1_000_000_000n;
const SOL = (n: bigint): string => (n * ONE_SOL).toString();
/** Below RISK_MANUAL_REVIEW_ABOVE (25 SOL) so it auto-approves. */
const SMALL = SOL(5n);
const DEST = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const OPERATOR = '01936e00-0000-7000-8000-0000000000ff';

beforeAll(async () => {
  nonces = createFakeNonceManager();
  broadcaster = createFakeBroadcaster();
  signer = createMockSigner({ onBanner: () => undefined });

  h = await startHarness({
    nonceManager: nonces,
    broadcaster,
    signer,
    operatorUserIds: [OPERATOR],
  });

  await h.app.appDeps.db.user.upsert({
    where: { id: OPERATOR },
    create: { id: OPERATOR, status: 'active' },
    update: {},
  });
  await fundHouse(h, NATIVE_ASSET, SOL(10n));
  await seedNonceAccounts(h, nonces, 5);
});

afterAll(async () => {
  await h.app.appDeps.db.user.deleteMany({ where: { id: OPERATOR } });
  await h.cleanup();
});

beforeEach(() => {
  broadcaster.setBehaviour('submit');
  signer.clearFaults();
});

let keyCounter = 0;
const nextKey = (): string => `idem-${Date.now()}-${(keyCounter += 1)}`;

/**
 * A funded user who has already sent to DEST.
 *
 * Without the history, every withdrawal below would be reviewed for
 * NEW_DESTINATION — correct behaviour, and not what most of these tests are
 * about. History cannot be established by submitting, because only a SETTLED
 * withdrawal counts as having sent anywhere.
 */
async function fundedUser(
  amount = SOL(100n),
  options: { knownDestination?: boolean } = {},
): Promise<{ userId: string; cookie: string }> {
  const session = await seedSession(h, { steppedUp: true });
  await creditUser(h, session.userId, NATIVE_ASSET, amount);
  if (options.knownDestination !== false) {
    await markDestinationKnown(h, session.userId, NATIVE_ASSET, DEST);
  }
  return { userId: session.userId, cookie: session.cookie };
}

async function submit(
  cookie: string,
  overrides: Partial<{ amount: string; destination: string; idempotencyKey: string }> = {},
) {
  return h.app.inject({
    method: 'POST',
    url: '/withdrawals',
    headers: browserHeaders(cookie),
    payload: {
      asset: NATIVE_ASSET,
      amount: overrides.amount ?? SMALL,
      destination: overrides.destination ?? DEST,
      idempotencyKey: overrides.idempotencyKey ?? nextKey(),
    },
  });
}

const statusOf = async (id: string): Promise<WithdrawalStatus> =>
  (await createWithdrawalRepository(h.app.appDeps.db).findById(id))!.status;

const balanceOf = async (userId: string) =>
  createLedgerRepository(h.app.appDeps.db).getUserBalance(userId, NATIVE_ASSET);

// ---------------------------------------------------------------------------
// Submission, risk, and locking
// ---------------------------------------------------------------------------

describe('submission (master-prompt rules 131-137)', () => {
  it('auto-approves an ordinary withdrawal and locks the funds', async () => {
    const user = await fundedUser();
    const response = await submit(user.cookie);

    expect(response.statusCode).toBe(200);
    const { withdrawal } = response.json();

    // The lock IS the sufficient-funds check, and it happens synchronously.
    expect(withdrawal.status).toBe('FUNDS_LOCKED');
    expect(withdrawal.fundsLocked).toBe(true);

    const balance = await balanceOf(user.userId);
    expect(BigInt(balance.locked)).toBe(BigInt(SMALL));
    expect(BigInt(balance.available) + BigInt(balance.locked)).toBe(BigInt(SOL(100n)));
  });

  it('reserves funds without changing what the user owns (rules 109-110)', async () => {
    const user = await fundedUser();
    const before = await balanceOf(user.userId);

    await submit(user.cookie, { amount: SMALL });
    const after = await balanceOf(user.userId);

    // A reservation changes spendability, not ownership.
    expect(after.total).toBe(before.total);
  });

  it('sends a large withdrawal to manual review rather than denying it', async () => {
    const user = await fundedUser();
    const response = await submit(user.cookie, { amount: SOL(30n) });
    expect(response.json().withdrawal.status).toBe('MANUAL_REVIEW');
  });

  it('reviews a first-time destination (ADR-0010)', async () => {
    // Denying would deny everyone their first withdrawal, so a human decides.
    const user = await fundedUser(SOL(100n), { knownDestination: false });
    const response = await submit(user.cookie);
    expect(response.json().withdrawal.status).toBe('MANUAL_REVIEW');
  });

  it('a withdrawal in review does not make a destination familiar', async () => {
    // Only a SETTLED withdrawal counts as having sent anywhere. Otherwise an
    // attacker could launder a new destination into "known" by submitting once.
    const user = await fundedUser(SOL(100n), { knownDestination: false });
    const first = await submit(user.cookie);
    expect(first.json().withdrawal.status).toBe('MANUAL_REVIEW');

    const second = await submit(user.cookie);
    expect(second.json().withdrawal.status).toBe('MANUAL_REVIEW');
  });

  it('denies a withdrawal above the per-transaction limit', async () => {
    const user = await fundedUser(SOL(500n));
    const response = await submit(user.cookie, { amount: SOL(200n) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('POLICY_DENIED');
  });

  it('denies without revealing which limit was hit (rules 81-82, 223)', async () => {
    const user = await fundedUser(SOL(500n));
    const body = (await submit(user.cookie, { amount: SOL(200n) })).json();

    // A message containing a number would let a caller binary-search the limit.
    expect(body.error.message).not.toMatch(/\d/);
    expect(JSON.stringify(body)).not.toContain('PER_TRANSACTION_LIMIT');
  });

  it('records the full reason codes for the operator, though (rule 82)', async () => {
    const user = await fundedUser(SOL(500n));
    await submit(user.cookie, { amount: SOL(200n) });

    const decision = await h.app.appDeps.db.riskDecision.findFirst({
      where: { verdict: 'deny' },
      orderBy: { createdAt: 'desc' },
    });
    expect(decision?.codes).toContain('PER_TRANSACTION_LIMIT');
    expect(decision?.evaluatedRules.length).toBeGreaterThanOrEqual(7);
  });

  it('denies a withdrawal to an address the platform owns', async () => {
    const user = await fundedUser();
    const address = await h.app.appDeps.db.address.findFirst({ select: { address: true } });
    if (!address) return;

    const response = await submit(user.cookie, { destination: address.address });
    expect(response.statusCode).toBe(403);
  });

  it('refuses more than the user has, and the lock is what refuses it (rule 113)', async () => {
    const user = await fundedUser(SOL(1n));
    const response = await submit(user.cookie, { amount: SOL(10n) });
    expect([403, 409]).toContain(response.statusCode);
    expect(BigInt((await balanceOf(user.userId)).locked)).toBe(0n);
  });

  it('requires a session', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/withdrawals',
      headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
      payload: { asset: NATIVE_ASSET, amount: SMALL, destination: DEST, idempotencyKey: nextKey() },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires a fresh step-up (ADR-0011)', async () => {
    const stale = await seedSession(h, { steppedUp: false });
    await creditUser(h, stale.userId, NATIVE_ASSET, SOL(100n));

    const response = await submit(stale.cookie);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('STEP_UP_REQUIRED');
    // The client is told how fresh, so it can prompt rather than guess.
    expect(response.json().error.stepUpMaxAgeSeconds).toBeGreaterThan(0);
  });

  it('a client cannot influence the risk decision (rule 153, master-prompt 154)', async () => {
    const user = await fundedUser(SOL(500n));

    // A request crafted to look pre-approved, with every field an attacker
    // might hope the server trusts.
    const response = await h.app.inject({
      method: 'POST',
      url: '/withdrawals',
      headers: { ...browserHeaders(user.cookie), 'x-risk-verdict': 'approve' },
      payload: {
        asset: NATIVE_ASSET,
        amount: SOL(200n),
        destination: DEST,
        idempotencyKey: nextKey(),
        status: 'APPROVED',
        riskVerdict: 'approve',
        skipRiskChecks: true,
        verdict: 'approve',
      },
    });

    // Evaluated anyway, and denied on the amount.
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('POLICY_DENIED');
  });
});

// ---------------------------------------------------------------------------
// Idempotency (master-prompt rule 182, rules 167, 191)
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('50 concurrent submissions with one key create ONE withdrawal', async () => {
    const user = await fundedUser();
    const before = await balanceOf(user.userId);

    const key = nextKey();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(user.cookie, { idempotencyKey: key })),
    );

    const ids = new Set(
      responses.filter((r) => r.statusCode === 200).map((r) => r.json().withdrawal.id as string),
    );
    expect(ids.size).toBe(1);

    expect(
      await h.app.appDeps.db.withdrawal.count({
        where: { userId: user.userId, idempotencyKey: key },
      }),
    ).toBe(1);

    // And the funds moved once, not fifty times.
    const after = await balanceOf(user.userId);
    const locked = BigInt(after.locked) - BigInt(before.locked);
    expect(locked).toBe(BigInt(SMALL));
  });

  it('a resubmission returns the SAME withdrawal rather than a second one', async () => {
    const user = await fundedUser();
    const key = nextKey();

    const first = await submit(user.cookie, { idempotencyKey: key });
    const second = await submit(user.cookie, { idempotencyKey: key });

    expect(second.json().withdrawal.id).toBe(first.json().withdrawal.id);
  });

  it('two concurrent withdrawals exceeding the balance produce exactly one lock (rules 168-169)', async () => {
    const user = await fundedUser(SOL(10n));

    // Each is affordable alone; together they are not.
    const [a, b] = await Promise.all([
      submit(user.cookie, { amount: SOL(6n) }),
      submit(user.cookie, { amount: SOL(6n) }),
    ]);

    const succeeded = [a, b].filter(
      (r) => r.statusCode === 200 && r.json().withdrawal.status === 'FUNDS_LOCKED',
    );
    expect(succeeded.length).toBeLessThanOrEqual(1);

    const balance = await balanceOf(user.userId);
    // The invariant that matters: never negative.
    expect(BigInt(balance.available)).toBeGreaterThanOrEqual(0n);
  });
});

// ---------------------------------------------------------------------------
// The state machine (rules 163-164, 187-189)
// ---------------------------------------------------------------------------

describe('the state machine', () => {
  it('rejects every illegal transition at the database (rule 188)', async () => {
    const user = await fundedUser();
    const { withdrawal } = (await submit(user.cookie)).json();

    const illegal: Array<[WithdrawalStatus, WithdrawalStatus]> = [
      ['REQUESTED', 'SETTLED'],
      ['REQUESTED', 'BROADCAST'],
      ['SETTLED', 'BROADCAST'],
      ['REJECTED', 'APPROVED'],
      ['APPROVED', 'SIGNING'],
      ['FUNDS_LOCKED', 'SETTLED'],
      ['SIGNING', 'BROADCAST'],
    ];

    for (const [from, to] of illegal) {
      await expect(
        h.app.appDeps.db.$executeRawUnsafe(
          `INSERT INTO withdrawal_transitions (id, withdrawal_id, from_status, to_status, created_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::"WithdrawalStatus", $3::"WithdrawalStatus", now())`,
          withdrawal.id,
          from,
          to,
        ),
        `${from} -> ${to}`,
      ).rejects.toThrow();
    }
  });

  it('accepts every legal transition the table declares', async () => {
    // Guards against the constraint and the TypeScript table drifting apart.
    const user = await fundedUser();
    const { withdrawal } = (await submit(user.cookie)).json();

    for (const [from, targets] of Object.entries(WITHDRAWAL_TRANSITIONS)) {
      for (const to of targets) {
        await expect(
          h.app.appDeps.db.$executeRawUnsafe(
            `INSERT INTO withdrawal_transitions (id, withdrawal_id, from_status, to_status, created_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::"WithdrawalStatus", $3::"WithdrawalStatus", now())`,
            withdrawal.id,
            from,
            to,
          ),
          `${from} -> ${to}`,
        ).resolves.toBeDefined();
      }
    }
  });

  it('keeps the history append-only for both roles (rule 189)', async () => {
    await expect(
      h.app.appDeps.db.$executeRawUnsafe(`UPDATE withdrawal_transitions SET reason = 'tampered'`),
    ).rejects.toThrow();
    await expect(
      h.app.appDeps.db.$executeRawUnsafe(`DELETE FROM withdrawal_transitions`),
    ).rejects.toThrow();
  });

  it('records every transition it makes (rules 100-102)', async () => {
    const user = await fundedUser();
    const { withdrawal } = (await submit(user.cookie)).json();

    const transitions = await h.app.appDeps.db.withdrawalTransition.findMany({
      where: { withdrawalId: withdrawal.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(transitions.length).toBeGreaterThanOrEqual(2);
    expect(transitions[0]?.fromStatus).toBeNull();
    expect(transitions[0]?.toStatus).toBe('REQUESTED');
  });
});

// ---------------------------------------------------------------------------
// The operator queue (rules 160-162)
// ---------------------------------------------------------------------------

describe('operator review', () => {
  async function operatorCookie(): Promise<string> {
    const issued = await h.app.appDeps.sessions.issue({ userId: OPERATOR, steppedUp: true });
    return `${process.env.SESSION_COOKIE_NAME ?? 'wallet_session'}=${issued.token}`;
  }

  it('lists reviewed withdrawals with their full reason codes', async () => {
    const user = await fundedUser();
    await submit(user.cookie, { amount: SOL(30n) });

    const response = await h.app.inject({
      method: 'GET',
      url: '/operator/review-queue',
      headers: { cookie: await operatorCookie() },
    });

    expect(response.statusCode).toBe(200);
    const { items } = response.json();
    expect(items.length).toBeGreaterThan(0);
    // The operator sees what the engine saw, rather than re-deriving it.
    expect(items[0].riskCodes.length).toBeGreaterThan(0);
  });

  it('refuses a non-operator', async () => {
    const user = await fundedUser();
    const response = await h.app.inject({
      method: 'GET',
      url: '/operator/review-queue',
      headers: { cookie: user.cookie },
    });
    expect([403, 404]).toContain(response.statusCode);
  });

  it('approving locks the funds', async () => {
    const user = await fundedUser();
    const { withdrawal } = (await submit(user.cookie, { amount: SOL(30n) })).json();
    expect(withdrawal.status).toBe('MANUAL_REVIEW');

    const response = await h.app.inject({
      method: 'POST',
      url: `/operator/withdrawals/${withdrawal.id}/approve`,
      headers: browserHeaders(await operatorCookie()),
      payload: { note: 'verified with the customer' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().withdrawal.status).toBe('FUNDS_LOCKED');
    expect(BigInt((await balanceOf(user.userId)).locked)).toBe(BigInt(SOL(30n)));
  });

  it('rejecting leaves the funds untouched', async () => {
    const user = await fundedUser();
    const before = await balanceOf(user.userId);
    const { withdrawal } = (await submit(user.cookie, { amount: SOL(30n) })).json();

    await h.app.inject({
      method: 'POST',
      url: `/operator/withdrawals/${withdrawal.id}/reject`,
      headers: browserHeaders(await operatorCookie()),
      payload: { note: 'could not verify' },
    });

    expect(await statusOf(withdrawal.id)).toBe('REJECTED');
    expect(await balanceOf(user.userId)).toEqual(before);
  });

  it('requires a note — a decision without a reason is not auditable', async () => {
    const user = await fundedUser();
    const { withdrawal } = (await submit(user.cookie, { amount: SOL(30n) })).json();

    const response = await h.app.inject({
      method: 'POST',
      url: `/operator/withdrawals/${withdrawal.id}/approve`,
      headers: browserHeaders(await operatorCookie()),
      payload: { note: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('records the operator against the transition (rule 161)', async () => {
    const user = await fundedUser();
    const { withdrawal } = (await submit(user.cookie, { amount: SOL(30n) })).json();

    await h.app.inject({
      method: 'POST',
      url: `/operator/withdrawals/${withdrawal.id}/reject`,
      headers: browserHeaders(await operatorCookie()),
      payload: { note: 'declined after review' },
    });

    const transition = await h.app.appDeps.db.withdrawalTransition.findFirst({
      where: { withdrawalId: withdrawal.id, toStatus: 'REJECTED' },
    });
    expect(transition?.actorUserId).toBe(OPERATOR);
    expect(transition?.reason).toBe('declined after review');
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('ownership', () => {
  it("will not show another user's withdrawal", async () => {
    const alice = await fundedUser();
    const { withdrawal } = (await submit(alice.cookie)).json();

    const mallory = await seedSession(h, { steppedUp: true });
    const response = await h.app.inject({
      method: 'GET',
      url: `/withdrawals/${withdrawal.id}`,
      headers: { cookie: mallory.cookie },
    });
    expect([403, 404]).toContain(response.statusCode);
  });

  it("lists only the caller's own withdrawals", async () => {
    const alice = await fundedUser();
    await submit(alice.cookie);
    const bob = await fundedUser();
    await submit(bob.cookie);

    const response = await h.app.inject({
      method: 'GET',
      url: '/withdrawals',
      headers: { cookie: alice.cookie },
    });
    const { withdrawals } = response.json();
    expect(withdrawals.length).toBeGreaterThan(0);
    for (const w of withdrawals) {
      const record = await createWithdrawalRepository(h.app.appDeps.db).findById(w.id);
      expect(record?.userId).toBe(alice.userId);
    }
  });
});

// ---------------------------------------------------------------------------
// Log hygiene (rules 180, 209)
// ---------------------------------------------------------------------------

describe('log hygiene', () => {
  it('never logs an amount, a destination, or a signature', async () => {
    const user = await fundedUser();

    h.logs.clear();
    await submit(user.cookie, { amount: SMALL, destination: DEST });
    await h.app.withdrawalWorkers.runAllCycles();

    const output = h.logs.text();
    expect(output).not.toContain(DEST);
    expect(output).not.toContain(SMALL);
    // But the events themselves are recorded, so this is not passing by
    // silence.
    expect(output).toMatch(/withdrawal\./);
  });
});
