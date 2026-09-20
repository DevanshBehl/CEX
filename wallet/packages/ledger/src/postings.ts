import {
  chainAssets,
  houseChainAssets,
  houseFees,
  houseRent,
  userAvailable,
  userLocked,
} from './accounts.js';
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

  // The user's OWN address received this (ADR-0020). Both sides of a deposit
  // now name the same user, which is what makes the per-user reconciliation
  // invariant expressible at all.
  const entries = [debit(chainAssets(input.userId, input.asset), input.asset, input.amount)];

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

// ---------------------------------------------------------------------------
// Withdrawals (prompt_phase3.md rules 109-120)
//
// A lock is a BALANCED TRANSFER between two accounts, never a column update.
// That is what `user_locked` was created for in Phase 2 and left unused until
// now: the movement shows up in the entry history, reverses by the same
// mechanism that created it, and cannot be half-applied.
// ---------------------------------------------------------------------------

export interface WithdrawalLockPosting {
  readonly withdrawalId: string;
  readonly userId: string;
  readonly asset: string;
  readonly amount: Amount;
}

/**
 * Reserve funds against an approved withdrawal (master-prompt rule 118).
 *
 *   debit  user_available — the user may no longer spend it
 *   credit user_locked    — but still owns it
 *
 * Total liability to the user is unchanged; only its spendability moves. That
 * is exactly what a reservation is, and expressing it as a transfer rather than
 * a flag is what makes it auditable.
 *
 * THIS IS ALSO THE SUFFICIENT-FUNDS CHECK (rules 113-114). If the available
 * balance cannot cover the amount, this transaction must not commit — the check
 * and the reservation are the same atomic act, so two concurrent withdrawals
 * cannot both pass a check and both proceed.
 */
export function postWithdrawalLock(input: WithdrawalLockPosting): LedgerTransaction {
  requirePositive(input.amount, input.withdrawalId, 'lock');

  return buildTransaction({
    kind: 'withdrawal_lock',
    referenceType: 'withdrawal',
    referenceId: input.withdrawalId,
    entries: [
      debit(userAvailable(input.userId, input.asset), input.asset, input.amount),
      credit(userLocked(input.userId, input.asset), input.asset, input.amount),
    ],
  });
}

/**
 * Return reserved funds to the user (master-prompt rule 119).
 *
 * Used on rejection, on an exhausted retry budget, and on cancellation. The
 * exact inverse of the lock, which is the point: a release cannot forget part
 * of the amount, because it is the same balanced movement in reverse.
 */
export function postWithdrawalRelease(input: WithdrawalLockPosting): LedgerTransaction {
  requirePositive(input.amount, input.withdrawalId, 'release');

  return buildTransaction({
    kind: 'withdrawal_release',
    referenceType: 'withdrawal',
    referenceId: input.withdrawalId,
    entries: [
      debit(userLocked(input.userId, input.asset), input.asset, input.amount),
      credit(userAvailable(input.userId, input.asset), input.asset, input.amount),
    ],
  });
}

export interface WithdrawalSettlePosting extends WithdrawalLockPosting {
  /**
   * The network fee actually paid, in base units.
   *
   * Charged to `house_fees`, not to the user, unless the product deliberately
   * passes it on — and if it does, that is a separate entry with its own
   * reason, never a silent reduction of the user's amount (rule 118).
   */
  readonly networkFee?: Amount;
  /**
   * The asset the FEE is denominated in. ALWAYS the native asset, never the
   * mint — even when `asset` is a token (ADR-0016).
   *
   * Required rather than defaulted to `asset`, for the same reason
   * `postTokenAccountRent` takes `nativeAsset` explicitly: a validator is paid
   * in lamports whatever is being moved, and posting a lamport fee against a
   * mint invents SOL out of USDC. Defaulting would make the correct call and
   * the wrong one look identical at the call site, and the wrong one is the
   * one you get by not thinking about it.
   */
  readonly feeAsset: string;
}

/**
 * The money has left the platform (master-prompt rule 143).
 *
 *   debit  user_locked  — the liability is discharged
 *   credit chain_assets — we control that much less on-chain
 *
 * THIS IS THE ONLY PLACE `chain_assets` DECREASES. Phase 2 could not do it at
 * all, because nothing could send.
 *
 * Posted only after the transaction reaches `finalized` (rules 119, 138).
 * Settling at `confirmed` and then seeing the transaction dropped would mean
 * funds released from the lock that never left.
 */
export function postWithdrawalSettlement(input: WithdrawalSettlePosting): LedgerTransaction {
  requirePositive(input.amount, input.withdrawalId, 'settle');

  const fee = input.networkFee ?? 0n;
  if (isNegative(fee)) {
    throw new InvalidEntryError('withdrawal_fee_negative', { withdrawalId: input.withdrawalId });
  }

  const entries = [
    debit(userLocked(input.userId, input.asset), input.asset, input.amount),
    // Out of the user's OWN segregated address, not a pooled vault.
    credit(chainAssets(input.userId, input.asset), input.asset, input.amount),
  ];

  if (!isZero(fee)) {
    // The fee leaves the platform too, and the house bears it. Two more
    // entries rather than adjusting the amounts above, so the user-facing
    // movement and the cost of making it stay separately visible.
    entries.push(
      /*
       * The fee is the HOUSE's, leaves the HOUSE's wallet, and is denominated
       * in the NATIVE asset.
       *
       * Under segregation the fee payer is deliberately not the user: a
       * token-only balance would otherwise be unspendable, because the user
       * has no SOL at their address to pay with. Charging it to the user's
       * `chain_assets` would also mean debiting an address the fee never left.
       *
       * `feeAsset`, not `asset`. Withdrawing USDC costs lamports, and these
       * two entries used to carry the mint — which credited the house's USDC
       * chain assets with a number of lamports and left every token
       * withdrawal short in the books by exactly the fee it paid.
       */
      debit(houseFees(input.feeAsset), input.feeAsset, fee),
      credit(houseChainAssets(input.feeAsset), input.feeAsset, fee),
    );
  }

  return buildTransaction({
    kind: 'withdrawal_settle',
    referenceType: 'withdrawal',
    referenceId: input.withdrawalId,
    entries,
  });
}

/**
 * The platform funds its own operating balance.
 *
 * WHY THIS HAS TO EXIST
 *
 * Network fees are paid from the same on-chain pool that holds user funds. If
 * the house simply debits `house_fees` without having put anything in, the
 * arithmetic is unavoidable: total user liabilities come to exceed
 * chain-controlled assets, and the platform is paying its operating costs out
 * of customer money.
 *
 * The `liabilities_covered` invariant catches this immediately — it was the
 * first thing it caught once withdrawals could pay a fee — which is precisely
 * what an invariant is for.
 *
 * So the house deposits its own funds, like any other participant:
 *
 *   debit  chain_assets — the platform controls more on-chain
 *   credit house_fees   — and that portion is the house's, not a user's
 *
 * `house_fees` then behaves as a prepaid balance that fee payments draw down,
 * and it may never go negative. A custodian that has not funded its fee wallet
 * cannot pay fees, which is the correct answer rather than an inconvenient one.
 */
export function postHouseFunding(input: {
  readonly reference: string;
  readonly asset: string;
  readonly amount: Amount;
}): LedgerTransaction {
  requirePositive(input.amount, input.reference, 'house_funding');

  return buildTransaction({
    kind: 'fee',
    referenceType: 'house_funding',
    referenceId: input.reference,
    entries: [
      debit(houseChainAssets(input.asset), input.asset, input.amount),
      credit(houseFees(input.asset), input.asset, input.amount),
    ],
  });
}

/**
 * A nonce account's rent-exempt minimum (ADR-0009).
 *
 * A durable nonce account is an on-chain account and needs the same minimum a
 * deposit address does. It is real, ours, and not user-withdrawable, so it goes
 * to `house_rent` for the same reason deposit-address minimums do.
 */
export function postNonceAccountRent(input: {
  readonly nonceAccountId: string;
  readonly asset: string;
  readonly amount: Amount;
}): LedgerTransaction {
  requirePositive(input.amount, input.nonceAccountId, 'nonce_rent');

  return buildTransaction({
    kind: 'fee',
    referenceType: 'nonce_account',
    referenceId: input.nonceAccountId,
    entries: [
      // Nonce accounts are house infrastructure, not a user's address.
      debit(houseChainAssets(input.asset), input.asset, input.amount),
      credit(houseRent(input.asset), input.asset, input.amount),
    ],
  });
}

function requirePositive(amount: Amount, reference: string, what: string): void {
  if (isNegative(amount) || isZero(amount)) {
    throw new InvalidEntryError(`${what}_amount_not_positive`, { reference });
  }
}

/**
 * The network fee a sweep pays (ADR-0017, prompt_phase4.md rule 131).
 *
 * WHY A SWEEP POSTS ONLY ITS FEE, AND NOT A TRANSFER
 *
 * A sweep moves value from a deposit address to the hot wallet. Both are the
 * platform's, and the chart of accounts has exactly ONE `chain_assets` account
 * per asset (`ownerId` is null for it) — there is no per-tier dimension. So
 * the ledger's answer to "how much does the platform control" is identical
 * before and after, and a transfer entry would have to debit and credit the
 * same account, which is not an entry at all.
 *
 * Where the money sits is an OPERATIONAL fact, recorded on the address and
 * withdrawal rows. It is not an accounting fact. This is also what makes
 * reconciliation work the way it does: it sums every platform address and
 * compares against one aggregate, and that comparison is correct precisely
 * because the total does not depend on the tier split.
 *
 * What a sweep genuinely does change is that it burns a network fee, which
 * really does leave the platform. That is this posting, and it is drawn from
 * the prepaid `house_fees` balance rather than from pooled customer funds —
 * the Phase 3 lesson, applied to a new caller (rules 121, 132).
 *
 * The invariant to test: **total user liabilities are bit-identical across a
 * sweep.** A sweep that moves a user balance is not a sweep with a bug; it is a
 * different operation wearing the name.
 */
export function postSweepFee(input: {
  readonly sweepId: string;
  readonly asset: string;
  readonly amount: Amount;
}): LedgerTransaction {
  requirePositive(input.amount, input.sweepId, 'sweep_fee');

  return buildTransaction({
    kind: 'fee',
    referenceType: 'sweep',
    referenceId: input.sweepId,
    entries: [
      // The mirror of postHouseFunding: the prepaid balance is consumed, and
      // the on-chain total falls by what the validator took.
      debit(houseFees(input.asset), input.asset, input.amount),
      credit(houseChainAssets(input.asset), input.asset, input.amount),
    ],
  });
}

/**
 * An Associated Token Account's rent-exempt minimum (ADR-0016, rule 118).
 *
 * Identical in character to a deposit address's minimum and to a nonce
 * account's: real lamports, spent by us, held in an account we control, and not
 * withdrawable by the user. Crediting it to the user would create a SOL
 * liability they never deposited and cannot ever draw.
 *
 * Note the asset asymmetry that makes this easy to get wrong: the rent is
 * denominated in the NATIVE asset even though the account it creates holds a
 * token. Posting it against the mint would invent SOL out of USDC.
 */
export function postTokenAccountRent(input: {
  readonly reference: string;
  /**
   * Whose account this rent created (ADR-0020).
   *
   * The lamports END UP in the user's token account — they are on-chain assets
   * sitting at an address attributed to that user, so per-user reconciliation
   * must expect them there. But the user never deposited them and can never
   * withdraw them, which is what the `house_rent` credit records.
   *
   * Getting this wrong in either direction is a real error: attributing the
   * rent to the house makes every user's on-chain balance read high against
   * their ledger, and crediting it to the user creates a liability the platform
   * cannot discharge.
   */
  readonly ownerId: string;
  /** The NATIVE asset. Never the mint. */
  readonly nativeAsset: string;
  readonly amount: Amount;
}): LedgerTransaction {
  requirePositive(input.amount, input.reference, 'token_account_rent');

  return buildTransaction({
    kind: 'fee',
    referenceType: 'token_account',
    referenceId: input.reference,
    entries: [
      debit(chainAssets(input.ownerId, input.nativeAsset), input.nativeAsset, input.amount),
      credit(houseRent(input.nativeAsset), input.nativeAsset, input.amount),
    ],
  });
}
