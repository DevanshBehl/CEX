/**
 * Reason codes (master-prompt rule 152, prompt_phase3.md rules 76-78).
 *
 * A list, never a string. A decision that says "denied: DAILY_LIMIT,
 * NEW_DESTINATION" tells an operator exactly what to look at; one that says
 * "denied: risk score 0.72" tells them nothing and cannot be argued with.
 *
 * These are part of the public contract. APPEND-ONLY: never remove a code and
 * never repurpose one, because persisted decisions from years ago still carry
 * them and must still mean what they meant then.
 */
export const REASON_CODES = [
  // --- account ---
  'ACCOUNT_NOT_ACTIVE',

  // --- destination ---
  'DESTINATION_INVALID',
  /** Well-formed but not spendable — a PDA has no private key. */
  'DESTINATION_NOT_SIGNABLE',
  /** An address this platform controls. Withdrawing to ourselves is a bug or an attack. */
  'DESTINATION_INTERNAL',
  'NEW_DESTINATION',

  // --- limits ---
  'PER_TRANSACTION_LIMIT',
  'DAILY_LIMIT',
  'VELOCITY_LIMIT',
  'MANUAL_REVIEW_THRESHOLD',
  /**
   * The asset is allowlisted for deposit but has no configured withdrawal
   * limits. Denied rather than defaulted (prompt_phase4.md rule 127).
   */
  'ASSET_LIMITS_NOT_CONFIGURED',

  /** Worth more than the configured USD review threshold (ADR-0024). */
  'USD_REVIEW_THRESHOLD',
  /**
   * No recent price for the asset, so its value is unknown. Reviewed, never
   * auto-approved: a withdrawal that cannot be shown to be small is not
   * treated as small.
   */
  'VALUE_UNPRICED',

  // --- input ---
  'AMOUNT_NOT_POSITIVE',
  'ASSET_NOT_SUPPORTED',

  // --- clean passes, recorded so an approval says what was checked ---
  'WITHIN_ALL_LIMITS',
  'KNOWN_DESTINATION',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Codes that describe a passing check rather than a problem.
 *
 * Kept separate so "did anything go wrong" is a set membership test rather than
 * a growing list of exceptions at each call site.
 */
export const INFORMATIONAL_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'WITHIN_ALL_LIMITS',
  'KNOWN_DESTINATION',
]);

/**
 * What the USER is told. Deliberately coarse.
 *
 * The client learns that a denial happened and roughly why. It never learns
 * which limit was hit or by how much (prompt_phase3.md rules 81-82, ADR-0010) —
 * that turns the endpoint into an oracle for probing thresholds, where an
 * attacker binary-searches the daily limit with a series of rejected requests.
 *
 * The full codes go to the persisted decision and to the operator.
 */
export function toClientMessage(codes: readonly ReasonCode[]): string {
  if (codes.includes('ACCOUNT_NOT_ACTIVE')) {
    return 'This account cannot make withdrawals. Please contact support.';
  }
  if (
    codes.includes('DESTINATION_INVALID') ||
    codes.includes('DESTINATION_NOT_SIGNABLE') ||
    codes.includes('DESTINATION_INTERNAL')
  ) {
    return 'That destination address cannot be used.';
  }
  if (codes.includes('AMOUNT_NOT_POSITIVE')) {
    return 'Enter an amount greater than zero.';
  }
  if (codes.includes('ASSET_NOT_SUPPORTED') || codes.includes('ASSET_LIMITS_NOT_CONFIGURED')) {
    return 'That asset is not supported.';
  }
  // Every limit collapses into one message on purpose.
  if (
    codes.includes('PER_TRANSACTION_LIMIT') ||
    codes.includes('DAILY_LIMIT') ||
    codes.includes('VELOCITY_LIMIT')
  ) {
    return 'This withdrawal exceeds your current limits. Try a smaller amount or try again later.';
  }
  return 'This withdrawal was declined.';
}
