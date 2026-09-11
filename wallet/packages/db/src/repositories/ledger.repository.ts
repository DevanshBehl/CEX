import { Prisma } from '@prisma/client';
import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

/**
 * Ledger persistence.
 *
 * Note what this interface does NOT expose: no update, no delete, and no way to
 * write an entry outside a transaction. Append-only is a property of the
 * database (see the ledger_immutability migration), and this surface is shaped
 * so application code is not even tempted (prompt_phase2.md rule 78).
 */

export type LedgerAccountType =
  | 'user_available'
  | 'user_locked'
  | 'chain_assets'
  | 'house_fees'
  | 'house_rent'
  | 'external';

export type EntryDirection = 'debit' | 'credit';

export type LedgerTransactionKind =
  | 'deposit'
  | 'withdrawal_lock'
  | 'withdrawal_release'
  | 'withdrawal_settle'
  | 'sweep'
  | 'fee'
  | 'adjustment';

export interface AccountRefInput {
  readonly ownerId: string | null;
  readonly asset: string;
  readonly type: LedgerAccountType;
}

export interface EntryInput {
  readonly account: AccountRefInput;
  readonly asset: string;
  /** Non-negative base units as a decimal string. The sign is in `direction`. */
  readonly amount: string;
  readonly direction: EntryDirection;
}

export interface PostTransactionInput {
  readonly kind: LedgerTransactionKind;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly entries: readonly EntryInput[];
}

export interface UserBalanceRow {
  readonly asset: string;
  readonly available: string;
  readonly locked: string;
  readonly total: string;
}

export interface AssetTotalsRow {
  readonly asset: string;
  readonly userLiabilities: string;
  readonly chainAssets: string;
  readonly houseRent: string;
  readonly houseFees: string;
}

export interface LedgerRepository {
  ensureAccount(ref: AccountRefInput, tx?: Executor): Promise<string>;
  /**
   * Create any missing accounts BEFORE opening the ledger transaction.
   *
   * Account creation is idempotent and not balance-affecting, so it does not
   * need to be atomic with the entries. Doing it inside the Serializable
   * transaction made it the dominant source of write conflicts: every
   * concurrent first-write to the same account raced on the same unique key,
   * and under enough contention the retry budget was exhausted and a caller
   * saw a failure for what is really just "someone else got there first".
   *
   * Pre-creating removes that contention almost entirely. `ensureAccount`
   * remains inside `postTransaction` as a fallback, so correctness never
   * depends on the caller remembering to call this.
   */
  ensureAccounts(refs: readonly AccountRefInput[], tx?: Executor): Promise<void>;
  postTransaction(input: PostTransactionInput, tx?: Executor): Promise<string>;
  getUserBalances(userId: string, tx?: Executor): Promise<UserBalanceRow[]>;
  getUserBalance(userId: string, asset: string, tx?: Executor): Promise<UserBalanceRow>;
  getAssetTotals(tx?: Executor): Promise<AssetTotalsRow[]>;
}

export function createLedgerRepository(db: Executor): LedgerRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    /**
     * Accounts are created on first use rather than provisioned up front.
     *
     * `ON CONFLICT DO NOTHING` plus a re-read, because two concurrent deposits
     * for the same new user will both try. Doing this as select-then-insert
     * would lose that race; the unique constraint on (owner, asset, type) is
     * what actually decides it.
     */
    async ensureAccount(ref, tx) {
      const e = exec(tx);
      const id = newId();

      await e.$executeRaw`
        INSERT INTO ledger_accounts (id, owner_id, asset, type, created_at)
        VALUES (${id}::uuid, ${ref.ownerId}::uuid, ${ref.asset},
                ${ref.type}::"LedgerAccountType", now())
        ON CONFLICT (owner_id, asset, type) DO NOTHING
      `;

      const rows = await e.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM ledger_accounts
        WHERE owner_id IS NOT DISTINCT FROM ${ref.ownerId}::uuid
          AND asset = ${ref.asset}
          AND type = ${ref.type}::"LedgerAccountType"
      `;

      const found = rows[0]?.id;
      if (found === undefined) {
        throw new Error(`failed to ensure ledger account ${ref.type}:${ref.asset}`);
      }
      return found;
    },

    async ensureAccounts(refs, tx) {
      for (const ref of refs) {
        await this.ensureAccount(ref, tx);
      }
    },

    /**
     * Writes one balanced transaction.
     *
     * MUST be called inside a `withTransaction` block. The balance check is a
     * DEFERRED constraint trigger, so it fires at COMMIT — outside a
     * transaction each insert would auto-commit and the first entry would be
     * rejected as unbalanced on its own.
     */
    async postTransaction(input, tx) {
      const e = exec(tx);
      const transactionId = newId();

      await e.$executeRaw`
        INSERT INTO ledger_transactions (id, kind, reference_type, reference_id, created_at)
        VALUES (${transactionId}::uuid, ${input.kind}::"LedgerTransactionKind",
                ${input.referenceType}, ${input.referenceId}, now())
      `;

      for (const entry of input.entries) {
        const accountId = await this.ensureAccount(entry.account, e);
        await e.$executeRaw`
          INSERT INTO ledger_entries
            (id, transaction_id, account_id, asset, amount, direction, created_at)
          VALUES (${newId()}::uuid, ${transactionId}::uuid, ${accountId}::uuid,
                  ${entry.asset}, ${new Prisma.Decimal(entry.amount)},
                  ${entry.direction}::"EntryDirection", now())
        `;
      }

      return transactionId;
    },

    /**
     * Balances are PROJECTIONS, computed by summing entries
     * (prompt_phase2.md rules 82-85).
     *
     * There is no balance column to read. The negation reflects that user
     * accounts are liabilities: a credit increases what the user holds.
     */
    async getUserBalances(userId, tx) {
      const rows = await exec(tx).$queryRaw<
        Array<{ asset: string; available: string; locked: string }>
      >`
        SELECT
          a.asset,
          COALESCE(SUM(CASE WHEN a.type = 'user_available'
            THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS available,
          COALESCE(SUM(CASE WHEN a.type = 'user_locked'
            THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS locked
        FROM ledger_accounts a
        LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_id = ${userId}::uuid
          AND a.type IN ('user_available', 'user_locked')
        GROUP BY a.asset
        ORDER BY a.asset
      `;

      return rows.map((row) => ({
        asset: row.asset,
        available: row.available,
        locked: row.locked,
        total: (BigInt(row.available) + BigInt(row.locked)).toString(),
      }));
    },

    async getUserBalance(userId, asset, tx) {
      const balances = await this.getUserBalances(userId, tx);
      return (
        balances.find((b) => b.asset === asset) ?? {
          asset,
          available: '0',
          locked: '0',
          total: '0',
        }
      );
    },

    /** Totals per asset, for reconciliation (prompt_phase2.md rule 162). */
    async getAssetTotals(tx) {
      return exec(tx).$queryRaw<AssetTotalsRow[]>`
        SELECT
          a.asset,
          COALESCE(SUM(CASE WHEN a.type IN ('user_available','user_locked')
            THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS "userLiabilities",
          COALESCE(SUM(CASE WHEN a.type = 'chain_assets'
            THEN (CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS "chainAssets",
          COALESCE(SUM(CASE WHEN a.type = 'house_rent'
            THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS "houseRent",
          COALESCE(SUM(CASE WHEN a.type = 'house_fees'
            THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS "houseFees"
        FROM ledger_accounts a
        LEFT JOIN ledger_entries e ON e.account_id = a.id
        GROUP BY a.asset
        ORDER BY a.asset
      `;
    },
  };
}
