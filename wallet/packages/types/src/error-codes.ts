/**
 * Stable, machine-readable error codes (prompt_phase1.md rules 54, 83, 185).
 *
 * These are part of the public API contract. A client may switch on them.
 * Codes are append-only: never repurpose or remove one once shipped.
 */
export const ERROR_CODES = [
  // Client input
  'VALIDATION_FAILED',
  'MALFORMED_REQUEST',

  // Identity
  'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_FAILED',
  'AUTHORIZATION_DENIED',
  'STEP_UP_REQUIRED',
  'SESSION_EXPIRED',
  'CREDENTIAL_CLONE_SUSPECTED',
  'LAST_FACTOR_PROTECTED',
  'CHALLENGE_INVALID',

  // Resources
  'NOT_FOUND',
  'CONFLICT',

  // Abuse
  'RATE_LIMITED',

  // Infrastructure
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',

  // Reserved for later phases (prompt_phase1.md rules 81-82).
  // Declared now so the union is stable and clients can be written against it;
  // no Phase 1 code path emits these.
  'INSUFFICIENT_FUNDS',
  'POLICY_DENIED',
  'CHAIN_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
