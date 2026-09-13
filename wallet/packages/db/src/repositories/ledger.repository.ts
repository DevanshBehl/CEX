import { Prisma } from '@prisma/client';
import { parseLedgerAssetKey, type Cluster } from '@wallet/types';
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
  /**
   * Balances for ONE cluster (ADR-0021).
   *
   * The cluster is required rather than optional. An omitted filter would sum
   * devnet and mainnet into one number that looks entirely plausible, and no
   * invariant would be violated — which is the whole reason the cluster lives
   * inside the asset key.
   */
  getUserBalances(userId: string, cluster: Cluster, tx?: Executor): Promise<UserBalanceRow[]>;
  /** The asset key already names its cluster, so none is passed here. */
  getUserBalance(userId: string, asset: string, tx?: Executor): Promise<UserBalanceRow>;
  getAssetTotals(cluster: Cluster, tx?: Executor): Promise<AssetTotalsRow[]>;
  /**
   * Per-user on-chain position and liability, for segregated reconciliation
   * (ADR-0020).
   *
   * `getAssetTotals` compares aggregates, which under an omnibus model was the
   * only comparison available. Under segregation it is no longer sufficient: a
   * total that reconciles while two users' balances are individually wrong —
   * one short, one long — is exactly the failure segregation exists to catch,
   * and an aggregate cannot see it.
   */
  getSegregatedPositions(cluster: Cluster, tx?: Executor): Promise<SegregatedPositionRow[]>;
  /**
   * Every `user_available` entry for a user on one cluster, ASCENDING.
   *
   * For historical valuation (Task 3). Deliberately unbounded in time: a
   * balance at time T is the sum of everything before T, so a query windowed to
   * the chart's range would start from zero and draw a deposit that never
   * happened.
   *
   * Bounded in COUNT instead. A user with more entries than the cap is a real
   * possibility, and the honest failure there is a chart that says it is
   * truncated rather than one that silently omits the oldest half of someone's
   * history.
   */
  getUserAvailableEntries(
    userId: string,
    cluster: Cluster,
    until: Date,
    limit: number,
    tx?: Executor,
  ): Promise<TimedEntryRow[]>;
}

/** A ledger entry reduced to what a projection needs. */
export interface TimedEntryRow {
  readonly asset: string;
  readonly amount: string;
  readonly direction: 'debit' | 'credit';
  readonly at: Date;
}

/** One user's position in one asset, projected from entries. */
export interface SegregatedPositionRow {
  ownerId: string;
  asset: string;
  /** Debit-positive: what this user's own address should hold on-chain. */
  chainAssets: string;
  /** What the platform owes them: available + locked. */
  liability: string;
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
    async getUserBalances(userId, cluster, tx) {
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
          AND a.asset LIKE ${`${cluster}:%`}
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
      const balances = await this.getUserBalances(userId, parseLedgerAssetKey(asset).cluster, tx);
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
    async getSegregatedPositions(cluster, tx) {
      /*
       * Only accounts with an OWNER. House-owned `chain_assets` (the fee
       * wallet, nonce rent) live at `owner_id IS NULL` and belong to the
       * aggregate check, not to any user's reconciliation.
       */
      return exec(tx).$queryRaw<SegregatedPositionRow[]>`
        SELECT
          a.owner_id::text AS "ownerId",
          a.asset,
          COALESCE(SUM(CASE WHEN a.type = 'chain_assets'
            THEN (CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS "chainAssets",
          COALESCE(SUM(CASE WHEN a.type IN ('user_available','user_locked')
            THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
            ELSE 0 END), 0)::text AS "liability"
        FROM ledger_accounts a
        LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_id IS NOT NULL
          AND a.asset LIKE ${`${cluster}:%`}
        GROUP BY a.owner_id, a.asset
        HAVING COALESCE(SUM(CASE WHEN a.type = 'chain_assets'
                 THEN (CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END)
                 ELSE 0 END), 0) <> 0
            OR COALESCE(SUM(CASE WHEN a.type IN ('user_available','user_locked')
                 THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
                 ELSE 0 END), 0) <> 0
        ORDER BY a.owner_id, a.asset
      `;
    },

    async getUserAvailableEntries(userId, cluster, until, limit, tx) {
      /*
       * `user_available` only — not `user_locked`.
       *
       * A locked balance is still the user's money, but it is money they
       * cannot spend, and the dashboard's headline figure is "what you have".
       * The two are separate accounts precisely so this choice is explicit
       * rather than a filter someone forgot.
       */
      const rows = await exec(tx).$queryRaw<
        Array<{ asset: string; amount: string; direction: 'debit' | 'credit'; at: Date }>
      >`
        SELECT e.asset, e.amount::text AS amount, e.direction::text AS direction,
               e.created_at AS at
          FROM ledger_entries e
          JOIN ledger_accounts a ON a.id = e.account_id
         WHERE a.owner_id = ${userId}::uuid
           AND a.type = 'user_available'
           AND a.asset LIKE ${`${cluster}:%`}
           AND e.created_at <= ${until}
         ORDER BY e.created_at ASC, e.id ASC
         LIMIT ${limit}
      `;

      return rows.map((row) => ({
        asset: row.asset,
        amount: row.amount,
        direction: row.direction,
        at: row.at,
      }));
    },

    async getAssetTotals(cluster, tx) {
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
        WHERE a.asset LIKE ${`${cluster}:%`}
        GROUP BY a.asset
        ORDER BY a.asset
      `;
    },
  };
}
