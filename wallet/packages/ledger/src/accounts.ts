/**
 * The chart of accounts (prompt_phase2.md rules 65-75).
 *
 * An account is identified by the triple (owner, asset, type) and holds NO
 * balance. A balance is always a projection over entries — see ./projection.ts
 * and rule 83.
 */

export const ACCOUNT_TYPES = [
  /** Liability: what the platform owes a user and they may spend. */
  'user_available',
  /**
   * Liability: what the platform owes a user, reserved against a pending
   * withdrawal.
   *
   * A SEPARATE ACCOUNT, not a column on user_available (rules 68-69). This is
   * the most consequential structural decision in the package. A lock becomes
   * a balanced transfer between two accounts — which shows up in the entry
   * history, reverses by the same mechanism that created it, and is impossible
   * to get half-done. A `locked_amount` column is a mutation: invisible after
   * the fact, and reversible only by remembering to subtract the right number.
   *
   * Phase 2 creates this account and never moves anything into it. Phase 3's
   * withdrawal state machine is what gives it a purpose (rule 70).
   */
  'user_locked',
  /** Asset: what the platform actually controls on-chain. */
  'chain_assets',
  /** Equity/expense: network fees paid or collected. */
  'house_fees',
  /**
   * Equity/expense: SOL immobilised in rent-exemption minimums.
   *
   * Real, ours, and not user-withdrawable. Crediting it to a user would create
   * an obligation the platform cannot meet (rules 72, 158).
   */
  'house_rent',
  /**
   * Contra: the world outside this system.
   *
   * The only account permitted an unbounded balance of either sign, because it
   * represents everything the platform does not control (rule 74).
   */
  'external',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Which side of the books an account sits on, and therefore its normal sign. */
export const ACCOUNT_CLASS: Readonly<
  Record<AccountType, 'asset' | 'liability' | 'equity' | 'contra'>
> = {
  user_available: 'liability',
  user_locked: 'liability',
  chain_assets: 'asset',
  house_fees: 'equity',
  house_rent: 'equity',
  external: 'contra',
};

/**
 * Accounts that must never project to a negative balance (rule 75).
 *
 * `house_fees` is here for a reason worth stating: it is a PREPAID balance the
 * platform funds itself (see `postHouseFunding`). A negative `house_fees` means
 * the platform paid its network fees out of the pooled assets that back user
 * balances — which is to say, out of customer money. The arithmetic shows up
 * immediately as a `liabilities_covered` violation; this check names the cause.
 */
export const NON_NEGATIVE_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'user_available',
  'user_locked',
  'chain_assets',
  'house_rent',
  'house_fees',
]);

/** Accounts owed to a specific user. Their total is the platform's liability. */
export const USER_LIABILITY_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'user_available',
  'user_locked',
]);

export function isUserAccount(type: AccountType): boolean {
  return USER_LIABILITY_ACCOUNT_TYPES.has(type);
}

/**
 * The identity of an account. `ownerId` is null for house and system accounts,
 * which is why (owner, asset, type) is unique rather than (owner, asset).
 */
export interface AccountRef {
  readonly ownerId: string | null;
  readonly asset: string;
  readonly type: AccountType;
}

export function accountKey(ref: AccountRef): string {
  return `${ref.type}:${ref.ownerId ?? '-'}:${ref.asset}`;
}

export function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.type === b.type && a.ownerId === b.ownerId && a.asset === b.asset;
}

export function userAvailable(ownerId: string, asset: string): AccountRef {
  return { ownerId, asset, type: 'user_available' };
}

export function userLocked(ownerId: string, asset: string): AccountRef {
  return { ownerId, asset, type: 'user_locked' };
}

export function chainAssets(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'chain_assets' };
}

export function houseFees(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'house_fees' };
}

export function houseRent(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'house_rent' };
}

export function external(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'external' };
}
