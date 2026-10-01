import { INFORMATIONAL_CODES, type ReasonCode } from './reason-codes.js';
import type { Amount, RiskDecision, RuleOutcome, Verdict } from './types.js';

/**
 * Pre-trade risk (ADR-0033, prompt_phase_s3.md §13).
 *
 * A sibling of `evaluate`, not a fork: the same verdict type, the same append-
 * only reason codes, the same properties — pure, no clock, no database, no
 * configuration read, every rule on every input, a decision that replays.
 *
 * What is deliberately NOT here:
 *
 * - **Structural validation** (tick, lot, minimum notional, collar, market
 *   status). That is `packages/orders`, already written and tested; two
 *   answers to one question drift.
 * - **The sufficient-funds check.** That is the hold, posted in the same
 *   SERIALIZABLE transaction that reads the balance. A balance check here would
 *   be a read that something else later acts on, and the gap between them is
 *   where two concurrent orders both pass.
 *
 * There is no `review` verdict. A person approving an order minutes later is
 * approving a different trade than the one placed.
 */

export const ORDER_POLICY_VERSION = '1';

export interface OrderRiskPolicy {
  /** Largest single order, in base-asset base units, per market id. */
  readonly maxOrderQty: Readonly<Record<string, Amount>>;
  /** Live orders one user may hold in one market. */
  readonly maxOpenOrdersPerMarket: number;
  readonly orderRateWindowSeconds: number;
  readonly orderRateMaxCount: number;
  /** Total open notional per user per market, in quote base units. */
  readonly maxOpenNotional: Readonly<Record<string, Amount>>;
}

export interface OrderRiskInput {
  readonly userId: string;
  readonly accountStatus: 'active' | 'suspended' | 'closed';
  readonly market: string;
  readonly qty: Amount;
  /** The order's own notional in quote base units — what it adds to exposure. */
  readonly notional: Amount;
  readonly openOrderCount: number;
  /** Notional already resting for this user in this market. */
  readonly openNotional: Amount;
  /** When this user's recent placements happened. The window is applied here. */
  readonly recentPlacements: readonly Date[];
  /** An argument, never a reading: a rule that reads a clock cannot be replayed. */
  readonly now: Date;
}

export type OrderRule = (input: OrderRiskInput, policy: OrderRiskPolicy) => RuleOutcome;

const pass = (rule: string): RuleOutcome => ({ rule, verdict: 'approve', codes: [] });
const deny = (rule: string, code: ReasonCode, detail: Record<string, string>): RuleOutcome => ({
  rule,
  verdict: 'deny',
  codes: [code],
  detail,
});

export const orderAccountRule: OrderRule = (input) =>
  input.accountStatus === 'active'
    ? pass('order_account')
    : deny('order_account', 'ACCOUNT_NOT_ACTIVE', { status: input.accountStatus });

/** A market with no configured cap is DENIED, not uncapped — ADR-0010's posture. */
export const orderSizeRule: OrderRule = (input, policy) => {
  const cap = policy.maxOrderQty[input.market];
  if (cap === undefined) {
    return deny('order_size', 'ORDER_SIZE_LIMIT', { reason: 'market_not_configured' });
  }
  return input.qty > cap
    ? deny('order_size', 'ORDER_SIZE_LIMIT', { qty: input.qty.toString(), cap: cap.toString() })
    : pass('order_size');
};

export const openOrdersRule: OrderRule = (input, policy) =>
  input.openOrderCount >= policy.maxOpenOrdersPerMarket
    ? deny('open_orders', 'OPEN_ORDER_LIMIT', {
        open: String(input.openOrderCount),
        cap: String(policy.maxOpenOrdersPerMarket),
      })
    : pass('open_orders');

/**
 * Placements in the trailing window. Distinct from the HTTP rate limiter:
 * that protects the service from load; this protects the book from one
 * account's behaviour, and this one is persisted and replayable.
 */
export const orderRateRule: OrderRule = (input, policy) => {
  const since = input.now.getTime() - policy.orderRateWindowSeconds * 1000;
  const recent = input.recentPlacements.filter((at) => at.getTime() > since).length;
  return recent >= policy.orderRateMaxCount
    ? deny('order_rate', 'ORDER_RATE_LIMIT', {
        recent: String(recent),
        cap: String(policy.orderRateMaxCount),
      })
    : pass('order_rate');
};

export const exposureRule: OrderRule = (input, policy) => {
  const cap = policy.maxOpenNotional[input.market];
  if (cap === undefined) {
    return deny('exposure', 'EXPOSURE_LIMIT', { reason: 'market_not_configured' });
  }
  const after = input.openNotional + input.notional;
  return after > cap
    ? deny('exposure', 'EXPOSURE_LIMIT', { after: after.toString(), cap: cap.toString() })
    : pass('exposure');
};

export const ORDER_RULES: readonly OrderRule[] = [
  orderAccountRule,
  orderSizeRule,
  openOrdersRule,
  orderRateRule,
  exposureRule,
];

export function evaluateOrder(input: OrderRiskInput, policy: OrderRiskPolicy): RiskDecision {
  const outcomes = ORDER_RULES.map((rule) => rule(input, policy));
  const verdict: Verdict = outcomes.some((o) => o.verdict === 'deny') ? 'deny' : 'approve';
  const codes = [...new Set(outcomes.flatMap((o) => o.codes))];
  const finalCodes =
    verdict === 'approve' && codes.every((code) => INFORMATIONAL_CODES.has(code))
      ? [...codes, 'WITHIN_ORDER_LIMITS' as ReasonCode]
      : codes;
  return {
    verdict,
    codes: finalCodes,
    outcomes,
    evaluatedRules: outcomes.map((o) => o.rule),
    policyVersion: ORDER_POLICY_VERSION,
    evaluatedAt: input.now,
  };
}
