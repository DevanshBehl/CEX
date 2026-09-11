import type { AccountRef } from './accounts.js';
import type { Amount } from './amount.js';

/**
 * Entries and transactions (prompt_phase2.md rules 76-81).
 *
 * An entry is immutable. There is no update and no delete, at any layer — not
 * in this package, not in the repository, and not in the database, where the
 * grant simply is not held (rules 78, 131-133).
 */

/**
 * Direction is stored explicitly alongside a signed amount, which is
 * deliberately redundant.
 *
 * `amount` is always non-negative and `direction` carries the sign, so a row is
 * readable on its own in a SQL console during an incident — which is when
 * someone will be reading it. `signedAmount()` is the only thing that converts.
 */
export type Direction = 'debit' | 'credit';

export interface Entry {
  readonly account: AccountRef;
  readonly asset: string;
  /** Non-negative. The sign lives in `direction`. */
  readonly amount: Amount;
  readonly direction: Direction;
}

/**
 * Sign convention, stated once so it is never guessed at:
 *
 *   debit  → increases an asset,     decreases a liability
 *   credit → increases a liability,  decreases an asset
 *
 * A deposit of 1 SOL is therefore:
 *   debit  chain_assets:SOL       1   (we now hold more on-chain)
 *   credit user_available:u1:SOL  1   (we now owe the user more)
 *
 * and the two sum to zero under `signedAmount`, which is what "balanced" means.
 */
export function signedAmount(entry: Entry): Amount {
  return entry.direction === 'debit' ? entry.amount : -entry.amount;
}

export const TRANSACTION_KINDS = [
  'deposit',
  /** Phase 3 — withdrawal lifecycle. Declared so the union is stable. */
  'withdrawal_lock',
  'withdrawal_release',
  'withdrawal_settle',
  /** Phase 4 — sweeps and fee accounting. */
  'sweep',
  'fee',
  /** Operational correction. Always paired with an audit record. */
  'adjustment',
] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/**
 * A group of entries that balance, plus the reason they exist.
 *
 * `referenceType`/`referenceId` tie the transaction to the domain object that
 * caused it (a deposit row, later a withdrawal row), so the ledger can always
 * answer "why does this entry exist" without a join through application logs.
 */
export interface LedgerTransaction {
  readonly kind: TransactionKind;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly entries: readonly Entry[];
}

export function debit(account: AccountRef, asset: string, amount: Amount): Entry {
  return { account, asset, amount, direction: 'debit' };
}

export function credit(account: AccountRef, asset: string, amount: Amount): Entry {
  return { account, asset, amount, direction: 'credit' };
}
