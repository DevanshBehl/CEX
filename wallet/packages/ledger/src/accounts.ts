/**
 * The chart of accounts (prompt_phase2.md rules 65-75, ADR-0032).
 *
 * An account is identified by the triple (owner, asset, type) and holds NO
 * balance. A balance is always a projection over entries — see ./projection.ts
 * and rule 83.
 *
 * # Two tiers
 *
 * Since ADR-0025 custody is split in two, and the names say which is which:
 *
 * - **vault** (`user_custody_*`) — the user's own segregated 3-of-5 address.
 *   Reconciles per user against that address.
 * - **clearing** (`user_trading_*`, `user_order_locked`) — an omnibus claim on
 *   the house clearing address. Reconciles in aggregate.
 *
 * A trade moves value between users, which a per-user address cannot express:
 * Alice's key cannot sign a disbursement to Bob. That is the whole reason the
 * second tier exists.
 */

export const ACCOUNT_TYPES = [
  /** Liability: what the platform owes a user and they may spend. */
  'user_custody_available',
  /**
   * Liability: what the platform owes a user, reserved against a pending
   * withdrawal.
   *
   * A SEPARATE ACCOUNT, not a column on user_custody_available (rules 68-69). This is
   * the most consequential structural decision in the package. A lock becomes
   * a balanced transfer between two accounts — which shows up in the entry
   * history, reverses by the same mechanism that created it, and is impossible
   * to get half-done. A `locked_amount` column is a mutation: invisible after
   * the fact, and reversible only by remembering to subtract the right number.
   *
   * Phase 2 creates this account and never moves anything into it. Phase 3's
   * withdrawal state machine is what gives it a purpose (rule 70).
   */
  'user_custody_locked',

  // --- clearing tier (ADR-0025, ADR-0032) ---
  /** Liability: what the platform owes a user that they may spend on the book. */
  'user_trading_available',
  /**
   * Liability: what the platform owes a user, reserved against a live order.
   *
   * The same structural decision as `user_custody_locked`, for the same reason:
   * a hold is a balanced transfer, not a column. It is a SEPARATE account from
   * the vault's lock because the two tiers reconcile against different on-chain
   * balances — a single locked account could not be attributed to either, and
   * neither reconciliation equation would be expressible.
   */
  'user_order_locked',
  /**
   * Asset: what the house CLEARING address controls on-chain.
   *
   * Deliberately not `chain_assets` with a null owner. The treasury pays network
   * fees and is the durable-nonce authority, so its balance moves constantly for
   * reasons that have nothing to do with customer funds; pooling the two would
   * make the clearing reserve check unable to tell customer money from fee
   * float, and every fee paid would read as a shortfall (ADR-0025).
   */
  'clearing_assets',
  /**
   * Equity: maker/taker fees earned.
   *
   * Has no writer until S4. Its balance is zero, and a reconciliation that
   * expects otherwise is wrong.
   */
  'house_trading_fees',

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
  user_custody_available: 'liability',
  user_custody_locked: 'liability',
  user_trading_available: 'liability',
  user_order_locked: 'liability',
  clearing_assets: 'asset',
  house_trading_fees: 'equity',
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
  'user_custody_available',
  'user_custody_locked',
  'user_trading_available',
  'user_order_locked',
  'clearing_assets',
  'house_trading_fees',
  'chain_assets',
  'house_rent',
  'house_fees',
]);

/**
 * Accounts owed to a specific user. Their total is the platform's liability.
 *
 * BOTH TIERS BELONG HERE. `checkLiabilitiesCovered` derives its liability set
 * from `isUserAccount` rather than from a list someone must remember to extend,
 * so adding a user-owned type here is the single act that keeps the coverage
 * invariant correct (ADR-0032).
 *
 * A trading balance is owed to a user exactly as a wallet balance is.
 */
export const USER_LIABILITY_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'user_custody_available',
  'user_custody_locked',
  'user_trading_available',
  'user_order_locked',
]);

/** The clearing tier's user accounts. Reconciled in aggregate, not per owner. */
export const TRADING_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'user_trading_available',
  'user_order_locked',
]);

/** The vault tier's user accounts. Reconciled per owner against their address. */
export const CUSTODY_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'user_custody_available',
  'user_custody_locked',
]);

export function isTradingAccount(type: AccountType): boolean {
  return TRADING_ACCOUNT_TYPES.has(type);
}

export function isCustodyAccount(type: AccountType): boolean {
  return CUSTODY_ACCOUNT_TYPES.has(type);
}

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

export function userCustodyAvailable(ownerId: string, asset: string): AccountRef {
  return { ownerId, asset, type: 'user_custody_available' };
}

export function userCustodyLocked(ownerId: string, asset: string): AccountRef {
  return { ownerId, asset, type: 'user_custody_locked' };
}

/**
 * What a SPECIFIC user's segregated address holds on-chain (ADR-0020).
 *
 * Partitioned per owner. Under the omnibus model this was one pooled account
 * per asset with `ownerId: null`, and one user's funds were indistinguishable
 * from another's — on-chain and in the books.
 *
 * Segregation makes the invariant stronger in a way that matters: it is no
 * longer enough for the aggregate to reconcile. A total that matches while two
 * users' balances are individually wrong is precisely the failure segregation
 * exists to prevent, and only a per-owner comparison catches it.
 */
export function chainAssets(ownerId: string, asset: string): AccountRef {
  return { ownerId, asset, type: 'chain_assets' };
}

/**
 * On-chain assets the HOUSE holds: the fee-payer wallet, nonce account rent.
 *
 * Deliberately a separate function rather than `chainAssets(null, asset)`.
 * A nullable owner on the segregated helper is an invitation to pass a
 * `string | null` straight through and pool a user's funds by accident — the
 * one mistake this partitioning exists to prevent.
 */
export function houseChainAssets(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'chain_assets' };
}

export function houseFees(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'house_fees' };
}

export function houseRent(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'house_rent' };
}

export function userTradingAvailable(ownerId: string, asset: string): AccountRef {
  return { ownerId, asset, type: 'user_trading_available' };
}

export function userOrderLocked(ownerId: string, asset: string): AccountRef {
  return { ownerId, asset, type: 'user_order_locked' };
}

/**
 * The clearing pool's on-chain holdings. House-owned, so no `ownerId`.
 *
 * A separate function from `houseChainAssets` for the same reason that one is
 * separate from `chainAssets`: the two house addresses are not interchangeable,
 * and a helper that could name either invites naming the wrong one.
 */
export function clearingAssets(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'clearing_assets' };
}

export function houseTradingFees(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'house_trading_fees' };
}

export function external(asset: string): AccountRef {
  return { ownerId: null, asset, type: 'external' };
}
