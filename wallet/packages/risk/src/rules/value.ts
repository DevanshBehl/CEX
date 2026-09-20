import type { Rule } from '../types.js';
import { usdReviewEnabled } from './limits.js';

/**
 * Above a USD value, a human decides; below it, code does (ADR-0024).
 *
 * The hard checks — an active account, a valid external destination, the
 * per-transaction and rolling daily limits, velocity — still run on every
 * withdrawal and still deny. The balance check is the ledger lock itself.
 * This rule only decides whether a withdrawal that passes all of them needs a
 * person as well, and it answers by what the withdrawal is worth.
 *
 * STRICTLY GREATER THAN. A threshold of $1,000 means $1,000.00 exactly is
 * approved automatically and $1,000.01 is reviewed.
 *
 * UNPRICED IS REVIEWED. If the price feed is down or the asset has no recent
 * tick, the value is unknown, and an unknown value cannot be shown to be under
 * the threshold. Failing open here would let an outage turn every withdrawal
 * into an automatic one — exactly when nobody is watching prices.
 */
export const usdReviewThresholdRule: Rule = (input, policy) => {
  if (!usdReviewEnabled(policy)) {
    return { rule: 'usd_review_threshold', verdict: 'approve', codes: [] };
  }
  const threshold = policy.manualReviewAboveUsdMicros as bigint;

  if (input.valueUsdMicros === undefined || input.valueUsdMicros === null) {
    return {
      rule: 'usd_review_threshold',
      verdict: 'review',
      codes: ['VALUE_UNPRICED'],
      detail: { asset: input.asset, amount: input.amount.toString() },
    };
  }

  if (input.valueUsdMicros > threshold) {
    return {
      rule: 'usd_review_threshold',
      verdict: 'review',
      codes: ['USD_REVIEW_THRESHOLD'],
      detail: {
        asset: input.asset,
        valueUsdMicros: input.valueUsdMicros.toString(),
        thresholdUsdMicros: threshold.toString(),
      },
    };
  }

  return {
    rule: 'usd_review_threshold',
    verdict: 'approve',
    codes: [],
    detail: { valueUsdMicros: input.valueUsdMicros.toString() },
  };
};
