import type { ErrorCode } from '@wallet/types';

/**
 * Base of the error hierarchy (prompt_phase1.md rules 79-87).
 *
 * The split that matters is `clientMessage` vs `detail`:
 *   - `clientMessage` crosses the network. Safe, stable, human-readable.
 *   - `detail`       never does. It goes to the logs and nowhere else (rule 84).
 *
 * Anything that is not an AppError is treated as a bug, becomes an
 * InternalError, and is logged at error level (rule 86).
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;

  /** Safe to return to a client. */
  readonly clientMessage: string;
  /** Internal context. Logged, never serialized to a response. */
  readonly detail: Record<string, unknown> | undefined;
  /** true = an expected condition; false = a bug worth alerting on. */
  readonly isOperational: boolean = true;

  constructor(
    clientMessage: string,
    options?: { detail?: Record<string, unknown>; cause?: unknown },
  ) {
    super(clientMessage, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.clientMessage = clientMessage;
    this.detail = options?.detail;
    Error.captureStackTrace?.(this, new.target);
  }
}
