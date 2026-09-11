/**
 * Custody tiers, defined by what it takes to move money out of them
 * (ADR-0018, prompt_phase4.md rules 134-139).
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID
 *
 * Rule 137: tiers that all sign the same way are labels, not segregation. An
 * enum that three code paths ignore gives an auditor, an operator and a reader
 * of the schema the appearance of custody separation while providing none —
 * which is worse than having no tiers at all, because it is load-bearing in
 * everyone's mental model and nowhere else.
 *
 * So a tier is not a name. A tier is a POLICY: which authorities must have
 * signed the authorization proof before key material will produce a signature.
 *
 * WHERE THIS IS ENFORCED
 *
 * The policy is declared here, in chain-agnostic terms, so the domain can
 * reason about it. It is ENFORCED inside the signing boundary, by participants
 * that verify the proof against a key they hold independently of the
 * coordinator (ADR-0015). A tier check that lived only in the API would be a
 * check a compromised API could skip, and the API is exactly the component the
 * threshold scheme assumes may be compromised.
 */

/** Ordered from most to least exposed. */
export const CUSTODY_TIERS = ['deposit', 'hot', 'warm', 'cold'] as const;

export type CustodyTier = (typeof CUSTODY_TIERS)[number];

/**
 * Who must have signed an authorization for a tier to move.
 *
 * `risk-engine` is the automated policy engine. `operator` is a human with an
 * authenticated identity. `ceremony` is an out-of-band procedure with more than
 * one human, recorded in a runbook.
 */
export type Authority = 'risk-engine' | 'operator' | 'ceremony';

export interface TierPolicy {
  readonly tier: CustodyTier;
  /** Every authority in this list must appear in the proof. */
  readonly requiredAuthorities: readonly Authority[];
  /** Signing participants required, where the tier uses threshold signing. */
  readonly signingThreshold: number;
  /**
   * True when the tier's key may only ever pay one hardcoded destination
   * (ADR-0005, ADR-0017). The deposit class is the reason that ADR was
   * acceptable, and honouring it here is what makes it true rather than a
   * story we told ourselves.
   */
  readonly fixedDestinationOnly: boolean;
  readonly online: boolean;
}

/**
 * The asymmetry is deliberate: moving money INTO colder storage is automatic,
 * moving it OUT is the privileged operation. Getting the conservative direction
 * wrong costs an unnecessary transfer; getting the other one wrong costs the
 * treasury.
 */
export const TIER_POLICIES: Readonly<Record<CustodyTier, TierPolicy>> = {
  deposit: {
    tier: 'deposit',
    // No authority list: a deposit key cannot choose a destination, so there is
    // nothing for an authorization to authorise beyond "sweep now".
    requiredAuthorities: [],
    signingThreshold: 1,
    fixedDestinationOnly: true,
    online: true,
  },
  hot: {
    tier: 'hot',
    requiredAuthorities: ['risk-engine'],
    signingThreshold: 3,
    fixedDestinationOnly: false,
    online: true,
  },
  warm: {
    tier: 'warm',
    requiredAuthorities: ['risk-engine', 'operator'],
    signingThreshold: 3,
    fixedDestinationOnly: false,
    online: true,
  },
  cold: {
    tier: 'cold',
    // Two humans, out of band. No automated authority can satisfy this.
    requiredAuthorities: ['ceremony'],
    signingThreshold: 4,
    fixedDestinationOnly: false,
    online: false,
  },
};

/**
 * Parse the authorities a proof's `approvedBy` claims.
 *
 * The format is `authority[:identity]`, joined by `+`:
 *
 *   risk-engine
 *   risk-engine+operator:alice
 *   ceremony:2026-09-11
 *
 * An unrecognised authority is DROPPED rather than accepted, so a proof
 * claiming `superuser` satisfies nothing. Failing open here would make the
 * whole policy decorative.
 */
export function parseAuthorities(approvedBy: string): readonly Authority[] {
  const known = new Set<string>(['risk-engine', 'operator', 'ceremony']);
  return approvedBy
    .split('+')
    .map((part) => part.split(':')[0]?.trim() ?? '')
    .filter((name): name is Authority => known.has(name));
}

export type TierCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly Authority[] };

/**
 * Does this proof carry everything the tier requires?
 *
 * Deliberately NOT a risk evaluation. It checks the ATTESTATION, not the
 * policy — re-running risk rules here would put policy in two places and
 * violate master-prompt rule 109, which keeps authorising and signing separate.
 */
/**
 * Does `held` satisfy a requirement for `required`?
 *
 * THE ASYMMETRY THAT MATTERS
 *
 * A human operator satisfies a requirement for the risk engine: a named person
 * deliberately approving a movement is strictly more authority than automation
 * applying a policy, and a `ceremony` is more than either. The reverse is never
 * true — automation must never satisfy a requirement for a human, because that
 * is precisely the substitution a compromised coordinator would like to make.
 *
 * Without this, an operator acting directly on the hot tier is refused for
 * carrying too much authority rather than too little, which is nonsense — and
 * the first thing anyone hitting it would reach for is a proof falsely claiming
 * `risk-engine`, defeating the point of naming the authority at all.
 */
function satisfies(held: Authority, required: Authority): boolean {
  if (held === required) return true;
  if (required === 'risk-engine') return held === 'operator' || held === 'ceremony';
  // An `operator` requirement is NOT satisfied by a ceremony: they are
  // different procedures, and a ceremony proof names no individual.
  return false;
}

/**
 * Every required authority must be met by a DISTINCT authority in the proof.
 *
 * This is the correction that matters, and it was nearly missed. Warm requires
 * `[risk-engine, operator]` — meaning **two independent approvals**, not "an
 * authority level of at least operator". With a naive check, a lone `operator`
 * satisfies the operator requirement AND, through the hierarchy above, the
 * risk-engine one — silently reducing warm from two approvals to one, which is
 * the entire protection warm exists to provide.
 *
 * Requirements are matched most-constrained first (an `operator` requirement
 * has one possible satisfier, a `risk-engine` requirement has three), which is
 * exact for this nested structure and needs no backtracking.
 */
function countSatisfiers(required: Authority): number {
  return (['risk-engine', 'operator', 'ceremony'] as const).filter((held) =>
    satisfies(held, required),
  ).length;
}

export function checkTierAuthorization(tier: CustodyTier, approvedBy: string): TierCheck {
  const policy = TIER_POLICIES[tier];
  const available = parseAuthorities(approvedBy).slice();

  const ordered = [...policy.requiredAuthorities].sort(
    (a, b) => countSatisfiers(a) - countSatisfiers(b),
  );

  const missing: Authority[] = [];
  for (const required of ordered) {
    const index = available.findIndex((held) => satisfies(held, required));
    if (index === -1) missing.push(required);
    // Consumed, so one approval cannot count twice.
    else available.splice(index, 1);
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * Which tier should fund a withdrawal of this size.
 *
 * Ordinary withdrawals come from hot. One that hot cannot cover is an
 * OPERATIONAL EVENT, not an error: it means the float needs topping up, and
 * that is a decision with a human in it (rule 135).
 */
export function tierForWithdrawal(input: {
  readonly amount: bigint;
  readonly hotBalance: bigint;
}): CustodyTier | 'insufficient_hot' {
  return input.amount <= input.hotBalance ? 'hot' : 'insufficient_hot';
}

export interface RebalancePlan {
  readonly action: 'none' | 'to_warm' | 'from_warm';
  readonly amount: bigint;
}

/**
 * Threshold-based rebalancing (rule 135).
 *
 * Above the ceiling, the excess goes to warm — automatic, because it moves
 * value to safety. Below the floor, a top-up is REQUESTED rather than
 * performed, because it moves value out of warm and that requires an operator
 * proof (ADR-0018).
 */
export function planRebalance(input: {
  readonly hotBalance: bigint;
  readonly ceiling: bigint;
  readonly floor: bigint;
  readonly target: bigint;
}): RebalancePlan {
  if (input.ceiling < input.floor) {
    throw new Error('hot ceiling must not be below the floor');
  }
  if (input.hotBalance > input.ceiling) {
    return { action: 'to_warm', amount: input.hotBalance - input.target };
  }
  if (input.hotBalance < input.floor) {
    return { action: 'from_warm', amount: input.target - input.hotBalance };
  }
  return { action: 'none', amount: 0n };
}
