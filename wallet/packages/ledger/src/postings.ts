import { chainAssets, houseRent, userAvailable } from './accounts.js';
import { isNegative, isZero, type Amount } from './amount.js';
import { credit, debit, type LedgerTransaction } from './entries.js';
import { InvalidEntryError } from './errors.js';
import { buildTransaction } from './transaction-builder.js';

/**
 * Posting rules — the small set of transaction shapes this phase can produce.
 *
 * Callers do not assemble entries by hand. Every movement of money is a named
 * function here, so "what can this system do to the books" is answerable by
 * reading one file, and adding a new shape is a deliberate act.
 */

export interface DepositPosting {
  readonly depositId: string;
  readonly userId: string;
  readonly asset: string;
  /** Total received on-chain, in base units. */
  readonly amount: Amount;
  /**
   * The portion immobilised as a rent-exempt minimum, if this transfer funded a
   * new account (prompt_phase2.md rules 157-158).
   *
   * It is ours and it is real, but the user can never withdraw it, so crediting
   * it to them would create an obligation the platform cannot meet. It goes to
   * `house_rent` instead.
   */
  readonly rentReserved?: Amount;
}

/**
 * A deposit (prompt_phase2.md rule 156).
 *
 *   debit  chain_assets   — the platform now controls more on-chain
 *   credit user_available — the platform now owes the user more
 *   credit house_rent     — except the part that can never be withdrawn
 *
 * Note there is no `external` entry. The chain-assets account increasing IS the
 * record that value entered the system; adding a contra entry against `external`
 * would double-count the same movement.
 */
export function postDeposit(input: DepositPosting): LedgerTransaction {
  const rent = input.rentReserved ?? 0n;

  if (isNegative(input.amount) || isZero(input.amount)) {
    throw new InvalidEntryError('deposit_amount_not_positive', { depositId: input.depositId });
  }
  if (isNegative(rent)) {
    throw new InvalidEntryError('deposit_rent_negative', { depositId: input.depositId });
  }
  if (rent > input.amount) {
    // A transfer cannot reserve more rent than it carried.
    throw new InvalidEntryError('deposit_rent_exceeds_amount', {
      depositId: input.depositId,
    });
  }

  const creditable = input.amount - rent;
  if (isZero(creditable) && isZero(rent)) {
    throw new InvalidEntryError('deposit_amount_not_positive', { depositId: input.depositId });
  }

  const entries = [debit(chainAssets(input.asset), input.asset, input.amount)];

  if (!isZero(creditable)) {
    entries.push(credit(userAvailable(input.userId, input.asset), input.asset, creditable));
  }
  if (!isZero(rent)) {
    entries.push(credit(houseRent(input.asset), input.asset, rent));
  }

  return buildTransaction({
    kind: 'deposit',
    referenceType: 'deposit',
    referenceId: input.depositId,
    entries,
  });
}
