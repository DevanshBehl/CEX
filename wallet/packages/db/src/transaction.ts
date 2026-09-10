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

function isRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const code = (error.meta as { code?: string } | undefined)?.code;
    if (code !== undefined && RETRYABLE_PG_CODES.has(code)) return true;
  }
  const message = error instanceof Error ? error.message : '';
  return [...RETRYABLE_PG_CODES].some((c) => message.includes(c));
}

/**
 * The transaction helper every balance-affecting write in Phase 2 will use
 * (rule 90). It exists in Phase 1 — before there is a ledger to protect —
 * because retrofitting a consistent transaction boundary across code that
 * already moves money is far more expensive than having one ready.
 */
export async function withTransaction<T>(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolationLevel = options.isolationLevel ?? Prisma.TransactionIsolationLevel.Serializable;
  const maxRetries = options.maxRetries ?? 3;
  const timeout = options.timeoutMs ?? 10_000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await client.$transaction(fn, { isolationLevel, timeout });
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
