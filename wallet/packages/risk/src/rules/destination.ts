import type { ReasonCode } from '../reason-codes.js';
import type { Rule } from '../types.js';

/**
 * Destination controls (master-prompt rule 149, prompt_phase3.md rules 87-88).
 *
 * The engine is chain-free, so it does not decode an address — it receives the
 * adapter's verdict in `destinationCheck` and decides what that means for
 * policy. Keeping the two apart is what lets a second chain reuse this engine
 * unchanged (master-prompt rule 196).
 */
export const destinationRule: Rule = (input, policy) => {
  const check = input.destinationCheck;

  if (!check.ok) {
    const code: ReasonCode =
      check.reason === 'not_signable' ? 'DESTINATION_NOT_SIGNABLE' : 'DESTINATION_INVALID';
    return { rule: 'destination', verdict: 'deny', codes: [code] };
  }

  if (check.isPlatformOwned) {
    // Withdrawing to an address this platform controls is either a bug or an
    // attempt to move funds between accounts while bypassing the ledger.
    return { rule: 'destination', verdict: 'deny', codes: ['DESTINATION_INTERNAL'] };
  }

  const cutoff = new Date(
    input.now.getTime() - policy.knownDestinationWindowDays * 24 * 60 * 60 * 1000,
  );
  const known = input.priorDestinations.some(
    (prior) => prior.address === input.destination && prior.lastUsedAt >= cutoff,
  );

  if (known) {
    return { rule: 'destination', verdict: 'approve', codes: ['KNOWN_DESTINATION'] };
  }

  /**
   * A first-time destination is REVIEWED, not denied (ADR-0010).
   *
   * It is the shape of an account takeover — and also the shape of every
   * legitimate first withdrawal. Denying it would deny everyone their first
   * withdrawal, so a human decides.
   */
  if (policy.reviewNewDestinations) {
    return { rule: 'destination', verdict: 'review', codes: ['NEW_DESTINATION'] };
  }

  return { rule: 'destination', verdict: 'approve', codes: [] };
};
