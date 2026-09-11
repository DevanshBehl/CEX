import { describe, expect, it } from 'vitest';
import {
  checkAllInvariants,
  postHouseFunding,
  chainAssets,
  InvalidEntryError,
  isBalanced,
  postDeposit,
  postNonceAccountRent,
  postWithdrawalLock,
  postWithdrawalRelease,
  postWithdrawalSettlement,
  projectAll,
  projectUserBalance,
  accountKey,
  type Entry,
} from './index.js';

const SOL = 'SOL';
const ONE = 1_000_000_000n;

/** A user funded by a deposit, as every withdrawal test needs. */
function funded(amount = 10n * ONE): Entry[] {
  return [...postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount }).entries];
}

/**
 * The platform's own operating balance, from which network fees are paid.
 *
 * Without this the fee comes out of the pooled assets backing user balances,
 * and `liabilities_covered` correctly reports a shortfall — see the note on
 * `postHouseFunding`.
 */
function houseFunded(amount = ONE): Entry[] {
  return [...postHouseFunding({ reference: 'treasury-1', asset: SOL, amount }).entries];
}

describe('locking (rules 109-114)', () => {
  it('moves value from available to locked without changing the total', () => {
    const entries = [
      ...funded(),
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 3n * ONE })
        .entries,
    ];

    const balance = projectUserBalance('u1', SOL, entries);
    expect(balance.available).toBe(7n * ONE);
    expect(balance.locked).toBe(3n * ONE);
    // A reservation changes spendability, not ownership.
    expect(balance.total).toBe(10n * ONE);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('balances', () => {
    const tx = postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: ONE });
    expect(isBalanced(tx.entries)).toBe(true);
    expect(tx.kind).toBe('withdrawal_lock');
    expect(tx.referenceId).toBe('w1');
  });

  it('refuses a zero or negative lock', () => {
    for (const amount of [0n, -1n]) {
      expect(() =>
        postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount }),
      ).toThrow(InvalidEntryError);
    }
  });

  it('overdrawing shows up as a negative available balance', () => {
    // The pure layer cannot refuse this — it has no view of the balance. The
    // invariant check is what catches it, and in the real system the database
    // transaction is what prevents it.
    const entries = [
      ...funded(ONE),
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 5n * ONE })
        .entries,
    ];
    const violations = checkAllInvariants(entries);
    expect(violations.some((v) => v.invariant === 'no_negative_user_balance')).toBe(true);
  });
});

describe('release (rule 115)', () => {
  it('is the exact inverse of a lock', () => {
    const before = funded();
    const entries = [
      ...before,
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 4n * ONE })
        .entries,
      ...postWithdrawalRelease({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 4n * ONE })
        .entries,
    ];

    expect(projectUserBalance('u1', SOL, entries)).toEqual(projectUserBalance('u1', SOL, before));
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('leaves nothing locked after a full release', () => {
    const entries = [
      ...funded(),
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 2n * ONE })
        .entries,
      ...postWithdrawalRelease({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 2n * ONE })
        .entries,
    ];
    expect(projectUserBalance('u1', SOL, entries).locked).toBe(0n);
  });
});

describe('settlement (rules 116-119)', () => {
  it('discharges the liability and reduces chain assets', () => {
    const entries = [
      ...funded(),
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 3n * ONE })
        .entries,
      ...postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: SOL,
        amount: 3n * ONE,
      }).entries,
    ];

    const balance = projectUserBalance('u1', SOL, entries);
    expect(balance.locked).toBe(0n);
    expect(balance.available).toBe(7n * ONE);
    expect(balance.total).toBe(7n * ONE);

    // The only place chain_assets goes down.
    const chain = projectAll(entries).get(accountKey(chainAssets(SOL)));
    expect(chain?.balance).toBe(7n * ONE);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('charges the network fee to the house, not to the user', () => {
    const fee = 5_000n;
    const entries = [
      ...houseFunded(),
      ...funded(),
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 3n * ONE })
        .entries,
      ...postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: SOL,
        amount: 3n * ONE,
        networkFee: fee,
      }).entries,
    ];

    // The user is debited exactly what they asked to withdraw.
    expect(projectUserBalance('u1', SOL, entries).total).toBe(7n * ONE);
    // And the fee leaves the platform on top of it, drawn from the house's own
    // prepaid balance rather than from the pool backing user funds.
    const chain = projectAll(entries).get(accountKey(chainAssets(SOL)));
    expect(chain?.balance).toBe(7n * ONE + ONE - fee);
    expect(isBalanced(entries)).toBe(true);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('refuses to let the house pay a fee it has not funded', () => {
    // The invariant that caught this the first time: an unfunded fee is paid
    // out of customer money, and the books say so.
    const entries = [
      ...funded(),
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: ONE }).entries,
      ...postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: SOL,
        amount: ONE,
        networkFee: 5_000n,
      }).entries,
    ];

    const violations = checkAllInvariants(entries);
    expect(violations.some((v) => v.invariant === 'liabilities_covered')).toBe(true);
    expect(violations.some((v) => v.invariant === 'account_sign')).toBe(true);
  });

  it('refuses a negative fee', () => {
    expect(() =>
      postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: SOL,
        amount: ONE,
        networkFee: -1n,
      }),
    ).toThrow(InvalidEntryError);
  });

  it('keeps the books balanced through the whole lifecycle (rule 174)', () => {
    // Every prefix of the sequence must balance, not just the end — a
    // half-applied lock is the failure mode that loses money quietly.
    const steps = [
      houseFunded(),
      funded(),
      postWithdrawalLock({ withdrawalId: 'w1', userId: 'u1', asset: SOL, amount: 3n * ONE })
        .entries,
      postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: SOL,
        amount: 3n * ONE,
        networkFee: 5_000n,
      }).entries,
    ];

    const accumulated: Entry[] = [];
    for (const step of steps) {
      accumulated.push(...step);
      expect(isBalanced(accumulated)).toBe(true);
      expect(checkAllInvariants(accumulated)).toEqual([]);
    }
  });
});

describe('nonce account rent (ADR-0009)', () => {
  it('moves the minimum into house_rent, not to any user', () => {
    const rent = 1_447_680n; // a nonce account's rent-exempt minimum
    const entries = [
      ...funded(),
      ...postNonceAccountRent({ nonceAccountId: 'n1', asset: SOL, amount: rent }).entries,
    ];
    expect(isBalanced(entries)).toBe(true);
    expect(projectUserBalance('u1', SOL, entries).total).toBe(10n * ONE);
    expect(checkAllInvariants(entries)).toEqual([]);
  });
});
