import { Prisma } from '@prisma/client';
import { canTransition, type WithdrawalStatus } from '@wallet/types';
import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';

export interface WithdrawalRecord {
  id: string;
  userId: string;
  chain: string;
  asset: string;
  amount: string;
  networkFee: string | null;
  destination: string;
  status: WithdrawalStatus;
  idempotencyKey: string;
  signAttempts: number;
  broadcastAttempts: number;
  expiryAttempts: number;
  lockLedgerTransactionId: string | null;
  settleLedgerTransactionId: string | null;
  signedTransaction: Uint8Array | null;
  txSignature: string | null;
  nonceAccountId: string | null;
  nonceValue: string | null;
  failureReason: string | null;
  correlationId: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface CreateWithdrawalInput {
  readonly userId: string;
  readonly chain: string;
  readonly asset: string;
  readonly amount: string;
  readonly destination: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string | undefined;
}

export type CreateWithdrawalResult =
  | { readonly outcome: 'created'; readonly withdrawal: WithdrawalRecord }
  /** Same key: this is the SAME withdrawal, not a second one. */
  | { readonly outcome: 'existing'; readonly withdrawal: WithdrawalRecord };

export type RetryEdge = 'sign' | 'broadcast' | 'expiry';

export interface TransitionInput {
  readonly withdrawalId: string;
  readonly from: WithdrawalStatus;
  readonly to: WithdrawalStatus;
  readonly reason?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly correlationId?: string | undefined;
  /** Applied in the same statement as the status change. */
  readonly patch?: Partial<{
    lockLedgerTransactionId: string;
    settleLedgerTransactionId: string;
    signedTransaction: Uint8Array;
    txSignature: string;
    nonceAccountId: string | null;
    nonceValue: string | null;
    networkFee: string;
    failureReason: string;
    settledAt: Date;
  }>;
  readonly incrementAttempt?: RetryEdge | undefined;
}

export interface WithdrawalRepository {
  create(input: CreateWithdrawalInput, tx?: Executor): Promise<CreateWithdrawalResult>;
  findById(id: string, tx?: Executor): Promise<WithdrawalRecord | null>;
  findByIdempotencyKey(
    userId: string,
    key: string,
    tx?: Executor,
  ): Promise<WithdrawalRecord | null>;
  listForUser(userId: string, limit: number, tx?: Executor): Promise<WithdrawalRecord[]>;
  listByStatus(status: WithdrawalStatus, limit: number, tx?: Executor): Promise<WithdrawalRecord[]>;
  /** History used by the risk engine's rolling windows. */
  listRecentForUser(userId: string, since: Date, tx?: Executor): Promise<WithdrawalRecord[]>;
  listPriorDestinations(
    userId: string,
    since: Date,
    tx?: Executor,
  ): Promise<Array<{ address: string; lastUsedAt: Date }>>;
  /**
   * Move to a new state, atomically and only if still in `from`.
   *
   * Returns null when the withdrawal was not in `from` — which is not an error:
   * it is how a worker discovers that something else already moved it. That is
   * what makes a queue payload a hint rather than a fact (rules 104-105).
   */
  transition(input: TransitionInput, tx?: Executor): Promise<WithdrawalRecord | null>;
  /** Claim the next withdrawal in a state, for exactly one worker. */
  claimNext(
    status: WithdrawalStatus,
    to: WithdrawalStatus,
    correlationId: string,
    tx?: Executor,
  ): Promise<WithdrawalRecord | null>;
}

export function createWithdrawalRepository(db: Executor): WithdrawalRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    /**
     * Idempotent by construction.
     *
     * ON CONFLICT DO NOTHING, never try/catch: a failed statement aborts the
     * whole PostgreSQL transaction, and every later command returns 25P02 —
     * the Phase 2 lesson, restated in prompt_phase3.md rules 58-59.
     */
    async create(input, tx) {
      const e = exec(tx);
      const id = newId();

      const rows = await e.$queryRaw<Array<{ id: string }>>`
        INSERT INTO withdrawals (
          id, user_id, chain, asset, amount, destination, status,
          idempotency_key, correlation_id, created_at, updated_at
        ) VALUES (
          ${id}::uuid, ${input.userId}::uuid, ${input.chain}, ${input.asset},
          ${new Prisma.Decimal(input.amount)}, ${input.destination},
          'REQUESTED'::"WithdrawalStatus", ${input.idempotencyKey},
          ${input.correlationId ?? null}, now(), now()
        )
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING id
      `;

      if (rows.length === 0) {
        const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey, e);
        if (!existing) throw new Error('withdrawal conflict resolved to nothing');
        return { outcome: 'existing', withdrawal: existing };
      }

      // The opening transition, so the history is complete from the first
      // moment rather than starting at the second state.
      await e.$executeRaw`
        INSERT INTO withdrawal_transitions
          (id, withdrawal_id, from_status, to_status, correlation_id, created_at)
        VALUES (${newId()}::uuid, ${id}::uuid, NULL,
                'REQUESTED'::"WithdrawalStatus", ${input.correlationId ?? null}, now())
      `;

      const created = await e.withdrawal.findUniqueOrThrow({ where: { id } });
      return { outcome: 'created', withdrawal: toRecord(created) };
    },

    async findById(id, tx) {
      const row = await exec(tx).withdrawal.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async findByIdempotencyKey(userId, key, tx) {
      const row = await exec(tx).withdrawal.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
      });
      return row ? toRecord(row) : null;
    },

    async listForUser(userId, limit, tx) {
      const rows = await exec(tx).withdrawal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return rows.map(toRecord);
    },

    async listByStatus(status, limit, tx) {
      const rows = await exec(tx).withdrawal.findMany({
        where: { status },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map(toRecord);
    },

    async listRecentForUser(userId, since, tx) {
      const rows = await exec(tx).withdrawal.findMany({
        where: {
          userId,
          createdAt: { gte: since },
          // A rejected withdrawal never moved money and must not consume a
          // limit; anything else counts, including one still in flight.
          status: { notIn: ['REJECTED'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toRecord);
    },

    async listPriorDestinations(userId, since, tx) {
      const rows = await exec(tx).$queryRaw<Array<{ address: string; lastUsedAt: Date }>>`
        SELECT destination AS address, MAX(created_at) AS "lastUsedAt"
        FROM withdrawals
        WHERE user_id = ${userId}::uuid
          AND created_at >= ${since}
          AND status IN ('SETTLED', 'CONFIRMED', 'BROADCAST')
        GROUP BY destination
      `;
      return rows;
    },

    /**
     * The guarded transition.
     *
     * `WHERE status = from` makes it atomic: two workers racing to advance the
     * same withdrawal produce one winner and one null, with no lock held and no
     * read-then-write window. The database's own trigger independently refuses
     * an illegal pair, so a bug here cannot corrupt the machine.
     */
    async transition(input, tx) {
      const e = exec(tx);

      // Checked here too, so an illegal transition is a comprehensible error at
      // the call site rather than a constraint violation from three layers down.
      if (!canTransition(input.from, input.to)) {
        throw new Error(
          `illegal withdrawal transition ${input.from} -> ${input.to} (prompt_phase3.md rule 98)`,
        );
      }

      const patch = input.patch ?? {};
      const updated = await e.withdrawal.updateMany({
        where: { id: input.withdrawalId, status: input.from },
        data: {
          status: input.to,
          ...(patch.lockLedgerTransactionId !== undefined
            ? { lockLedgerTransactionId: patch.lockLedgerTransactionId }
            : {}),
          ...(patch.settleLedgerTransactionId !== undefined
            ? { settleLedgerTransactionId: patch.settleLedgerTransactionId }
            : {}),
          ...(patch.signedTransaction !== undefined
            ? { signedTransaction: Buffer.from(patch.signedTransaction) }
            : {}),
          ...(patch.txSignature !== undefined ? { txSignature: patch.txSignature } : {}),
          ...(patch.nonceAccountId !== undefined ? { nonceAccountId: patch.nonceAccountId } : {}),
          ...(patch.nonceValue !== undefined ? { nonceValue: patch.nonceValue } : {}),
          ...(patch.networkFee !== undefined
            ? { networkFee: new Prisma.Decimal(patch.networkFee) }
            : {}),
          ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
          ...(patch.settledAt !== undefined ? { settledAt: patch.settledAt } : {}),
          ...(input.incrementAttempt === 'sign' ? { signAttempts: { increment: 1 } } : {}),
          ...(input.incrementAttempt === 'broadcast'
            ? { broadcastAttempts: { increment: 1 } }
            : {}),
          ...(input.incrementAttempt === 'expiry' ? { expiryAttempts: { increment: 1 } } : {}),
        },
      });

      // Lost the race. Not an error — something else already moved it.
      if (updated.count === 0) return null;

      await e.$executeRaw`
        INSERT INTO withdrawal_transitions
          (id, withdrawal_id, from_status, to_status, reason, actor_user_id, correlation_id, created_at)
        VALUES (
          ${newId()}::uuid, ${input.withdrawalId}::uuid,
          ${input.from}::"WithdrawalStatus", ${input.to}::"WithdrawalStatus",
          ${input.reason ?? null}, ${input.actorUserId ?? null}::uuid,
          ${input.correlationId ?? null}, now()
        )
      `;

      return this.findById(input.withdrawalId, e);
    },

    /**
     * Claim one withdrawal for this worker.
     *
     * `FOR UPDATE SKIP LOCKED` so concurrent workers take different rows rather
     * than queueing behind one another, and the transition is guarded, so the
     * claim and the state change are one act.
     */
    async claimNext(status, to, correlationId, tx) {
      const e = exec(tx);

      const rows = await e.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM withdrawals
        WHERE status = ${status}::"WithdrawalStatus"
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;

      const id = rows[0]?.id;
      if (id === undefined) return null;

      return this.transition({ withdrawalId: id, from: status, to, correlationId }, e);
    },
  };
}

function toRecord(row: {
  id: string;
  userId: string;
  chain: string;
  asset: string;
  amount: Prisma.Decimal;
  networkFee: Prisma.Decimal | null;
  destination: string;
  status: string;
  idempotencyKey: string;
  signAttempts: number;
  broadcastAttempts: number;
  expiryAttempts: number;
  lockLedgerTransactionId: string | null;
  settleLedgerTransactionId: string | null;
  signedTransaction: Uint8Array | null;
  txSignature: string | null;
  nonceAccountId: string | null;
  nonceValue: string | null;
  failureReason: string | null;
  correlationId: string | null;
  createdAt: Date;
  settledAt: Date | null;
}): WithdrawalRecord {
  return {
    ...row,
    status: row.status as WithdrawalStatus,
    // toFixed(0), not toString(): Decimal.toString can emit exponential
    // notation for large values, which then fails to parse as an integer.
    amount: row.amount.toFixed(0),
    networkFee: row.networkFee?.toFixed(0) ?? null,
  };
}
