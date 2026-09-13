import { Transaction } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSigner, type MockSigner } from '@wallet/blockchain';
import { createWithdrawalRepository } from '@wallet/db';
import { NATIVE_ASSET } from '@wallet/solana';
import {
  browserHeaders,
  creditUser,
  fundHouse,
  markDestinationKnown,
  seedDepositAddress,
  seedNonceAccounts,
  seedSession,
  SOL_KEY,
  startHarness,
  usesConfiguredSigner,
  type Harness,
} from './helpers.js';
import {
  createFakeBroadcaster,
  createFakeNonceManager,
  type FakeBroadcaster,
  type FakeNonceManager,
} from './fake-withdrawal-chain.js';

/**
 * The segregated withdrawal (ADR-0020 §3).
 *
 * The claim being tested is narrow and load-bearing: money leaves the USER's
 * own address, signed by the USER's own key, while the house pays the fee.
 *
 * It is tested against the BYTES rather than against the ledger, because the
 * ledger would look identical if the transaction were paying out of the
 * treasury — which is the exact failure segregation exists to prevent, and the
 * one nothing else in the suite would catch.
 */

// The mock signer provisions deterministic per-user keys. It cannot be used
// with the configured signer, which reaches a coordinator that may not exist.
const segregated = usesConfiguredSigner() ? describe.skip : describe;

let h: Harness;
let nonces: FakeNonceManager;
let broadcaster: FakeBroadcaster;
let signer: MockSigner;

const ONE_SOL = 1_000_000_000n;
const SOL = (n: bigint): string => (n * ONE_SOL).toString();
const DEST = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

beforeAll(async () => {
  nonces = createFakeNonceManager();
  broadcaster = createFakeBroadcaster();
  signer = createMockSigner({ onBanner: () => undefined });

  h = await startHarness({
    nonceManager: nonces,
    broadcaster,
    signer,
    segregatedCustody: true,
  });
  await fundHouse(h, SOL_KEY, SOL(50n));
  await seedNonceAccounts(h, nonces, 20);
});

afterAll(async () => {
  await h.cleanup();
});

let counter = 0;

async function lockedWithdrawal(): Promise<{
  id: string;
  userId: string;
  userAddress: string;
}> {
  const session = await seedSession(h, { steppedUp: true });
  const { address } = await seedDepositAddress(h, session.userId);
  await creditUser(h, session.userId, SOL_KEY, SOL(10n));
  await markDestinationKnown(h, session.userId, SOL_KEY, DEST);

  const response = await h.app.inject({
    method: 'POST',
    url: '/withdrawals',
    headers: browserHeaders(session.cookie),
    payload: {
      asset: NATIVE_ASSET,
      amount: SOL(1n),
      destination: DEST,
      idempotencyKey: `seg-${Date.now()}-${(counter += 1)}`,
    },
  });

  const { withdrawal } = response.json();
  if (withdrawal?.status !== 'FUNDS_LOCKED') {
    throw new Error(`expected FUNDS_LOCKED, got ${withdrawal?.status} (${response.body})`);
  }
  return { id: withdrawal.id, userId: session.userId, userAddress: address };
}

segregated('a withdrawal paid from the user’s own address', () => {
  it('gives two users two different addresses', async () => {
    const one = await seedSession(h);
    const two = await seedSession(h);

    const a = await seedDepositAddress(h, one.userId);
    const b = await seedDepositAddress(h, two.userId);

    // The whole model in one assertion: no shared key, no shared address.
    expect(a.address).not.toBe(b.address);
  });

  it('records the address as a provisioned group, not a derived path', async () => {
    const session = await seedSession(h);
    const { addressId } = await seedDepositAddress(h, session.userId);

    const row = await h.app.appDeps.db.address.findUnique({ where: { id: addressId } });
    // There is no seed and no index behind this address (ADR-0020), and the
    // stored path has to say so — a `m/44'/501'/...` here would mean the
    // deployment silently fell back to derivation.
    expect(row?.derivationPath).toMatch(/^frost:3-of-5:user:/);
  });

  it('debits the USER on-chain and charges the fee to the house', async () => {
    const { id, userAddress } = await lockedWithdrawal();

    await h.app.withdrawalWorkers.runSigningCycle();
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const raw = broadcaster.lastRaw();
    expect(raw).toBeTruthy();

    const parsed = Transaction.from(Buffer.from(raw!));
    const transfer = parsed.instructions.at(-1);

    // The account the lamports leave. If this were the treasury, every
    // customer's withdrawal would be paid out of the house's own funds.
    expect(transfer?.keys[0]?.pubkey.toBase58()).toBe(userAddress);
    expect(transfer?.keys[1]?.pubkey.toBase58()).toBe(DEST);

    // And the fee payer is NOT the user: a segregated address holds no SOL of
    // its own beyond what was deposited to it.
    expect(parsed.feePayer?.toBase58()).not.toBe(userAddress);

    expect(await statusOf(id)).toBe('BROADCAST');
  });

  it('carries a signature from each of the two signers', async () => {
    await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();
    await h.app.withdrawalWorkers.runBroadcastCycle();

    const parsed = Transaction.from(Buffer.from(broadcaster.lastRaw()!));
    const present = parsed.signatures.filter((entry) => entry.signature !== null);

    // Two rounds, two signatures. One would mean the transaction is
    // half-signed and would be refused on-chain — after a nonce was consumed.
    expect(present).toHaveLength(2);
  });

  it('runs one signing round per key, under distinct request ids', async () => {
    const { id, userId } = await lockedWithdrawal();
    await h.app.withdrawalWorkers.runSigningCycle();

    const requests = await h.app.appDeps.db.signingRequest.findMany({
      where: { withdrawalId: id },
      orderBy: { requestId: 'asc' },
    });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.outcome === 'succeeded')).toBe(true);

    // Distinct ids, because the signing service is idempotent ON THE ID: a
    // shared id would hand the house's signature back for the user's key and
    // the transaction would carry the same signature twice.
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(2);

    // One of them signs with the USER's key, and it is named as such.
    expect(requests.some((request) => request.keyRef === `user:${userId}`)).toBe(true);
  });
});

const statusOf = async (id: string): Promise<string> =>
  (await createWithdrawalRepository(h.app.appDeps.db).findById(id))!.status;
