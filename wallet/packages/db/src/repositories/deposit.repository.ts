import { Prisma } from '@prisma/client';
import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface DepositRecord {
  id: string;
  walletId: string;
  addressId: string;
  userId: string;
  chain: string;
  asset: string;
  amount: string;
  rentReserved: string;
  txSignature: string;
  instructionIndex: number;
  position: bigint;
  status: 'confirming' | 'credited' | 'ignored';
  reason: string | null;
  ledgerTransactionId: string | null;
  createdAt: Date;
  creditedAt: Date | null;
}

export interface RecordDepositInput {
  readonly walletId: string;
  readonly addressId: string;
  readonly userId: string;
  readonly chain: string;
  readonly asset: string;
  readonly amount: string;
  readonly rentReserved: string;
  readonly txSignature: string;
  readonly instructionIndex: number;
  readonly position: bigint;
}

export type RecordDepositResult =
  | { readonly outcome: 'created'; readonly deposit: DepositRecord }
  /** The uniqueness constraint fired: this transfer was already processed. */
  | { readonly outcome: 'duplicate' };

export interface DepositRepository {
  record(input: RecordDepositInput, tx?: Executor): Promise<RecordDepositResult>;
  markCredited(id: string, ledgerTransactionId: string, tx?: Executor): Promise<void>;
  /**
   * Record a detected transfer that will never be credited (ADR-0016).
   *
   * An unrecognised mint arriving at a custody address is routine, not
   * exceptional. Dropping it leaves a user's "where is my token" question
   * unanswerable; crediting it creates a liability in an asset the platform
   * cannot value. The row is the third option: attributable, auditable, and
   * carrying no ledger entries, because it is an observation about the chain
   * rather than an accounting event (rules 124-125).
   */
  markIgnored(id: string, reason: string, tx?: Executor): Promise<void>;
  findById(id: string, tx?: Executor): Promise<DepositRecord | null>;
  findByChainReference(
    chain: string,
    txSignature: string,
    instructionIndex: number,
    tx?: Executor,
  ): Promise<DepositRecord | null>;
  /**
   * One cluster's deposits (ADR-0021).
   *
   * `chain` is required: a list merging devnet and mainnet deposits would be
   * unreadable, and any total taken from it would be wrong.
   */
  listForUser(
    userId: string,
    limit: number,
    chain: string,
    tx?: Executor,
  ): Promise<DepositRecord[]>;
}

export function createDepositRepository(db: Executor): DepositRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    /**
     * IDEMPOTENCY LIVES HERE (master-prompt rule 130, prompt_phase2.md rules
     * 127-128, 154-155).
     *
     * The insert is attempted and a unique-constraint violation on
     * (chain, tx_signature, instruction_index) is caught and reported as a
     * duplicate. That constraint IS the mechanism.
     *
     * It is deliberately NOT "select, then insert if absent". Between that
     * select and that insert, another worker — or the same worker on another
     * connection — can insert the same row, and both callers then believe they
     * created it. Under Serializable one would abort, but relying on that makes
     * correctness depend on an isolation level a future maintainer might
     * reasonably lower. The constraint does not care about isolation.
     */
    async record(input, tx) {
      const id = newId();

      // ON CONFLICT DO NOTHING, not try/catch.
      //
      // Catching a unique violation inside a PostgreSQL transaction does not
      // work: the failed statement ABORTS the transaction, and every
      // subsequent command returns 25P02 "current transaction is aborted".
      // The catch appears to succeed while leaving the transaction unusable —
      // here it broke the `SET CONSTRAINTS ALL IMMEDIATE` that `withTransaction`
      // issues at commit, which is the thing that makes deferred constraint
      // failures visible at all.
      //
      // ON CONFLICT DO NOTHING is the Postgres-native way to express the same
      // intent: no error is raised, the transaction stays healthy, and an empty
      // RETURNING tells us the row was already there.
      const rows = await exec(tx).$queryRaw<Array<{ id: string }>>`
        INSERT INTO deposits (
          id, wallet_id, address_id, user_id, chain, asset, amount, rent_reserved,
          tx_signature, instruction_index, position, status, created_at, updated_at
        ) VALUES (
          ${id}::uuid, ${input.walletId}::uuid, ${input.addressId}::uuid,
          ${input.userId}::uuid, ${input.chain}, ${input.asset},
          ${new Prisma.Decimal(input.amount)}, ${new Prisma.Decimal(input.rentReserved)},
          ${input.txSignature}, ${input.instructionIndex}, ${input.position},
          'confirming'::"DepositStatus", now(), now()
        )
        ON CONFLICT (chain, tx_signature, instruction_index) DO NOTHING
        RETURNING id
      `;

      if (rows.length === 0) return { outcome: 'duplicate' };

      const created = await exec(tx).deposit.findUniqueOrThrow({ where: { id } });
      return { outcome: 'created', deposit: toRecord(created) };
    },

    async markIgnored(id, reason, tx) {
      await exec(tx).deposit.update({
        where: { id },
        data: { status: 'ignored', reason },
      });
    },

    async markCredited(id, ledgerTransactionId, tx) {
      await exec(tx).deposit.update({
        where: { id },
        data: { status: 'credited', ledgerTransactionId, creditedAt: new Date() },
      });
    },

    async findById(id, tx) {
      const row = await exec(tx).deposit.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async findByChainReference(chain, txSignature, instructionIndex, tx) {
      const row = await exec(tx).deposit.findUnique({
        where: {
          chain_txSignature_instructionIndex: { chain, txSignature, instructionIndex },
        },
      });
      return row ? toRecord(row) : null;
    },

    async listForUser(userId, limit, chain, tx) {
      const rows = await exec(tx).deposit.findMany({
        where: { userId, chain },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return rows.map(toRecord);
    },
  };
}

/**
 * Prisma returns Decimal objects and the domain wants base-unit strings.
 * `toFixed(0)` rather than `toString()`: Decimal.toString can produce
 * exponential notation for large values, which would then fail to parse as an
 * integer string.
 */
function toRecord(row: {
  id: string;
  walletId: string;
  addressId: string;
  userId: string;
  chain: string;
  asset: string;
  amount: Prisma.Decimal;
  rentReserved: Prisma.Decimal;
  txSignature: string;
  instructionIndex: number;
  position: bigint;
  status: 'confirming' | 'credited' | 'ignored';
  reason: string | null;
  ledgerTransactionId: string | null;
  createdAt: Date;
  creditedAt: Date | null;
}): DepositRecord {
  return {
    ...row,
    amount: row.amount.toFixed(0),
    rentReserved: row.rentReserved.toFixed(0),
  };
}
