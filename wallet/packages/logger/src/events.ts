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
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

export type Outcome = 'success' | 'failure';

export interface SecurityEventFields {
  readonly outcome: Outcome;
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
