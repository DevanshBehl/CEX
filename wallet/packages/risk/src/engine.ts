import { INFORMATIONAL_CODES, type ReasonCode } from './reason-codes.js';
import { accountStateRule } from './rules/account.js';
import { destinationRule } from './rules/destination.js';
import {
  amountRule,
  assetLimitsConfiguredRule,
  dailyLimitRule,
  manualReviewThresholdRule,
  perTransactionLimitRule,
  velocityRule,
} from './rules/limits.js';
import { usdReviewThresholdRule } from './rules/value.js';
import type { RiskDecision, RiskInput, RiskPolicy, Rule, RuleOutcome, Verdict } from './types.js';

/**
 * The declared evaluation order.
 *
 * Order affects only how the outcomes read, not the decision — every rule runs
 * regardless. Adding a rule means adding a line here and a file beside it;
 * nothing existing changes (master-prompt rule 155, prompt_phase3.md rule 91).
 */
export const RULES: readonly Rule[] = [
  accountStateRule,
  amountRule,
  destinationRule,
  assetLimitsConfiguredRule,
  perTransactionLimitRule,
  dailyLimitRule,
  velocityRule,
  manualReviewThresholdRule,
  usdReviewThresholdRule,
];

/**
 * Bump when a rule's MEANING changes, so an old decision is not mistaken for
 * one the current policy would produce. Not a version of the limits — those
 * are configuration and are captured in the decision's detail.
 */
export const POLICY_VERSION = '2';

/**
 * Evaluate every rule and compose one decision
 * (prompt_phase3.md rules 92-93).
 *
 * NO SHORT-CIRCUIT. The obvious optimisation — stop at the first denial — makes
 * the decision record the first thing that was wrong rather than everything
 * that was wrong, and an operator resolving a review needs the whole picture.
 * The engine is pure and operates on already-fetched data, so running all seven
 * rules costs nothing worth saving.
 *
 * Precedence: any deny wins; otherwise any review wins; otherwise approve.
 * A denial is not softened by a passing rule, and a review is not upgraded to
 * an approval by one.
 */
export function evaluate(input: RiskInput, policy: RiskPolicy): RiskDecision {
  const outcomes: RuleOutcome[] = RULES.map((rule) => rule(input, policy));

  const verdict: Verdict = outcomes.some((o) => o.verdict === 'deny')
    ? 'deny'
    : outcomes.some((o) => o.verdict === 'review')
      ? 'review'
      : 'approve';

  const codes = dedupe(outcomes.flatMap((o) => o.codes));

  // An approval with nothing to say still records that the limits were
  // checked. A bare "approved" is indistinguishable from "no rules ran".
  const finalCodes =
    verdict === 'approve' && codes.every((code) => INFORMATIONAL_CODES.has(code))
      ? dedupe([...codes, 'WITHIN_ALL_LIMITS' as ReasonCode])
      : codes;

  return {
    verdict,
    codes: finalCodes,
    outcomes,
    evaluatedRules: outcomes.map((o) => o.rule),
    policyVersion: POLICY_VERSION,
    evaluatedAt: input.now,
  };
}

/** Codes that explain a non-approval, with informational ones stripped. */
export function problemCodes(decision: RiskDecision): ReasonCode[] {
  return decision.codes.filter((code) => !INFORMATIONAL_CODES.has(code));
}

function dedupe(codes: readonly ReasonCode[]): ReasonCode[] {
  return [...new Set(codes)];
}
