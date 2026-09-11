import { describe, expect, it } from 'vitest';
import { asBaseUnits } from '@wallet/types';
import {
  add,
  buildTransaction,
  chainAssets,
  checkAllInvariants,
  checkBooksBalance,
  checkLiabilitiesCovered,
  checkNoNegativeUserBalances,
  credit,
  debit,
  formatForDisplay,
  houseRent,
  InvalidEntryError,
  isBalanced,
  postDeposit,
  projectUserBalance,
  toAmount,
  toBaseUnits,
  UnbalancedTransactionError,
  userAvailable,
  userLocked,
  type Entry,
} from './index.js';

const SOL = 'SOL';
const LAMPORTS_PER_SOL = 1_000_000_000n;

describe('amounts (rules 59-64)', () => {
  it('round-trips through the base-unit string boundary', () => {
    expect(toBaseUnits(toAmount('1234567890123456789'))).toBe('1234567890123456789');
  });

  it('holds values a JS number would silently mangle', () => {
    // 2^53 + 1: not representable as a double.
    const big = toAmount('9007199254740993');
    expect(toBaseUnits(big)).toBe('9007199254740993');
    expect(toBaseUnits(add(big, 1n))).toBe('9007199254740994');
    expect(String(Number('9007199254740993'))).not.toBe('9007199254740993');
  });

  it('rejects anything that is not an integer string', () => {
    for (const bad of ['1.5', '1e9', '', ' 1', '01', 'NaN']) {
      expect(() => toAmount(bad), bad).toThrow();
    }
  });

  it('formats for display without touching arithmetic', () => {
    expect(formatForDisplay(LAMPORTS_PER_SOL, 9)).toBe('1.000000000');
    expect(formatForDisplay(1n, 9)).toBe('0.000000001');
    expect(formatForDisplay(-1n, 9)).toBe('-0.000000001');
    expect(formatForDisplay(0n, 9)).toBe('0.000000000');
    expect(formatForDisplay(123n, 0)).toBe('123');
  });
});

describe('transaction construction (rules 76-81)', () => {
  const balanced: Entry[] = [
    debit(chainAssets(SOL), SOL, LAMPORTS_PER_SOL),
    credit(userAvailable('u1', SOL), SOL, LAMPORTS_PER_SOL),
  ];

  it('accepts a balanced transaction', () => {
    const tx = buildTransaction({
      kind: 'deposit',
      referenceType: 'deposit',
      referenceId: 'd1',
      entries: balanced,
    });
    expect(tx.entries).toHaveLength(2);
    expect(isBalanced(tx.entries)).toBe(true);
  });

  it('rejects an unbalanced transaction', () => {
    expect(() =>
      buildTransaction({
        kind: 'deposit',
        referenceType: 'deposit',
        referenceId: 'd1',
        entries: [
          debit(chainAssets(SOL), SOL, LAMPORTS_PER_SOL),
          credit(userAvailable('u1', SOL), SOL, LAMPORTS_PER_SOL - 1n),
        ],
      }),
    ).toThrow(UnbalancedTransactionError);
  });

  it('rejects a single-entry transaction', () => {
    expect(() =>
      buildTransaction({
        kind: 'deposit',
        referenceType: 'deposit',
        referenceId: 'd1',
        entries: [debit(chainAssets(SOL), SOL, 1n)],
      }),
    ).toThrow(InvalidEntryError);
  });

  it('rejects zero and negative amounts', () => {
    for (const amount of [0n, -1n]) {
      expect(() =>
        buildTransaction({
          kind: 'deposit',
          referenceType: 'deposit',
          referenceId: 'd1',
          entries: [
            debit(chainAssets(SOL), SOL, amount),
            credit(userAvailable('u1', SOL), SOL, amount),
          ],
        }),
      ).toThrow(InvalidEntryError);
    }
  });

  it('balances per asset, not in aggregate (rule 79)', () => {
    // +1 SOL and -1 USDC sums to zero only if the two are interchangeable.
    expect(() =>
      buildTransaction({
        kind: 'deposit',
        referenceType: 'deposit',
        referenceId: 'd1',
        entries: [
          debit(chainAssets(SOL), SOL, 1n),
          credit({ ownerId: null, asset: 'USDC', type: 'chain_assets' }, 'USDC', 1n),
        ],
      }),
    ).toThrow(UnbalancedTransactionError);
  });

  it('rejects an entry whose asset disagrees with its account', () => {
    expect(() =>
      buildTransaction({
        kind: 'deposit',
        referenceType: 'deposit',
        referenceId: 'd1',
        entries: [
          { account: chainAssets(SOL), asset: 'USDC', amount: 1n, direction: 'debit' },
          credit(userAvailable('u1', SOL), SOL, 1n),
        ],
      }),
    ).toThrow(InvalidEntryError);
  });
});

describe('deposit posting (rules 156-158)', () => {
  it('debits chain assets and credits the user', () => {
    const tx = postDeposit({
      depositId: 'd1',
      userId: 'u1',
      asset: SOL,
      amount: LAMPORTS_PER_SOL,
    });
    expect(isBalanced(tx.entries)).toBe(true);

    const balance = projectUserBalance('u1', SOL, tx.entries);
    expect(balance.available).toBe(LAMPORTS_PER_SOL);
    expect(balance.locked).toBe(0n);
  });

  it('routes a rent-exempt minimum to house_rent, not to the user', () => {
    const rent = 890_880n; // a realistic rent-exempt minimum for a bare account
    const tx = postDeposit({
      depositId: 'd1',
      userId: 'u1',
      asset: SOL,
      amount: LAMPORTS_PER_SOL,
      rentReserved: rent,
    });

    expect(isBalanced(tx.entries)).toBe(true);
    // The user is credited only what they can actually withdraw.
    expect(projectUserBalance('u1', SOL, tx.entries).available).toBe(LAMPORTS_PER_SOL - rent);
    // And the rest is accounted for rather than lost.
    expect(checkBooksBalance(tx.entries)).toEqual([]);
  });

  it('refuses to reserve more rent than the transfer carried', () => {
    expect(() =>
      postDeposit({
        depositId: 'd1',
        userId: 'u1',
        asset: SOL,
        amount: 100n,
        rentReserved: 101n,
      }),
    ).toThrow(InvalidEntryError);
  });

  it('refuses a zero or negative deposit', () => {
    for (const amount of [0n, -1n]) {
      expect(() => postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount })).toThrow(
        InvalidEntryError,
      );
    }
  });

  it('handles a deposit that is entirely rent', () => {
    const tx = postDeposit({
      depositId: 'd1',
      userId: 'u1',
      asset: SOL,
      amount: 890_880n,
      rentReserved: 890_880n,
    });
    expect(isBalanced(tx.entries)).toBe(true);
    expect(projectUserBalance('u1', SOL, tx.entries).available).toBe(0n);
  });
});

describe('projections (rules 82-85)', () => {
  it('separates available from locked', () => {
    const entries: Entry[] = [
      ...postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount: 100n }).entries,
      // What Phase 3 will do on approval: a balanced transfer between two
      // accounts, not a mutation.
      debit(userAvailable('u1', SOL), SOL, 30n),
      credit(userLocked('u1', SOL), SOL, 30n),
    ];

    const balance = projectUserBalance('u1', SOL, entries);
    expect(balance.available).toBe(70n);
    expect(balance.locked).toBe(30n);
    expect(balance.total).toBe(100n);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('ignores other users and other assets', () => {
    const entries: Entry[] = [
      ...postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount: 100n }).entries,
      ...postDeposit({ depositId: 'd2', userId: 'u2', asset: SOL, amount: 500n }).entries,
    ];
    expect(projectUserBalance('u1', SOL, entries).available).toBe(100n);
    expect(projectUserBalance('u1', 'USDC', entries).available).toBe(0n);
  });

  it('reports an unknown user as zero rather than failing', () => {
    expect(projectUserBalance('nobody', SOL, []).total).toBe(0n);
  });
});

describe('invariants (rules 86-88)', () => {
  it('detects books that do not balance', () => {
    const violations = checkBooksBalance([debit(chainAssets(SOL), SOL, 5n)]);
    expect(violations[0]?.invariant).toBe('books_balance');
    expect(violations[0]?.detail.residual).toBe('5');
  });

  it('detects a negative user balance', () => {
    const entries: Entry[] = [
      debit(userAvailable('u1', SOL), SOL, 10n),
      credit(chainAssets(SOL), SOL, 10n),
    ];
    expect(checkNoNegativeUserBalances(entries)[0]?.invariant).toBe('no_negative_user_balance');
  });

  it('detects liabilities exceeding chain assets', () => {
    // Deliberately unbalanced: owe 100 while controlling 40. On a balanced
    // ledger this check cannot fire — coverage follows from double-entry — so
    // it is a redundancy check against a state that is already corrupt.
    const entries: Entry[] = [
      debit(chainAssets(SOL), SOL, 40n),
      credit(userAvailable('u1', SOL), SOL, 100n),
    ];
    const violations = checkLiabilitiesCovered(entries);
    expect(violations[0]?.invariant).toBe('liabilities_covered');
    expect(violations[0]?.detail.shortfall).toBe('60');
    // The books-balance check catches the same corruption independently.
    expect(checkBooksBalance(entries).length).toBeGreaterThan(0);
  });

  it('treats rent as a claim on assets, not as spendable (rule 158)', () => {
    // 1000 received, 890 immobilised as rent. Claims (110 owed + 890 rent)
    // equal assets (1000), and the 110 credited is exactly what is spendable.
    const entries: readonly Entry[] = postDeposit({
      depositId: 'd1',
      userId: 'u1',
      asset: SOL,
      amount: 1000n,
      rentReserved: 890n,
    }).entries;

    expect(checkAllInvariants(entries)).toEqual([]);
    expect(projectUserBalance('u1', SOL, entries).available).toBe(110n);

    // The bug this guards against: crediting the user the full 1000 while the
    // 890 is still immobilised. The result is unbalanced, and both the books
    // check and the coverage check report it.
    const overCredited: Entry[] = [
      debit(chainAssets(SOL), SOL, 1000n),
      credit(userAvailable('u1', SOL), SOL, 1000n),
      credit(houseRent(SOL), SOL, 890n),
    ];
    expect(checkLiabilitiesCovered(overCredited)[0]?.detail.shortfall).toBe('890');
    expect(checkBooksBalance(overCredited).length).toBeGreaterThan(0);
  });

  it('accepts a healthy multi-user ledger', () => {
    const entries: Entry[] = [
      ...postDeposit({ depositId: 'd1', userId: 'u1', asset: SOL, amount: 100n }).entries,
      ...postDeposit({ depositId: 'd2', userId: 'u2', asset: SOL, amount: 250n }).entries,
      ...postDeposit({
        depositId: 'd3',
        userId: 'u3',
        asset: SOL,
        amount: 1000n,
        rentReserved: 890n,
      }).entries,
    ];
    expect(checkAllInvariants(entries)).toEqual([]);
  });
});

describe('base-unit branding', () => {
  it('keeps a BaseUnits value usable across the boundary', () => {
    const value = asBaseUnits('42');
    expect(toBaseUnits(toAmount(value))).toBe('42');
  });
});
