import {
  isCustodyAccount,
  isTradingAccount,
  ACCOUNT_CLASS,
  accountKey,
  isUserAccount,
  NON_NEGATIVE_ACCOUNT_TYPES,
  type AccountRef,
  type AccountType,
} from './accounts.js';
import { isNegative, type Amount } from './amount.js';
import { signedAmount, type Entry } from './entries.js';

/**
 * Balances are PROJECTIONS over entries (prompt_phase2.md rules 82-85).
 *
 * There is no balance column in this system. Not on an account, not on a user,
 * not "denormalised for the dashboard". The moment one exists it becomes the
 * value everything reads, it drifts from the entries that are supposed to
 * define it, and then there are two answers to "what is this balance" with no
 * principled way to choose between them.
 *
 * If projection cost ever becomes real, the answer is a cache that is provably
 * reconstructible from entries and is verified against them — not an
 * authoritative column. Phase 2 builds neither (rule 85).
 */

export interface AccountBalance {
  readonly account: AccountRef;
  /**
   * Signed under the debit-positive convention in ./entries.ts.
   * For a liability account, a positive `balance` means the platform owes that
   * much — `available()` flips the sign so callers do not have to think about
   * it.
   */
  readonly balance: Amount;
}

export function projectAccount(account: AccountRef, entries: readonly Entry[]): AccountBalance {
  const key = accountKey(account);
  let balance = 0n;
  for (const entry of entries) {
    if (accountKey(entry.account) === key) balance += signedAmount(entry);
  }
  return { account, balance };
}

export function projectAll(entries: readonly Entry[]): Map<string, AccountBalance> {
  const balances = new Map<string, AccountBalance>();
  for (const entry of entries) {
    const key = accountKey(entry.account);
    const existing = balances.get(key);
    balances.set(key, {
      account: entry.account,
      balance: (existing?.balance ?? 0n) + signedAmount(entry),
    });
  }
  return balances;
}

/**
 * What a user actually has, in the terms a user thinks in.
 *
 * Liability accounts carry a credit balance, which is negative under the
 * debit-positive convention. This is the one place that sign flip happens.
 */
export interface UserBalance {
  readonly userId: string;
  readonly asset: string;
  readonly available: Amount;
  readonly locked: Amount;
  readonly total: Amount;
}

export function projectUserBalance(
  userId: string,
  asset: string,
  entries: readonly Entry[],
): UserBalance {
  let available = 0n;
  let locked = 0n;

  for (const entry of entries) {
    const { account } = entry;
    if (account.ownerId !== userId || account.asset !== asset) continue;
    // Negated: a credit to a liability increases what the user holds.
    const value = -signedAmount(entry);
    if (account.type === 'user_custody_available') available += value;
    else if (account.type === 'user_custody_locked') locked += value;
  }

  return { userId, asset, available, locked, total: available + locked };
}

// ---------------------------------------------------------------------------
// Invariants (prompt_phase2.md rules 86-88)
// ---------------------------------------------------------------------------

export interface InvariantViolation {
  readonly invariant: string;
  readonly detail: Record<string, string>;
}

/** Invariant A, restated over a whole entry set rather than one transaction. */
export function checkBooksBalance(entries: readonly Entry[]): InvariantViolation[] {
  const byAsset = new Map<string, Amount>();
  for (const entry of entries) {
    byAsset.set(entry.asset, (byAsset.get(entry.asset) ?? 0n) + signedAmount(entry));
  }
  const violations: InvariantViolation[] = [];
  for (const [asset, residual] of byAsset) {
    if (residual !== 0n) {
      violations.push({
        invariant: 'books_balance',
        detail: { asset, residual: residual.toString() },
      });
    }
  }
  return violations;
}

/** No user may hold a negative available or locked balance. */
export function checkNoNegativeUserBalances(entries: readonly Entry[]): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const [key, { account, balance }] of projectAll(entries)) {
    if (!isUserAccount(account.type)) continue;
    const held = -balance;
    if (isNegative(held)) {
      violations.push({
        invariant: 'no_negative_user_balance',
        detail: { account: key, balance: held.toString() },
      });
    }
  }
  return violations;
}

/** Accounts with a declared normal sign must respect it. */
export function checkAccountSigns(entries: readonly Entry[]): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const [key, { account, balance }] of projectAll(entries)) {
    if (!NON_NEGATIVE_ACCOUNT_TYPES.has(account.type)) continue;
    const normal = normalBalance(account.type, balance);
    if (isNegative(normal)) {
      violations.push({
        invariant: 'account_sign',
        detail: { account: key, balance: normal.toString(), type: account.type },
      });
    }
  }
  return violations;
}

/**
 * Invariant C: what the platform owes users never exceeds what it controls
 * on-chain, less the portion immobilised as rent.
 *
 * WHAT THIS DOES AND DOES NOT CATCH
 *
 * On a ledger that balances, this can never fire, and that is not a defect —
 * it is the arithmetic. Balanced means assets = liabilities + rent + fees, so
 * spendable (assets - rent) is always at least liabilities. Coverage is a
 * consequence of double-entry, not an independent property.
 *
 * So it fires only when something has ALREADY gone wrong: an unbalanced write
 * that slipped past `buildTransaction` and the database constraint, or a
 * corrupted entry set. It is a redundancy check, kept because the cost is a
 * scan and the thing it guards is the number a user sees.
 *
 * The genuinely independent version of this question — do the on-chain
 * balances match the books at all — cannot be answered from entries. That is
 * reconciliation (master-prompt rule 120), which reads the chain.
 */
export function checkLiabilitiesCovered(entries: readonly Entry[]): InvariantViolation[] {
  // Two tiers, two equations (ADR-0025 §3). Each tier's liabilities are
  // covered by its OWN on-chain holdings, never by the other's:
  //
  //   vault:    chain_assets - house_rent >= user_custody_available + user_custody_locked
  //   clearing: clearing_assets           >= user_trading_available + user_order_locked
  //
  // Pooling them would be wrong in both directions. Counting trading
  // liabilities against chain_assets alone reports a false shortfall on every
  // allocation, because the funds moved to the clearing address. Counting
  // clearing_assets towards the vault would let a surplus in one tier hide a
  // shortfall in the other.
  const custody = new Map<string, Amount>();
  const trading = new Map<string, Amount>();
  const chain = new Map<string, Amount>();
  const clearing = new Map<string, Amount>();
  const rent = new Map<string, Amount>();

  const add = (bucket: Map<string, Amount>, asset: string, value: Amount) =>
    bucket.set(asset, (bucket.get(asset) ?? 0n) + value);

  for (const [, { account, balance }] of projectAll(entries)) {
    const value = normalBalance(account.type, balance);
    if (isCustodyAccount(account.type)) add(custody, account.asset, value);
    else if (isTradingAccount(account.type)) add(trading, account.asset, value);
    else if (account.type === 'chain_assets') add(chain, account.asset, value);
    else if (account.type === 'clearing_assets') add(clearing, account.asset, value);
    else if (account.type === 'house_rent') add(rent, account.asset, value);
  }

  const violations: InvariantViolation[] = [];

  for (const [asset, owed] of custody) {
    const held = chain.get(asset) ?? 0n;
    const immobilised = rent.get(asset) ?? 0n;
    const spendable = held - immobilised;
    if (owed > spendable) {
      violations.push({
        invariant: 'liabilities_covered',
        detail: {
          tier: 'custody',
          asset,
          liabilities: owed.toString(),
          chainAssets: held.toString(),
          rent: immobilised.toString(),
          shortfall: (owed - spendable).toString(),
        },
      });
    }
  }

  for (const [asset, owed] of trading) {
    const held = clearing.get(asset) ?? 0n;
    if (owed > held) {
      violations.push({
        invariant: 'liabilities_covered',
        detail: {
          tier: 'clearing',
          asset,
          liabilities: owed.toString(),
          clearingAssets: held.toString(),
          shortfall: (owed - held).toString(),
        },
      });
    }
  }
  return violations;
}

export function checkAllInvariants(entries: readonly Entry[]): InvariantViolation[] {
  return [
    ...checkBooksBalance(entries),
    ...checkNoNegativeUserBalances(entries),
    ...checkAccountSigns(entries),
    ...checkLiabilitiesCovered(entries),
  ];
}

/**
 * Converts a debit-positive balance into the account's own natural sign.
 *
 * Asset accounts are debit-normal; everything else — liabilities, equity, and
 * contra — is credit-normal and therefore negated here.
 *
 * `house_rent` is the one that is easy to get wrong. It is not an asset: it is
 * a claim ON the assets, sitting alongside user liabilities. A deposit of 1000
 * with 890 immobilised as rent posts as
 *
 *   debit  chain_assets    1000     (assets)
 *   credit user_custody_available   110     (claims)
 *   credit house_rent       890     (claims)
 *
 * so total claims equal total assets, and the coverage check in
 * `checkLiabilitiesCovered` subtracts rent from assets to get what is actually
 * spendable.
 */
function normalBalance(type: AccountType, balance: Amount): Amount {
  return ACCOUNT_CLASS[type] === 'asset' ? balance : -balance;
}
