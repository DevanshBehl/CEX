import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * A handle that is either the base client or an open transaction. Repositories
 * accept this so the same method works inside and outside a transaction.
 */
export type Executor = PrismaClient | Prisma.TransactionClient;

export interface TransactionOptions {
  /**
   * Serializable by default (prompt_phase1.md rule 91).
   *
   * Phase 1 has no ledger, so this is stricter than Phase 1 strictly needs.
   * That is the point: Phase 2's balance reads and writes are exactly the
   * workload where Read Committed silently permits write skew — two concurrent
   * withdrawals each reading a sufficient balance and each committing. Making
   * Serializable the thing you get by default, and a weaker level the thing you
   * have to ask for in writing, puts the burden of proof on the right side.
   *
   * The cost is that transactions can fail with a serialization error and must
   * be retried. See `withTransaction`'s retry loop.
   */
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

/** Postgres serialization failure / deadlock — both are safe to retry. */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

/**
 * Prisma's own code for "write conflict or deadlock".
 *
 * Prisma does not surface the underlying SQLSTATE for a serialization failure —
 * it reports P2034 with the message "Transaction failed due to a write conflict
 * or a deadlock". Checking only for 40001/40P01 therefore never matched, and
 * the retry loop never fired.
 *
 * That mattered more than it looks: `withTransaction` defaults to Serializable
 * precisely because the ledger needs it, and under Serializable conflicts are
 * NORMAL — retrying is what makes the isolation level usable. Without a working
 * retry, two concurrent deposits to the same account surfaced a 500 instead of
 * one of them simply taking a moment longer.
 */
const PRISMA_WRITE_CONFLICT = 'P2034';

function isRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === PRISMA_WRITE_CONFLICT) return true;
    const pgCode = (error.meta as { code?: string } | undefined)?.code;
    if (pgCode !== undefined && RETRYABLE_PG_CODES.has(pgCode)) return true;
  }

  const message = error instanceof Error ? error.message : '';
  if ([...RETRYABLE_PG_CODES].some((code) => message.includes(code))) return true;
  return /write conflict|deadlock|could not serialize/i.test(message);
}

/**
 * The transaction helper every balance-affecting write goes through.
 *
 * WHY IT FORCES DEFERRED CONSTRAINTS EARLY
 *
 * The ledger's balance check is a DEFERRED constraint trigger: it must be
 * deferred, because entries are inserted one at a time and every intermediate
 * state is legitimately unbalanced. Deferred means it fires at COMMIT.
 *
 * And Prisma does not propagate a COMMIT-time failure. `$transaction(fn)`
 * resolves with the callback's return value even when PostgreSQL rejected the
 * commit and rolled the whole thing back. Verified against Prisma 6.1:
 * an unbalanced ledger transaction was refused by the database, wrote nothing,
 * and the application was told it succeeded.
 *
 * For a ledger that is the worst possible failure mode — the books say the
 * money did not move and the application believes it did, with no error
 * anywhere to notice.
 *
 * `SET CONSTRAINTS ALL IMMEDIATE` at the end of the callback forces every
 * deferred constraint to be checked INSIDE the transaction, where the error
 * propagates normally. The constraint is still deferred for the duration of
 * the writes, so the multi-entry insert still works.
 */
export async function withTransaction<T>(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolationLevel = options.isolationLevel ?? Prisma.TransactionIsolationLevel.Serializable;
  // Five, not three: under Serializable a conflict is a normal outcome, and
  // the cost of one more retry is milliseconds against the cost of surfacing a
  // failure for work that would have succeeded.
  const maxRetries = options.maxRetries ?? 5;
  const timeout = options.timeoutMs ?? 10_000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await client.$transaction(
        async (tx) => {
          const result = await fn(tx);
          // See the note above: without this, a deferred-constraint violation
          // is silently swallowed and reported to the caller as success.
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
          return result;
        },
        { isolationLevel, timeout },
      );
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) throw error;
      // Full jitter, so concurrent retries do not re-collide in lockstep.
      const backoffMs = Math.random() * 25 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}

export { Prisma };
