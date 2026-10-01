import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateOrder, type OrderRiskInput, type OrderRiskPolicy } from './order-risk.js';
import { toOrderClientMessage } from './reason-codes.js';

const MARKET = 'devnet:SOL-USDC';
const policy: OrderRiskPolicy = {
  maxOrderQty: { [MARKET]: 1_000n },
  maxOpenOrdersPerMarket: 5,
  orderRateWindowSeconds: 60,
  orderRateMaxCount: 10,
  maxOpenNotional: { [MARKET]: 10_000n },
};
const now = new Date('2026-09-22T12:00:00Z');
const base: OrderRiskInput = {
  userId: 'u1',
  accountStatus: 'active',
  market: MARKET,
  qty: 100n,
  notional: 1_000n,
  openOrderCount: 0,
  openNotional: 0n,
  recentPlacements: [],
  now,
};

describe('evaluateOrder', () => {
  it('approves an ordinary order and says what was checked', () => {
    const decision = evaluateOrder(base, policy);
    expect(decision.verdict).toBe('approve');
    expect(decision.codes).toEqual(['WITHIN_ORDER_LIMITS']);
    expect(decision.evaluatedRules).toHaveLength(5);
  });

  it('never produces a review verdict', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000n }), fc.nat(20), (qty, open) => {
        const d = evaluateOrder({ ...base, qty, openOrderCount: open }, policy);
        expect(d.verdict).not.toBe('review');
      }),
    );
  });

  it('runs every rule even when the first denies, and reports all problems', () => {
    const d = evaluateOrder(
      { ...base, accountStatus: 'suspended', qty: 5_000n, openOrderCount: 9 },
      policy,
    );
    expect(d.verdict).toBe('deny');
    expect(d.codes).toEqual(
      expect.arrayContaining(['ACCOUNT_NOT_ACTIVE', 'ORDER_SIZE_LIMIT', 'OPEN_ORDER_LIMIT']),
    );
    expect(d.evaluatedRules).toHaveLength(5);
  });

  it('counts only placements inside the window', () => {
    const old = Array.from({ length: 20 }, () => new Date(now.getTime() - 120_000));
    expect(evaluateOrder({ ...base, recentPlacements: old }, policy).verdict).toBe('approve');
    const fresh = Array.from({ length: 10 }, () => new Date(now.getTime() - 1_000));
    expect(evaluateOrder({ ...base, recentPlacements: fresh }, policy).codes).toContain(
      'ORDER_RATE_LIMIT',
    );
  });

  it('adds the order to existing exposure', () => {
    expect(
      evaluateOrder({ ...base, openNotional: 9_500n, notional: 600n }, policy).codes,
    ).toContain('EXPOSURE_LIMIT');
  });

  // ADR-0010's posture: unconfigured is denied, never treated as unlimited.
  it('denies a market with no configured limits', () => {
    const d = evaluateOrder({ ...base, market: 'devnet:BONK-USDC' }, policy);
    expect(d.codes).toEqual(expect.arrayContaining(['ORDER_SIZE_LIMIT', 'EXPOSURE_LIMIT']));
  });

  it('is deterministic — replaying the input replays the decision', () => {
    expect(evaluateOrder(base, policy)).toEqual(evaluateOrder(base, policy));
  });
});

describe('toOrderClientMessage', () => {
  // A precise reason is an oracle for probing limits.
  it('collapses every limit into one sentence', () => {
    const a = toOrderClientMessage(['ORDER_SIZE_LIMIT']);
    for (const code of ['OPEN_ORDER_LIMIT', 'ORDER_RATE_LIMIT', 'EXPOSURE_LIMIT'] as const) {
      expect(toOrderClientMessage([code])).toBe(a);
    }
  });
});
