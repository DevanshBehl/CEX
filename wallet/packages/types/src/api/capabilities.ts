import { z } from 'zod';
import { clusterSchema } from '../clusters.js';

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
  /**
   * Which Solana clusters this deployment serves (ADR-0021).
   *
   * Unauthenticated, like the rest of this endpoint: the network switcher has
   * to be populated before anyone signs in, and a person deciding whether to
   * trust a custodian should be able to see that it is a devnet-only
   * deployment without depositing first.
   */
  clusters: z.object({
    served: z.array(clusterSchema),
    /** What a request naming no cluster is answered for. */
    default: clusterSchema,
  }),
  /**
   * What the exchange side of this deployment does — coarse, like the rest of
   * this endpoint, and for the same reason: the interface must ASK rather than
   * carry copy that goes stale (prompt_phase_s5.md rule 135).
   */
  trading: z.object({
    enabled: z.boolean(),
    /**
     * False means fills match and move no balance. The trading screen says so.
     */
    settlement: z.boolean(),
    /** False means no book, tape, chart or socket. */
    marketData: z.boolean(),
    /**
     * True when the book includes quotes from the demo market maker
     * (ADR-0038): a program quoting around a price it was given — by default,
     * one it made up. Shown wherever that liquidity is.
     */
    syntheticLiquidity: z.boolean(),
  }),
  assets: z.object({
    /** Ledger asset keys the platform will credit, cluster-qualified. */
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
