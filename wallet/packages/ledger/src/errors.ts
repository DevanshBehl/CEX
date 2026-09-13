import { AppError } from '@wallet/errors';
import type { ErrorCode } from '@wallet/types';

/**
 * Ledger construction failures.
 *
 * These are internal-integrity errors, not user-facing ones: reaching any of
 * them means the caller tried to write books that do not balance, which is a
 * bug rather than a condition a user can cause. They surface as 500s
 * deliberately — a 400 would suggest the request could be corrected and
 * retried.
 */
export class LedgerIntegrityError extends AppError {
  readonly code: ErrorCode = 'INTERNAL_ERROR';
  readonly httpStatus = 500;
  override readonly isOperational = false;

  constructor(reason: string, detail?: Record<string, unknown>) {
    super('A ledger integrity check failed', {
      detail: { reason, ...detail },
    });
  }
}

export class UnbalancedTransactionError extends LedgerIntegrityError {
  constructor(asset: string, residual: string) {
    super('transaction_unbalanced', { asset, residual });
  }
}

/**
 * One transaction, two clusters (ADR-0021).
 *
 * Devnet money and mainnet money are different money. A transaction touching
 * both is either a bug in how an asset key was built or an attempt to move
 * value between chains through the ledger, and neither is something to record
 * and investigate later.
 */
export class CrossClusterTransactionError extends LedgerIntegrityError {
  constructor(expected: string, found: string) {
    super('transaction_spans_clusters', { expected, found });
  }
}

export class InvalidEntryError extends LedgerIntegrityError {
  constructor(reason: string, detail?: Record<string, unknown>) {
    super(reason, detail);
  }
}
