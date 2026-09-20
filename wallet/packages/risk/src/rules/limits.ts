import type { AssetLimits, Rule, RiskInput, RiskPolicy } from '../types.js';

/**
 * The limits for the asset being withdrawn (prompt_phase4.md rule 127).
 *
 * Returns undefined when the asset has none configured. Every value rule then
 * declines rather than reaching for another asset's numbers — see
 * `assetLimitsConfiguredRule` for why that is a denial and not a default.
 */
function limitsFor(input: RiskInput, policy: RiskPolicy): AssetLimits | undefined {
  return policy.assetLimits[input.asset];
}

/**
 * An allowlisted asset with no configured limits is not withdrawable.
 *
 * The alternative — falling back to the native asset's numbers — silently
 * applies a limit denominated in 10^9 units to an asset denominated in 10^6,
 * which is a limit a thousand times too generous. A configuration gap should
 * cost a support ticket, not a treasury.
 */
export const assetLimitsConfiguredRule: Rule = (input, policy) => {
  if (limitsFor(input, policy) === undefined) {
    return {
      rule: 'asset_limits_configured',
      verdict: 'deny',
      codes: ['ASSET_LIMITS_NOT_CONFIGURED'],
      detail: { asset: input.asset },
    };
  }
  return { rule: 'asset_limits_configured', verdict: 'approve', codes: [] };
};

/** Input sanity, before any limit is meaningful. */
export const amountRule: Rule = (input, policy) => {
  const codes: Array<'AMOUNT_NOT_POSITIVE' | 'ASSET_NOT_SUPPORTED'> = [];

  if (input.amount <= 0n) codes.push('AMOUNT_NOT_POSITIVE');
  if (!policy.supportedAssets.includes(input.asset)) codes.push('ASSET_NOT_SUPPORTED');

  return codes.length > 0
    ? { rule: 'amount', verdict: 'deny', codes }
    : { rule: 'amount', verdict: 'approve', codes: [] };
};

/** A cap on any single withdrawal (master-prompt rule 146). */
export const perTransactionLimitRule: Rule = (input, policy) => {
  const limits = limitsFor(input, policy);
  // Unconfigured is already denied by `assetLimitsConfiguredRule`; this rule
  // abstains rather than reporting a second, more confusing reason.
  if (limits === undefined) {
    return { rule: 'per_transaction_limit', verdict: 'approve', codes: [] };
  }

  if (input.amount > limits.perTransactionLimit) {
    return {
      rule: 'per_transaction_limit',
      verdict: 'deny',
      codes: ['PER_TRANSACTION_LIMIT'],
      // Operator-visible only. The client is told a generic message.
      detail: {
        asset: input.asset,
        amount: input.amount.toString(),
        limit: limits.perTransactionLimit.toString(),
      },
    };
  }
  return { rule: 'per_transaction_limit', verdict: 'approve', codes: [] };
};

/**
 * A cap on the ROLLING trailing total (master-prompt rule 147).
 *
 * Rolling, not calendar (ADR-0010, prompt_phase3.md rule 85). A calendar reset
 * lets an attacker take a full limit at 23:59 and another at 00:01 — two limits
 * ninety seconds apart, for no reason but an arbitrary boundary.
 */
export const dailyLimitRule: Rule = (input, policy) => {
  const limits = limitsFor(input, policy);
  if (limits === undefined) {
    return { rule: 'daily_limit', verdict: 'approve', codes: [] };
  }

  const cutoff = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
  const trailing = sumSince(input, cutoff);
  const projected = trailing + input.amount;

  if (projected > limits.dailyLimit) {
    return {
      rule: 'daily_limit',
      verdict: 'deny',
      codes: ['DAILY_LIMIT'],
      detail: {
        asset: input.asset,
        trailing: trailing.toString(),
        projected: projected.toString(),
        limit: limits.dailyLimit.toString(),
      },
    };
  }
  return { rule: 'daily_limit', verdict: 'approve', codes: [] };
};

/**
 * A cap on COUNT over a short window, independent of value
 * (master-prompt rule 148).
 *
 * Value limits do not catch a script draining an account in many small
 * withdrawals; this does.
 */
export const velocityRule: Rule = (input, policy) => {
  const cutoff = new Date(input.now.getTime() - policy.velocityWindowMinutes * 60 * 1000);
  const count = input.recentWithdrawals.filter((w) => w.createdAt >= cutoff).length;

  if (count >= policy.velocityMaxCount) {
    return {
      rule: 'velocity',
      verdict: 'deny',
      codes: ['VELOCITY_LIMIT'],
      detail: {
        count: String(count),
        max: String(policy.velocityMaxCount),
        windowMinutes: String(policy.velocityWindowMinutes),
      },
    };
  }
  return { rule: 'velocity', verdict: 'approve', codes: [] };
};

/**
 * Above a configured value, a human decides (master-prompt rule 151).
 *
 * `review`, not `deny`: the withdrawal may well be legitimate, and denying the
 * withdrawals that matter most to a user teaches them to split into smaller
 * ones, which defeats the limit entirely.
 */
export const manualReviewThresholdRule: Rule = (input, policy) => {
  const limits = limitsFor(input, policy);
  // A USD threshold supersedes the base-unit one (ADR-0024). Abstaining here
  // rather than removing the rule keeps old decisions replayable.
  if (limits === undefined || usdReviewEnabled(policy)) {
    return { rule: 'manual_review_threshold', verdict: 'approve', codes: [] };
  }

  if (input.amount >= limits.manualReviewAbove) {
    return {
      rule: 'manual_review_threshold',
      verdict: 'review',
      codes: ['MANUAL_REVIEW_THRESHOLD'],
      detail: {
        asset: input.asset,
        amount: input.amount.toString(),
        threshold: limits.manualReviewAbove.toString(),
      },
    };
  }
  return { rule: 'manual_review_threshold', verdict: 'approve', codes: [] };
};

/** Whether review is decided by USD value rather than per-asset base units. */
export function usdReviewEnabled(policy: RiskPolicy): boolean {
  return (
    policy.manualReviewAboveUsdMicros !== undefined && policy.manualReviewAboveUsdMicros !== null
  );
}

function sumSince(input: RiskInput, cutoff: Date): bigint {
  return input.recentWithdrawals
    .filter((w) => w.createdAt >= cutoff && w.asset === input.asset)
    .reduce<bigint>((total, w) => total + w.amount, 0n);
}

export type { RiskPolicy };
