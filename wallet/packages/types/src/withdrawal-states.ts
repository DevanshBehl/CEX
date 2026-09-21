/**
 * The withdrawal state machine (prompt_phase3.md §8).
 *
 * Declared ONCE, here, and enforced twice: by the type system for code that
 * goes through the domain, and by a database check constraint for everything
 * else (rules 97-99). Belt and braces on purpose — the type system stops the
 * honest mistakes, the constraint stops raw SQL, a migration, and a psql
 * session.
 *
 * It lives in `packages/types` because the API contract, the domain, the
 * database migration, and the UI all need the same answer to "what can happen
 * next", and three copies of that answer will diverge.
 */

export const WITHDRAWAL_STATUSES = [
  'REQUESTED',
  'RISK_EVALUATING',
  'MANUAL_REVIEW',
  'APPROVED',
  'FUNDS_LOCKED',
  'SIGNING',
  'SIGNED',
  'BROADCAST',
  'CONFIRMED',
  'SETTLED',
  'SIGN_FAILED',
  'BROADCAST_FAILED',
  'EXPIRED',
  'REJECTED',
  'FAILED',
] as const;

export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/**
 * The legal transitions, as data.
 *
 * Every failure edge is a STATE, not an exception that unwinds (rule 106). A
 * withdrawal that fails must be somewhere, with a reason, or it is money in an
 * unknown condition.
 */
export const WITHDRAWAL_TRANSITIONS: Readonly<
  Record<WithdrawalStatus, readonly WithdrawalStatus[]>
> = {
  REQUESTED: ['RISK_EVALUATING'],
  RISK_EVALUATING: ['APPROVED', 'MANUAL_REVIEW', 'REJECTED'],
  MANUAL_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['FUNDS_LOCKED', 'REJECTED'],
  // The signing queue is entered from FUNDS_LOCKED and nowhere else.
  FUNDS_LOCKED: ['SIGNING', 'REJECTED', 'FAILED'],
  SIGNING: ['SIGNED', 'SIGN_FAILED'],
  SIGNED: ['BROADCAST'],
  BROADCAST: ['CONFIRMED', 'BROADCAST_FAILED', 'EXPIRED'],
  CONFIRMED: ['SETTLED'],

  // Retry edges. Each returns to FUNDS_LOCKED, because the funds never
  // stopped being reserved — only the attempt failed.
  SIGN_FAILED: ['FUNDS_LOCKED', 'FAILED'],
  BROADCAST_FAILED: ['FUNDS_LOCKED', 'FAILED'],
  EXPIRED: ['FUNDS_LOCKED', 'FAILED'],

  // Terminal.
  SETTLED: [],
  REJECTED: [],
  FAILED: [],
};

/** States from which nothing further can happen. */
export const TERMINAL_WITHDRAWAL_STATUSES: ReadonlySet<WithdrawalStatus> =
  new Set<WithdrawalStatus>(['SETTLED', 'REJECTED', 'FAILED']);

/**
 * States in which funds are reserved in `user_custody_locked`.
 *
 * Used to assert that the ledger and the state machine agree: a withdrawal in
 * one of these states must have a lock, and one outside them must not
 * (prompt_phase3.md rule 112).
 */
export const LOCKED_WITHDRAWAL_STATUSES: ReadonlySet<WithdrawalStatus> = new Set<WithdrawalStatus>([
  'FUNDS_LOCKED',
  'SIGNING',
  'SIGNED',
  'BROADCAST',
  'CONFIRMED',
  'SIGN_FAILED',
  'BROADCAST_FAILED',
  'EXPIRED',
]);

/** States a withdrawal can be in while bytes exist that may still land. */
export const IN_FLIGHT_WITHDRAWAL_STATUSES: ReadonlySet<WithdrawalStatus> =
  new Set<WithdrawalStatus>(['BROADCAST', 'BROADCAST_FAILED', 'EXPIRED']);

export function canTransition(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return WITHDRAWAL_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: WithdrawalStatus): boolean {
  return TERMINAL_WITHDRAWAL_STATUSES.has(status);
}

export function holdsLock(status: WithdrawalStatus): boolean {
  return LOCKED_WITHDRAWAL_STATUSES.has(status);
}

/**
 * Every legal transition as a flat list.
 *
 * Used to generate the database CHECK constraint, so the constraint and this
 * table cannot drift: there is one source and the migration is derived from it.
 */
export function allTransitions(): Array<{ from: WithdrawalStatus; to: WithdrawalStatus }> {
  return WITHDRAWAL_STATUSES.flatMap((from) =>
    WITHDRAWAL_TRANSITIONS[from].map((to) => ({ from, to })),
  );
}
