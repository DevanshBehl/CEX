import { accountKey, type AccountRef } from './accounts.js';
import { isNegative, isZero, sum, type Amount } from './amount.js';
import {
  signedAmount,
  type Entry,
  type LedgerTransaction,
  type TransactionKind,
} from './entries.js';
import { parseLedgerAssetKey, type Cluster } from '@wallet/types';
import {
  CrossClusterTransactionError,
  InvalidEntryError,
  UnbalancedTransactionError,
} from './errors.js';

export interface BuildTransactionInput {
  readonly kind: TransactionKind;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly entries: readonly Entry[];
}

/**
 * The ONLY way a LedgerTransaction is constructed (prompt_phase2.md rule 81).
 *
 * Every invariant that can be checked without knowing the rest of the ledger is
 * checked here, so an unbalanced transaction cannot exist as a value — not
 * merely cannot be persisted. The database enforces the same rule again at
 * commit (rules 134-135); this is the copy that produces a comprehensible
 * error rather than a constraint violation.
 */
export function buildTransaction(input: BuildTransactionInput): LedgerTransaction {
  const { entries } = input;

  if (entries.length < 2) {
    // One entry cannot balance against anything. Double-entry is the point.
    throw new InvalidEntryError('transaction_needs_two_entries', { count: entries.length });
  }

  for (const entry of entries) {
    if (isNegative(entry.amount)) {
      // The sign lives in `direction`. A negative amount would mean two
      // representations of the same movement, and they would disagree.
      throw new InvalidEntryError('entry_amount_negative', {
        account: accountKey(entry.account),
      });
    }
    if (isZero(entry.amount)) {
      throw new InvalidEntryError('entry_amount_zero', { account: accountKey(entry.account) });
    }
    if (entry.asset !== entry.account.asset) {
      // An entry names its asset and so does its account. If they disagree,
      // one of them is wrong and there is no way to tell which.
      throw new InvalidEntryError('entry_asset_mismatch', {
        account: accountKey(entry.account),
      });
    }
  }

  /*
   * EVERY ENTRY BELONGS TO ONE CLUSTER (ADR-0021).
   *
   * The per-asset balance check below already makes a cross-cluster TRANSFER
   * impossible — debit `devnet:SOL`, credit `mainnet-beta:SOL` leaves two
   * groups, each with a residual. What it does not catch is a transaction that
   * happens to be balanced in two clusters at once, which is still one
   * financial event claiming to have happened on two chains.
   *
   * It also rejects an UNQUALIFIED asset outright. That is the load-bearing
   * part: a bare `SOL` reaching the ledger is the bug the whole cluster
   * dimension exists to prevent, and it must fail at the first entry rather
   * than balance perfectly against another bare `SOL`.
   */
  let cluster: Cluster | undefined;
  for (const entry of entries) {
    let parsed;
    try {
      parsed = parseLedgerAssetKey(entry.asset);
    } catch {
      // Rethrown as a ledger error rather than a TypeError: the caller built
      // an asset key wrong, and the account it was heading for is the useful
      // part of the message.
      throw new InvalidEntryError('entry_asset_not_cluster_qualified', {
        account: accountKey(entry.account),
        asset: entry.asset,
      });
    }

    if (cluster === undefined) {
      cluster = parsed.cluster;
    } else if (parsed.cluster !== cluster) {
      throw new CrossClusterTransactionError(cluster, parsed.cluster);
    }
  }

  // Balance is checked per asset, not in aggregate (rule 79). A transaction
  // that is +1 SOL and -1 USDC sums to zero only if you pretend the two are
  // interchangeable, which is exactly the mistake worth preventing.
  const byAsset = new Map<string, Amount[]>();
  for (const entry of entries) {
    const bucket = byAsset.get(entry.asset);
    if (bucket) bucket.push(signedAmount(entry));
    else byAsset.set(entry.asset, [signedAmount(entry)]);
  }

  for (const [asset, signed] of byAsset) {
    const residual = sum(signed);
    if (!isZero(residual)) {
      throw new UnbalancedTransactionError(asset, residual.toString());
    }
  }

  return {
    kind: input.kind,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    entries: [...entries],
  };
}

/** True when the entries balance per asset. Does not throw; for tests and checks. */
export function isBalanced(entries: readonly Entry[]): boolean {
  const byAsset = new Map<string, Amount>();
  for (const entry of entries) {
    byAsset.set(entry.asset, (byAsset.get(entry.asset) ?? 0n) + signedAmount(entry));
  }
  return [...byAsset.values()].every(isZero);
}

export function accountsTouched(transaction: LedgerTransaction): AccountRef[] {
  const seen = new Map<string, AccountRef>();
  for (const entry of transaction.entries) {
    seen.set(accountKey(entry.account), entry.account);
  }
  return [...seen.values()];
}
