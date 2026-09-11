import type { Rule, RiskInput, RiskPolicy } from '../types.js';

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
  if (input.amount > policy.perTransactionLimit) {
    return {
      rule: 'per_transaction_limit',
      verdict: 'deny',
      codes: ['PER_TRANSACTION_LIMIT'],
      // Operator-visible only. The client is told a generic message.
      detail: {
        amount: input.amount.toString(),
        limit: policy.perTransactionLimit.toString(),
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
  const cutoff = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
  const trailing = sumSince(input, cutoff);
  const projected = trailing + input.amount;

  if (projected > policy.dailyLimit) {
    return {
      rule: 'daily_limit',
      verdict: 'deny',
      codes: ['DAILY_LIMIT'],
      detail: {
        trailing: trailing.toString(),
        projected: projected.toString(),
        limit: policy.dailyLimit.toString(),
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
  if (input.amount >= policy.manualReviewAbove) {
    return {
      rule: 'manual_review_threshold',
      verdict: 'review',
      codes: ['MANUAL_REVIEW_THRESHOLD'],
      detail: {
        amount: input.amount.toString(),
        threshold: policy.manualReviewAbove.toString(),
      },
    };
  }
  return { rule: 'manual_review_threshold', verdict: 'approve', codes: [] };
};

function sumSince(input: RiskInput, cutoff: Date): bigint {
  return input.recentWithdrawals
    .filter((w) => w.createdAt >= cutoff && w.asset === input.asset)
    .reduce<bigint>((total, w) => total + w.amount, 0n);
}

export type { RiskPolicy };
