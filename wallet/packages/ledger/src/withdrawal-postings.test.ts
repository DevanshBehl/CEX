import { describe, expect, it } from 'vitest';
import {
  checkAllInvariants,
  postHouseFunding,
  chainAssets,
  houseChainAssets,
  InvalidEntryError,
  isBalanced,
  postDeposit,
  postNonceAccountRent,
  postSweepFee,
  postTokenAccountRent,
  postWithdrawalLock,
  postWithdrawalRelease,
  postWithdrawalSettlement,
  projectAll,
  projectUserBalance,
  accountKey,
  type Entry,
} from './index.js';

// Cluster-qualified, because that is what the ledger stores (ADR-0021). A
// bare `SOL` is refused by `buildTransaction` — deliberately, since a key
// without a cluster is one account shared by devnet and mainnet.
const SOL = 'devnet:SOL';
const ONE = 1_000_000_000n;

/*
 * A token, for the settlement path where the amount and the fee are different
 * assets. Six decimals against SOL's nine, which is the other half of why a
 * fee posted under the wrong key is so hard to see: the numbers look
 * plausible either way.
 */
const USDC = 'devnet:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_ONE = 1_000_000n;

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
        feeAsset: SOL,
        amount: 3n * ONE,
      }).entries,
    ];

    const balance = projectUserBalance('u1', SOL, entries);
    expect(balance.locked).toBe(0n);
    expect(balance.available).toBe(7n * ONE);
    expect(balance.total).toBe(7n * ONE);

    /*
     * The user's OWN on-chain position falls (ADR-0020).
     *
     * Under the omnibus model this read the pooled account. Segregated, the
     * funds left the user's own address, so their own `chain_assets` is what
     * goes down — and the house's is untouched, which is the property that
     * makes per-user reconciliation meaningful.
     */
    const projected = projectAll(entries);
    expect(projected.get(accountKey(chainAssets('u1', SOL)))?.balance).toBe(7n * ONE);
    expect(projected.get(accountKey(houseChainAssets(SOL)))).toBeUndefined();
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
        feeAsset: SOL,
        amount: 3n * ONE,
        networkFee: fee,
      }).entries,
    ];

    // The user is debited exactly what they asked to withdraw.
    expect(projectUserBalance('u1', SOL, entries).total).toBe(7n * ONE);
    // And the fee leaves the platform on top of it, drawn from the house's own
    // prepaid balance rather than from the pool backing user funds.
    /*
     * The fee and the funds leave DIFFERENT addresses (ADR-0020).
     *
     * The user's segregated address loses the withdrawal amount. The house's
     * fee wallet loses the fee — the user is never the fee payer, because a
     * token-only balance would otherwise be unspendable, and because debiting
     * a user's address for lamports that never left it would put their
     * reconciliation permanently out by the fee.
     */
    const projected = projectAll(entries);
    expect(projected.get(accountKey(chainAssets('u1', SOL)))?.balance).toBe(7n * ONE);
    expect(projected.get(accountKey(houseChainAssets(SOL)))?.balance).toBe(ONE - fee);
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
        feeAsset: SOL,
        amount: ONE,
        networkFee: 5_000n,
      }).entries,
    ];

    const violations = checkAllInvariants(entries);
    expect(violations.some((v) => v.invariant === 'liabilities_covered')).toBe(true);
    expect(violations.some((v) => v.invariant === 'account_sign')).toBe(true);
  });

  /*
   * A TOKEN withdrawal, whose fee is paid in SOL (ADR-0016).
   *
   * The asymmetry that makes this worth its own test: the amount moves in
   * USDC and the fee moves in SOL, in ONE posting. Every other settlement
   * test uses SOL for both, which is exactly why the fee carried the mint for
   * as long as it did — the two keys were always the same, so nothing
   * disagreed.
   */
  it('denominates a token withdrawal fee in the native asset, not the mint', () => {
    const fee = 5_000n;
    const posting = postWithdrawalSettlement({
      withdrawalId: 'w1',
      userId: 'u1',
      asset: USDC,
      feeAsset: SOL,
      amount: 100n * USDC_ONE,
      networkFee: fee,
    });

    const byAsset = (asset: string) => posting.entries.filter((entry) => entry.asset === asset);

    // The user's side moves in USDC and only in USDC.
    expect(byAsset(USDC)).toHaveLength(2);
    // The fee moves in SOL and only in SOL.
    const feeEntries = byAsset(SOL);
    expect(feeEntries).toHaveLength(2);
    for (const entry of feeEntries) {
      expect(entry.amount).toBe(fee);
      // And against the HOUSE's accounts — a user never pays it.
      expect(entry.account.ownerId).toBeNull();
    }
  });

  it('keeps a token withdrawal balanced per asset, and leaves house USDC alone', () => {
    const entries = [
      ...postHouseFunding({ reference: 'treasury-1', asset: SOL, amount: ONE }).entries,
      ...postDeposit({ depositId: 'd1', userId: 'u1', asset: USDC, amount: 500n * USDC_ONE })
        .entries,
      ...postWithdrawalLock({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: USDC,
        amount: 100n * USDC_ONE,
      }).entries,
      ...postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: USDC,
        feeAsset: SOL,
        amount: 100n * USDC_ONE,
        networkFee: 5_000n,
      }).entries,
    ];

    const projected = projectAll(entries);

    // The user is out exactly the tokens they withdrew, and nothing else.
    expect(projectUserBalance('u1', USDC, entries).total).toBe(400n * USDC_ONE);
    // The house paid the fee out of its SOL.
    expect(projected.get(accountKey(houseChainAssets(SOL)))?.balance).toBe(ONE - 5_000n);
    /*
     * And the house's USDC was never touched.
     *
     * THE REGRESSION. Posting the fee against the mint credited this account
     * with 5,000 — five thousandths of a USDC the house never held and never
     * spent — so the books claimed a USDC cost for a SOL fee, and every token
     * withdrawal drifted the house's token position by its own fee.
     */
    expect(projected.get(accountKey(houseChainAssets(USDC)))).toBeUndefined();

    // Balanced per asset, which is the invariant that would have caught it.
    expect(isBalanced(entries)).toBe(true);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('refuses a negative fee', () => {
    expect(() =>
      postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'u1',
        asset: SOL,
        feeAsset: SOL,
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
        feeAsset: SOL,
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

// ---------------------------------------------------------------------------
// Sweeps and token rent (ADR-0016, ADR-0017, prompt_phase4.md rules 118, 131)
// ---------------------------------------------------------------------------

describe('sweeps', () => {
  it('LEAVES USER LIABILITIES BIT-IDENTICAL', () => {
    // The defining property of a sweep (rule 131). A sweep that moves a user
    // balance is not a sweep with a bug, it is a different operation.
    const before = [...funded(), ...houseFunded()];
    const liabilitiesBefore = projectUserBalance('u1', SOL, before);

    const after = [
      ...before,
      ...postSweepFee({ sweepId: 's1', asset: SOL, amount: 5_000n }).entries,
    ];

    expect(projectUserBalance('u1', SOL, after)).toEqual(liabilitiesBefore);
  });

  it('posts only the fee, because both addresses map to one chain_assets account', () => {
    const posting = postSweepFee({ sweepId: 's1', asset: SOL, amount: 5_000n });
    expect(posting.entries).toHaveLength(2);
    expect(isBalanced([...posting.entries])).toBe(true);
  });

  it('draws the fee from house_fees, never from pooled customer funds', () => {
    const entries = [
      ...funded(),
      ...houseFunded(),
      ...postSweepFee({ sweepId: 's1', asset: SOL, amount: 5_000n }).entries,
    ];

    const balances = projectAll(entries);
    // Debit-positive: a credit-normal account projects negative, so the
    // prepaid balance is read as its magnitude. It fell by exactly the fee.
    expect(
      balances.get(accountKey({ ownerId: null, asset: SOL, type: 'house_fees' }))?.balance,
    ).toBe(-(ONE - 5_000n));
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('reports a shortfall when the platform sweeps with no prepaid balance', () => {
    // Unfunded, the fee comes out of the assets backing user balances, and the
    // invariants must say so rather than quietly allowing it.
    const entries = [
      ...funded(),
      ...postSweepFee({ sweepId: 's1', asset: SOL, amount: 5_000n }).entries,
    ];
    expect(checkAllInvariants(entries).length).toBeGreaterThan(0);
  });

  it('refuses a zero or negative fee', () => {
    expect(() => postSweepFee({ sweepId: 's1', asset: SOL, amount: 0n })).toThrow(
      InvalidEntryError,
    );
  });
});

describe('token account rent (rule 118)', () => {
  it('credits house_rent, never the user', () => {
    const entries = [
      ...funded(),
      ...postTokenAccountRent({
        reference: 'ata-1',
        ownerId: 'u1',
        nativeAsset: SOL,
        amount: 2_039_280n,
      }).entries,
    ];

    const balances = projectAll(entries);
    expect(
      balances.get(accountKey({ ownerId: null, asset: SOL, type: 'house_rent' }))?.balance,
    ).toBe(-2_039_280n);
    // The user gained nothing: they cannot withdraw an account's rent.
    expect(projectUserBalance('u1', SOL, entries).available).toBe(10n * ONE);
  });

  it('is denominated in the NATIVE asset even though it creates a token account', () => {
    // The asymmetry worth a test: posting this against the mint would invent
    // SOL out of USDC.
    const posting = postTokenAccountRent({
      reference: 'ata-1',
      ownerId: 'u1',
      nativeAsset: SOL,
      amount: 2_039_280n,
    });
    for (const entry of posting.entries) {
      expect(entry.asset).toBe(SOL);
    }
  });

  it('balances', () => {
    expect(
      isBalanced([
        ...postTokenAccountRent({
          reference: 'a',
          ownerId: 'u1',
          nativeAsset: SOL,
          amount: 1n,
        }).entries,
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Segregation (ADR-0020)
// ---------------------------------------------------------------------------

describe('segregated custody', () => {
  it('NEVER POOLS TWO USERS INTO ONE ON-CHAIN ACCOUNT', () => {
    // The defining property. Under the omnibus model both deposits landed in
    // one `chain_assets` account and the two users were indistinguishable in
    // the books as well as on-chain.
    const entries = [
      ...postDeposit({ depositId: 'd1', userId: 'alice', asset: SOL, amount: 5n * ONE }).entries,
      ...postDeposit({ depositId: 'd2', userId: 'bob', asset: SOL, amount: 3n * ONE }).entries,
    ];

    const projected = projectAll(entries);
    expect(projected.get(accountKey(chainAssets('alice', SOL)))?.balance).toBe(5n * ONE);
    expect(projected.get(accountKey(chainAssets('bob', SOL)))?.balance).toBe(3n * ONE);

    // And nothing landed in a pooled account at all.
    expect(projected.get(accountKey(houseChainAssets(SOL)))).toBeUndefined();
  });

  it('keeps each user on-chain position equal to what they are owed', () => {
    // The per-user reconciliation invariant, in ledger terms: a user's
    // segregated on-chain assets must equal their liability. An aggregate that
    // matches while two users are individually wrong is exactly the failure
    // segregation exists to catch.
    const entries = [
      ...postDeposit({ depositId: 'd1', userId: 'alice', asset: SOL, amount: 5n * ONE }).entries,
      ...postDeposit({ depositId: 'd2', userId: 'bob', asset: SOL, amount: 3n * ONE }).entries,
    ];
    const projected = projectAll(entries);

    for (const [user, amount] of [
      ['alice', 5n * ONE],
      ['bob', 3n * ONE],
    ] as const) {
      const onChain = projected.get(accountKey(chainAssets(user, SOL)))?.balance ?? 0n;
      expect(onChain).toBe(projectUserBalance(user, SOL, entries).total);
      expect(onChain).toBe(amount);
    }
  });

  it('does not let one user withdrawal touch another user position', () => {
    const entries = [
      ...postDeposit({ depositId: 'd1', userId: 'alice', asset: SOL, amount: 5n * ONE }).entries,
      ...postDeposit({ depositId: 'd2', userId: 'bob', asset: SOL, amount: 3n * ONE }).entries,
      ...postWithdrawalLock({ withdrawalId: 'w1', userId: 'alice', asset: SOL, amount: 2n * ONE })
        .entries,
      ...postWithdrawalSettlement({
        withdrawalId: 'w1',
        userId: 'alice',
        asset: SOL,
        feeAsset: SOL,
        amount: 2n * ONE,
      }).entries,
    ];

    const projected = projectAll(entries);
    expect(projected.get(accountKey(chainAssets('alice', SOL)))?.balance).toBe(3n * ONE);
    // Bob is untouched. Under the omnibus model his funds were part of the
    // same pool Alice was paid from.
    expect(projected.get(accountKey(chainAssets('bob', SOL)))?.balance).toBe(3n * ONE);
    expect(checkAllInvariants(entries)).toEqual([]);
  });

  it('attributes sponsored token-account rent to the user whose account it created', () => {
    // The lamports sit at the USER's token account, so per-user reconciliation
    // must expect them there — but `house_rent` records that the user neither
    // deposited them nor can withdraw them.
    const entries = [
      ...funded(),
      ...postTokenAccountRent({
        reference: 'ata-1',
        ownerId: 'u1',
        nativeAsset: SOL,
        amount: 2_039_280n,
      }).entries,
    ];

    const projected = projectAll(entries);
    expect(projected.get(accountKey(chainAssets('u1', SOL)))?.balance).toBe(10n * ONE + 2_039_280n);
    // Credit-normal, so it projects negative under debit-positive.
    expect(
      projected.get(accountKey({ ownerId: null, asset: SOL, type: 'house_rent' }))?.balance,
    ).toBe(-2_039_280n);
    // The user gained nothing spendable.
    expect(projectUserBalance('u1', SOL, entries).available).toBe(10n * ONE);
  });
});
