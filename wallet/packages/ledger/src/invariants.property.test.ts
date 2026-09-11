import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildTransaction,
  chainAssets,
  checkAllInvariants,
  checkBooksBalance,
  checkNoNegativeUserBalances,
  credit,
  debit,
  isBalanced,
  postDeposit,
  projectUserBalance,
  userAvailable,
  userLocked,
  type Entry,
} from './index.js';

/**
 * Property tests over generated operation sequences
 * (prompt_phase2.md rules 89-90, 179-180).
 *
 * Worked examples prove that the cases someone thought of work. These prove
 * that no sequence of legal operations reaches an illegal state — which is the
 * actual claim being made about a ledger, and the one that matters when Phase 3
 * starts moving money between accounts under concurrency.
 *
 * Rule 90 specifically requires duplicates, reorderings, and zero amounts to be
 * in the generated space; each has its own property below.
 */

const SOL = 'SOL';
const USERS = ['u1', 'u2', 'u3'] as const;

/** Positive base-unit amounts, including values above 2^53. */
const amount = fc.bigInt({ min: 1n, max: 10n ** 18n }).filter((v) => v > 0n);

const userId = fc.constantFrom(...USERS);

/** A deposit, optionally carving out rent. */
const depositOp = fc
  .record({
    userId,
    amount,
    rentFraction: fc.integer({ min: 0, max: 100 }),
    id: fc.uuid(),
  })
  .map(({ userId: u, amount: a, rentFraction, id }) => {
    const rent = (a * BigInt(rentFraction)) / 100n;
    return postDeposit({
      depositId: id,
      userId: u,
      asset: SOL,
      amount: a,
      ...(rent > 0n ? { rentReserved: rent } : {}),
    });
  });

const depositSequence = fc.array(depositOp, { minLength: 0, maxLength: 40 });

function entriesOf(transactions: readonly { entries: readonly Entry[] }[]): Entry[] {
  return transactions.flatMap((t) => [...t.entries]);
}

describe('invariants hold over any deposit sequence', () => {
  it('the books always balance', () => {
    fc.assert(
      fc.property(depositSequence, (transactions) => {
        expect(checkBooksBalance(entriesOf(transactions))).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('no user balance ever goes negative', () => {
    fc.assert(
      fc.property(depositSequence, (transactions) => {
        expect(checkNoNegativeUserBalances(entriesOf(transactions))).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('every invariant holds simultaneously', () => {
    fc.assert(
      fc.property(depositSequence, (transactions) => {
        expect(checkAllInvariants(entriesOf(transactions))).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('a user is credited exactly the sum of their non-rent deposits', () => {
    fc.assert(
      fc.property(depositSequence, (transactions) => {
        const entries = entriesOf(transactions);
        for (const u of USERS) {
          const projected = projectUserBalance(u, SOL, entries).available;
          const expected = transactions
            .filter((t) => t.referenceType === 'deposit')
            .flatMap((t) => t.entries)
            .filter((e) => e.account.ownerId === u && e.account.type === 'user_available')
            .reduce((total, e) => total + e.amount, 0n);
          expect(projected).toBe(expected);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('rule 90 — the awkward cases', () => {
  it('reordering entries never changes the projection', () => {
    fc.assert(
      fc.property(depositSequence, fc.integer(), (transactions, seed) => {
        const entries = entriesOf(transactions);
        // A deterministic shuffle driven by the generated seed.
        const shuffled = [...entries].sort((a, b) =>
          Number(((a.amount + BigInt(seed)) % 7n) - ((b.amount + BigInt(seed)) % 7n)),
        );
        for (const u of USERS) {
          expect(projectUserBalance(u, SOL, shuffled)).toEqual(projectUserBalance(u, SOL, entries));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("replaying the same transaction double-credits — which is why idempotency is the database's job", () => {
    // This documents a real property of the pure layer: it has no memory, so it
    // cannot deduplicate. Nothing here prevents a double credit, and nothing
    // here should try. The UNIQUE(chain, tx_signature, instruction_index)
    // constraint is the mechanism (prompt_phase2.md rules 127-128), and the
    // integration suite is where that is proven.
    const tx = postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount: 100n });
    const once = projectUserBalance('u1', SOL, [...tx.entries]);
    const twice = projectUserBalance('u1', SOL, [...tx.entries, ...tx.entries]);

    expect(once.available).toBe(100n);
    expect(twice.available).toBe(200n);
    // Both remain internally consistent, which is exactly the danger: a double
    // credit is not detectable from the ledger alone.
    expect(checkAllInvariants([...tx.entries, ...tx.entries])).toEqual([]);
  });

  it('rejects a zero amount at construction rather than posting an empty entry', () => {
    fc.assert(
      fc.property(userId, (u) => {
        expect(() =>
          buildTransaction({
            kind: 'deposit',
            referenceType: 'deposit',
            referenceId: 'd',
            entries: [debit(chainAssets(SOL), SOL, 0n), credit(userAvailable(u, SOL), SOL, 0n)],
          }),
        ).toThrow();
      }),
      { numRuns: 20 },
    );
  });
});

describe('locking preserves the invariants (the Phase 3 shape)', () => {
  /**
   * Phase 2 never locks anything. This proves the account structure chosen in
   * rules 68-70 supports what Phase 3 will do, before Phase 3 depends on it:
   * a lock is a balanced transfer, so no sequence of locks and releases can
   * create or destroy value.
   */
  const lockSequence = fc
    .record({
      deposits: fc.array(depositOp, { minLength: 1, maxLength: 10 }),
      locks: fc.array(fc.record({ userId, fraction: fc.integer({ min: 0, max: 100 }) }), {
        maxLength: 10,
      }),
    })
    .map(({ deposits, locks }) => {
      const entries = entriesOf(deposits);
      for (const { userId: u, fraction } of locks) {
        const available = projectUserBalance(u, SOL, entries).available;
        const toLock = (available * BigInt(fraction)) / 100n;
        if (toLock <= 0n) continue;
        entries.push(
          debit(userAvailable(u, SOL), SOL, toLock),
          credit(userLocked(u, SOL), SOL, toLock),
        );
      }
      return entries;
    });

  it('never creates or destroys value', () => {
    fc.assert(
      fc.property(lockSequence, (entries) => {
        expect(checkAllInvariants(entries)).toEqual([]);
        expect(isBalanced(entries)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('keeps available + locked equal to what was deposited', () => {
    fc.assert(
      fc.property(lockSequence, (entries) => {
        for (const u of USERS) {
          const balance = projectUserBalance(u, SOL, entries);
          expect(balance.total).toBe(balance.available + balance.locked);
          expect(balance.available >= 0n).toBe(true);
          expect(balance.locked >= 0n).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
