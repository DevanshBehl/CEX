import type { ErrorCode } from '@wallet/types';
import { AppError } from './app-error.js';

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export class ValidationError extends AppError {
  readonly code: ErrorCode = 'VALIDATION_FAILED';
  readonly httpStatus = 400;
  /** Field paths and reasons only — never the rejected values (rule 77). */
  readonly fields: readonly FieldIssue[];

  constructor(fields: readonly FieldIssue[], clientMessage = 'Request validation failed') {
    super(clientMessage);
    this.fields = fields;
  }
}

export class MalformedRequestError extends AppError {
  readonly code: ErrorCode = 'MALFORMED_REQUEST';
  readonly httpStatus = 400;
}

export class AuthenticationRequiredError extends AppError {
  readonly code: ErrorCode = 'AUTHENTICATION_REQUIRED';
  readonly httpStatus = 401;
  constructor(clientMessage = 'Authentication required') {
    super(clientMessage);
  }
}

/**
 * Deliberately uniform: the same message and status whether the account is
 * unknown, the credential is wrong, or the account is suspended. Anything
 * finer-grained is a user-enumeration oracle (rule 141).
 */
export class AuthenticationFailedError extends AppError {
  readonly code: ErrorCode = 'AUTHENTICATION_FAILED';
  readonly httpStatus = 401;
  constructor(detail?: Record<string, unknown>) {
    super('Authentication failed', detail !== undefined ? { detail } : undefined);
  }
}

export class SessionExpiredError extends AppError {
  readonly code: ErrorCode = 'SESSION_EXPIRED';
  readonly httpStatus = 401;
  constructor(clientMessage = 'Your session has expired') {
    super(clientMessage);
  }
}

export class AuthorizationDeniedError extends AppError {
  readonly code: ErrorCode = 'AUTHORIZATION_DENIED';
  readonly httpStatus = 403;
  constructor(clientMessage = 'You do not have access to this resource') {
    super(clientMessage);
  }
}

/**
 * The Phase 1 primitive that Phase 3 gates withdrawal submission on
 * (prompt_phase1.md rules 135-139). `maxAgeSeconds` tells the client how fresh
 * an assertion has to be so it can prompt rather than guess.
 */
export class StepUpRequiredError extends AppError {
  readonly code: ErrorCode = 'STEP_UP_REQUIRED';
  readonly httpStatus = 403;
  readonly maxAgeSeconds: number;

  constructor(maxAgeSeconds: number) {
    super('Re-authentication required to continue');
    this.maxAgeSeconds = maxAgeSeconds;
  }
}

export class CredentialCloneSuspectedError extends AppError {
  readonly code: ErrorCode = 'CREDENTIAL_CLONE_SUSPECTED';
  readonly httpStatus = 401;
  override readonly isOperational = false;
  constructor(detail?: Record<string, unknown>) {
    super('Authentication failed', detail !== undefined ? { detail } : undefined);
  }
}

export class LastFactorProtectedError extends AppError {
  readonly code: ErrorCode = 'LAST_FACTOR_PROTECTED';
  readonly httpStatus = 409;
  constructor() {
    super('This is your last authentication method and cannot be removed');
  }
}

export class ChallengeInvalidError extends AppError {
  readonly code: ErrorCode = 'CHALLENGE_INVALID';
  readonly httpStatus = 400;
  constructor(clientMessage = 'This request has expired. Please try again.') {
    super(clientMessage);
  }
}

export class NotFoundError extends AppError {
  readonly code: ErrorCode = 'NOT_FOUND';
  readonly httpStatus = 404;
  constructor(clientMessage = 'Not found') {
    super(clientMessage);
  }
}

export class ConflictError extends AppError {
  readonly code: ErrorCode = 'CONFLICT';
  readonly httpStatus = 409;
}

export class RateLimitError extends AppError {
  readonly code: ErrorCode = 'RATE_LIMITED';
  readonly httpStatus = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Too many requests. Please wait and try again.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class DependencyUnavailableError extends AppError {
  readonly code: ErrorCode = 'DEPENDENCY_UNAVAILABLE';
  readonly httpStatus = 503;
  override readonly isOperational = false;
  constructor(dependency: string, cause?: unknown) {
    super('A required service is unavailable', {
      detail: { dependency },
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

export class InternalError extends AppError {
  readonly code: ErrorCode = 'INTERNAL_ERROR';
  readonly httpStatus = 500;
  override readonly isOperational = false;
  constructor(cause?: unknown, detail?: Record<string, unknown>) {
    super('An unexpected error occurred', {
      ...(detail !== undefined ? { detail } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Reserved for later phases (prompt_phase1.md rules 81-82).
//
// Declared now so their codes are fixed in the public contract and clients can
// be written against a stable union. No Phase 1 code path constructs these;
// the domain logic behind them belongs to Phase 2 (ledger) and Phase 3 (risk).
// ---------------------------------------------------------------------------

/** Phase 2 — ledger. */
export class InsufficientFundsError extends AppError {
  readonly code: ErrorCode = 'INSUFFICIENT_FUNDS';
  readonly httpStatus = 409;
  constructor(clientMessage = 'Insufficient available balance') {
    super(clientMessage);
  }
}

/** Phase 3 — risk and policy engine. */
export class PolicyDeniedError extends AppError {
  readonly code: ErrorCode = 'POLICY_DENIED';
  readonly httpStatus = 403;
  readonly reasonCodes: readonly string[];
  constructor(reasonCodes: readonly string[], clientMessage = 'This request was declined') {
    super(clientMessage);
    this.reasonCodes = reasonCodes;
  }
}

/** Phase 2+ — blockchain adapters. */
export class ChainError extends AppError {
  readonly code: ErrorCode = 'CHAIN_ERROR';
  readonly httpStatus = 502;
  override readonly isOperational = false;
  constructor(clientMessage = 'Blockchain operation failed', cause?: unknown) {
    super(clientMessage, cause !== undefined ? { cause } : undefined);
  }
}
