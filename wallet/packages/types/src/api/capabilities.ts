import { z } from 'zod';

/**
 * What this deployment can actually do (prompt_phase4.md rules 236-237).
 *
 * WHY THIS ENDPOINT EXISTS
 *
 * The dashboard used to say "signing is a mock" in hardcoded copy. That was
 * true in Phase 3 and became false the moment `SIGNER_KIND=real` shipped —
 * and a hardcoded claim about custody that has quietly gone stale is worse
 * than no claim, because people rely on it.
 *
 * So the interface asks. Replacing one hardcoded string with a different
 * hardcoded string would just move the expiry date.
 *
 * DELIBERATELY COARSE. This is unauthenticated and describes the platform's
 * security posture, so it says what KIND of signing is in use and never an
 * endpoint, a key reference, a participant count, or a version.
 */
export const signingModeSchema = z.enum([
  /** A clearly-labelled mock. Signatures verify against nothing. */
  'mock',
  /** A single key, held in a separate process behind an authenticated channel. */
  'single-key-mpc',
  /** t-of-n threshold signing. Not implemented; here so the contract is stable. */
  'threshold-mpc',
]);
export type SigningMode = z.infer<typeof signingModeSchema>;

export const capabilitiesResponseSchema = z.object({
  signing: z.object({
    mode: signingModeSchema,
    /**
     * True only when no single compromised host can produce a signature.
     *
     * `single-key-mpc` is false: it delivers a process boundary and
     * authorization verification, and none of the key-compromise resistance
     * that threshold signing exists for (ADR-0015).
     */
    thresholdProtected: z.boolean(),
  }),
  assets: z.object({
    /** Ledger asset keys the platform will credit. */
    supported: z.array(z.string()),
    /** Symbol per key, for display. Decimals are deliberately absent. */
    labels: z.record(z.string()),
  }),
  /**
   * Always true. Present as a field rather than as copy so it cannot be
   * removed by editing a template (master-prompt rule 8).
   */
  auditedForProduction: z.literal(false),
});
export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;
