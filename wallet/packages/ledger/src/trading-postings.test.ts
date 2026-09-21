import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  accountKey,
  checkAllInvariants,
  checkLiabilitiesCovered,
  clearingAssets,
  chainAssets,
  isBalanced,
  InvalidEntryError,
  postAllocation,
  postDeallocation,
  postDeposit,
  postOrderHold,
  postOrderRelease,
  postWithdrawalLock,
  projectAll,
  userOrderLocked,
  userTradingAvailable,
  userCustodyAvailable,
  userCustodyLocked,
  type AccountRef,
  type Entry,
} from './index.js';

const SOL = 'devnet:SOL';
const ONE = 1_000_000_000n;

/** A signed balance in the account's NORMAL direction, for readable asserts. */
function balance(entries: readonly Entry[], ref: AccountRef): bigint {
  const projected = projectAll(entries).get(accountKey(ref));
  if (!projected) return 0n;
  const liability = ref.type.startsWith('user_') || ref.type.startsWith('house_');
  return liability ? -projected.balance : projected.balance;
}

/**
 * A user who deposited, had the allocation's withdrawal lock applied, and then
 * saw the on-chain transfer settle — the full ADR-0025 path into the clearing
 * tier.
 */
function allocated(amount = 4n * ONE, deposit = 10n * ONE): Entry[] {
  return [
    ...postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount: deposit }).entries,
    ...postWithdrawalLock({ withdrawalId: 'a1', userId: 'u1', asset: SOL, amount }).entries,
    ...postAllocation({ allocationId: 'a1', userId: 'u1', asset: SOL, amount }).entries,
  ];
}

describe('postAllocation', () => {
  it('is four balanced legs across both tiers', () => {
    const tx = postAllocation({ allocationId: 'a1', userId: 'u1', asset: SOL, amount: ONE });
    expect(tx.entries).toHaveLength(4);
    expect(isBalanced(tx.entries)).toBe(true);
    expect(tx.kind).toBe('allocation');
  });

  it('moves the liability from the vault to the clearing tier', () => {
    const entries = allocated(4n * ONE);
    expect(balance(entries, userCustodyAvailable('u1', SOL))).toBe(6n * ONE);
    expect(balance(entries, userCustodyLocked('u1', SOL))).toBe(0n);
    expect(balance(entries, userTradingAvailable('u1', SOL))).toBe(4n * ONE);
  });

  it('moves the asset from the user address to the clearing address', () => {
    const entries = allocated(4n * ONE);
    expect(balance(entries, chainAssets('u1', SOL))).toBe(6n * ONE);
    expect(balance(entries, clearingAssets(SOL))).toBe(4n * ONE);
  });

  /**
   * Regression. Adding the trading accounts to USER_LIABILITY_ACCOUNT_TYPES
   * made the coverage check count trading liabilities against chain_assets
   * alone — so every allocation read as a shortfall of exactly its own amount,
   * because the coins had moved to an address the check did not look at.
   */
  it('does not read as a shortfall in either tier', () => {
    const entries = allocated(4n * ONE);
    expect(checkLiabilitiesCovered(entries)).toEqual([]);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('refuses a non-positive amount', () => {
    expect(() =>
      postAllocation({ allocationId: 'a1', userId: 'u1', asset: SOL, amount: 0n }),
    ).toThrow(InvalidEntryError);
  });
});

describe('postDeallocation', () => {
  it('is the exact inverse of an allocation', () => {
    const entries = [
      ...allocated(4n * ONE),
      ...postDeallocation({ allocationId: 'a2', userId: 'u1', asset: SOL, amount: 4n * ONE })
        .entries,
    ];
    expect(balance(entries, userTradingAvailable('u1', SOL))).toBe(0n);
    expect(balance(entries, clearingAssets(SOL))).toBe(0n);
    expect(balance(entries, chainAssets('u1', SOL))).toBe(10n * ONE);
    expect(balance(entries, userCustodyAvailable('u1', SOL))).toBe(10n * ONE);
    expect(checkAllInvariants(entries)).toEqual([]);
  });
});

describe('postOrderHold / postOrderRelease', () => {
  it('reserves within the trading tier without touching either address', () => {
    const entries = [
      ...allocated(4n * ONE),
      ...postOrderHold({ orderId: 'o1', userId: 'u1', asset: SOL, amount: ONE }).entries,
    ];
    expect(balance(entries, userTradingAvailable('u1', SOL))).toBe(3n * ONE);
    expect(balance(entries, userOrderLocked('u1', SOL))).toBe(ONE);
    // A hold is a reservation, not a movement: the clearing address is unchanged.
    expect(balance(entries, clearingAssets(SOL))).toBe(4n * ONE);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('a release is the exact inverse of the hold', () => {
    const entries = [
      ...allocated(4n * ONE),
      ...postOrderHold({ orderId: 'o1', userId: 'u1', asset: SOL, amount: ONE }).entries,
      ...postOrderRelease({ orderId: 'o1', userId: 'u1', asset: SOL, amount: ONE }).entries,
    ];
    expect(balance(entries, userTradingAvailable('u1', SOL))).toBe(4n * ONE);
    expect(balance(entries, userOrderLocked('u1', SOL))).toBe(0n);
  });

  // An overdrawn hold drives the trading balance negative. The in-memory
  // invariant catches it — but NOTHING in PostgreSQL does: the deferred trigger
  // enforces per-asset balance only. The caller's SERIALIZABLE read-then-post
  // is the only thing that prevents this on write.
  it('an unfunded hold violates the non-negative invariant', () => {
    const entries = [
      ...allocated(ONE),
      ...postOrderHold({ orderId: 'o1', userId: 'u1', asset: SOL, amount: 2n * ONE }).entries,
    ];
    const violations = checkAllInvariants(entries);
    expect(violations.some((v) => v.invariant !== 'liabilities_covered')).toBe(true);
  });

  it('never borrows from the vault tier to fund an order', () => {
    // 10 SOL deposited, none allocated. The vault balance is irrelevant: an
    // order draws only on the trading tier.
    const entries = [
      ...postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount: 10n * ONE }).entries,
      ...postOrderHold({ orderId: 'o1', userId: 'u1', asset: SOL, amount: ONE }).entries,
    ];
    expect(checkAllInvariants(entries).length).toBeGreaterThan(0);
  });
});

describe('the two tiers are reconciled separately', () => {
  // A surplus in one tier must not hide a shortfall in the other.
  it('reports a clearing shortfall even when the vault has a surplus', () => {
    const entries = [
      ...postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount: 10n * ONE }).entries,
      // A trading credit with no clearing asset behind it — the corruption the
      // clearing equation exists to catch.
      {
        account: userTradingAvailable('u2', SOL),
        asset: SOL,
        amount: ONE,
        direction: 'credit' as const,
      },
      {
        account: chainAssets('u1', SOL),
        asset: SOL,
        amount: ONE,
        direction: 'debit' as const,
      },
    ];
    const violations = checkLiabilitiesCovered(entries);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail.tier).toBe('clearing');
  });
});

describe('properties', () => {
  const op = fc.oneof(
    fc.record({ kind: fc.constant('allocate' as const), amount: fc.bigInt({ min: 1n, max: 3n }) }),
    fc.record({ kind: fc.constant('hold' as const), amount: fc.bigInt({ min: 1n, max: 3n }) }),
    fc.record({ kind: fc.constant('release' as const), amount: fc.bigInt({ min: 1n, max: 3n }) }),
    fc.record({
      kind: fc.constant('deallocate' as const),
      amount: fc.bigInt({ min: 1n, max: 3n }),
    }),
  );

  /**
   * Any sequence of allocations, holds, releases and deallocations — applied
   * only when the source balance can cover it, exactly as the database would
   * refuse otherwise — leaves both tiers covered and the books balanced.
   */
  it('keeps the books balanced and both tiers covered', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        let entries: Entry[] = [
          ...postDeposit({ depositId: 'd', userId: 'u1', asset: SOL, amount: 20n * ONE }).entries,
        ];
        let n = 0;
        for (const { kind, amount } of ops) {
          const value = amount * ONE;
          const id = `x${n++}`;
          const custody = balance(entries, userCustodyAvailable('u1', SOL));
          const trading = balance(entries, userTradingAvailable('u1', SOL));
          const locked = balance(entries, userOrderLocked('u1', SOL));

          if (kind === 'allocate' && custody >= value) {
            entries = [
              ...entries,
              ...postWithdrawalLock({ withdrawalId: id, userId: 'u1', asset: SOL, amount: value })
                .entries,
              ...postAllocation({ allocationId: id, userId: 'u1', asset: SOL, amount: value })
                .entries,
            ];
          } else if (kind === 'hold' && trading >= value) {
            entries = [
              ...entries,
              ...postOrderHold({ orderId: id, userId: 'u1', asset: SOL, amount: value }).entries,
            ];
          } else if (kind === 'release' && locked >= value) {
            entries = [
              ...entries,
              ...postOrderRelease({ orderId: id, userId: 'u1', asset: SOL, amount: value }).entries,
            ];
          } else if (kind === 'deallocate' && trading >= value) {
            entries = [
              ...entries,
              ...postDeallocation({ allocationId: id, userId: 'u1', asset: SOL, amount: value })
                .entries,
            ];
          }
          expect(checkAllInvariants(entries)).toEqual([]);
        }
        // Conservation across both tiers: nothing was created or destroyed.
        const total =
          balance(entries, userCustodyAvailable('u1', SOL)) +
          balance(entries, userCustodyLocked('u1', SOL)) +
          balance(entries, userTradingAvailable('u1', SOL)) +
          balance(entries, userOrderLocked('u1', SOL));
        expect(total).toBe(20n * ONE);
      }),
      { numRuns: 300 },
    );
  });
});
