import type { Logger } from './logger.js';

/**
 * Typed security events (prompt_phase1.md rule 75).
 *
 * Free-form message strings are unsearchable and drift. A closed union means a
 * dashboard or an alert can be written against a stable name, and `audit_log`
 * rows and log lines carry the same vocabulary.
 */
export const SECURITY_EVENTS = [
  'user.created',
  'user.updated',
  'auth.registration.started',
  'auth.registration.completed',
  'auth.registration.failed',
  'auth.login.started',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.logout',
  'auth.stepup.succeeded',
  'auth.stepup.failed',
  'auth.challenge.replayed',
  'credential.registered',
  'credential.revoked',
  'credential.clone_suspected',
  'session.created',
  'session.rotated',
  'session.revoked',
  'session.revoked_all',
  'session.expired',
  'totp.enrolled',
  'totp.disabled',
  'totp.verification_failed',
  'ratelimit.exceeded',

  // --- Phase 2: custody and deposits ---
  // Identifiers and outcomes only. Amounts, addresses, and transaction
  // signatures are NOT loggable (prompt_phase2.md rules 41, 223) — adding one
  // means editing the allowlist in ./allowlist.ts on purpose.
  'address.assigned',
  'deposit.detected',
  'deposit.credited',
  'deposit.ignored',
  'indexer.poll_failed',
  'indexer.cursor_advanced',
  'reconciliation.completed',
  'reconciliation.drift_detected',

  // --- Phase 3: withdrawals ---
  // Identifiers, verdicts, and reason codes only. Amounts, destinations, and
  // transaction signatures are NOT loggable (prompt_phase3.md rules 64, 226).
  'withdrawal.requested',
  'withdrawal.risk_approve',
  'withdrawal.risk_deny',
  'withdrawal.risk_review',
  'withdrawal.funds_locked',
  'withdrawal.funds_released',
  'withdrawal.operator_approved',
  'withdrawal.operator_rejected',
  'withdrawal.signing_started',
  'withdrawal.signed',
  'withdrawal.sign_failed',
  'withdrawal.broadcast',
  'withdrawal.broadcast_failed',
  'withdrawal.rebroadcast',
  'withdrawal.expired',
  'withdrawal.confirmed',
  'withdrawal.settled',
  'withdrawal.failed',
  'nonce.leased',
  'nonce.released',
  'nonce.pool_exhausted',

  // --- Phase 4: jobs and sweeps ---
  // `deposit.ignored` and the reconciliation events already exist above.
  /** A job exhausted its retry budget and was parked (rule 153). */
  'job.dead_lettered',
  'job.retried',
  'job.retry_failed',
  'nonce.provisioned',
  'sweep.started',
  'sweep.completed',
  'sweep.failed',
  /** Drift that has persisted across cycles, not a single reading (rule 144). */
  'indexer.network_verified',
  'operator.role_granted',
  'operator.role_revoked',
  'reconciliation.drift_persisted',
  /** A single user's segregated position does not match their address. */
  'reconciliation.user_diverged',
  /** A negative residual with no withdrawals in flight (rule 148). */
  'reconciliation.negative_residual',
  /** Spot prices were appended. The COUNT only — never a price (rule 90). */
  'pricer.recorded',
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

export type Outcome = 'success' | 'failure';

export interface SecurityEventFields {
  readonly outcome: Outcome;
  /** A count of things acted on. Never an amount of money. */
  readonly count?: number;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly credentialId?: string;
  readonly credentialType?: string;
  readonly reason?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly targetType?: string;
  readonly targetId?: string;
}

export function logSecurityEvent(
  logger: Logger,
  event: SecurityEvent,
  fields: SecurityEventFields,
): void {
  const level = fields.outcome === 'failure' ? 'warn' : 'info';
  logger[level](event, { event, ...fields });
}
