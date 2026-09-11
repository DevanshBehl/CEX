import { describe, expect, it } from 'vitest';
import {
  accountStateRule,
  dailyLimitRule,
  destinationRule,
  evaluate,
  manualReviewThresholdRule,
  perTransactionLimitRule,
  problemCodes,
  toClientMessage,
  velocityRule,
  type RiskInput,
  type RiskPolicy,
} from './index.js';

/**
 * Zero HTTP, zero database, zero chain (master-prompt rule 179,
 * prompt_phase3.md rule 165).
 *
 * Every rule is a function from data to a decision, so every case below is a
 * literal — including the clock. Nothing here can be flaky, and every decision
 * is reproducible years from now from the same inputs.
 */

const SOL = 'SOL';
const ONE_SOL = 1_000_000_000n;
const NOW = new Date('2026-09-11T12:00:00.000Z');

const POLICY: RiskPolicy = {
  supportedAssets: [SOL],
  assetLimits: {
    [SOL]: {
      perTransactionLimit: 100n * ONE_SOL,
      dailyLimit: 250n * ONE_SOL,
      manualReviewAbove: 25n * ONE_SOL,
    },
  },
  perTransactionLimit: 100n * ONE_SOL,
  dailyLimit: 250n * ONE_SOL,
  velocityWindowMinutes: 60,
  velocityMaxCount: 10,
  manualReviewAbove: 25n * ONE_SOL,
  reviewNewDestinations: true,
  knownDestinationWindowDays: 90,
};

const DEST = 'DestinationAddress1111111111111111111111111';

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    userId: 'u1',
    accountStatus: 'active',
    asset: SOL,
    amount: ONE_SOL,
    destination: DEST,
    destinationCheck: { ok: true, isPlatformOwned: false },
    // Known by default, so a test exercising a limit is not also tripping the
    // new-destination review.
    priorDestinations: [{ address: DEST, lastUsedAt: new Date('2026-09-01T00:00:00Z') }],
    recentWithdrawals: [],
    now: NOW,
    ...overrides,
  };
}

const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000);
const hoursAgo = (n: number): Date => new Date(NOW.getTime() - n * 3_600_000);

// ---------------------------------------------------------------------------
// Individual rules (rule 91: each independently testable)
// ---------------------------------------------------------------------------

describe('account state (rule 90)', () => {
  it('approves an active account', () => {
    expect(accountStateRule(input(), POLICY).verdict).toBe('approve');
  });

  it.each(['suspended', 'closed'] as const)('denies a %s account', (status) => {
    const outcome = accountStateRule(input({ accountStatus: status }), POLICY);
    expect(outcome.verdict).toBe('deny');
    expect(outcome.codes).toContain('ACCOUNT_NOT_ACTIVE');
  });
});

describe('destination (rules 87-88)', () => {
  it('denies a malformed address', () => {
    const outcome = destinationRule(
      input({ destinationCheck: { ok: false, reason: 'invalid' } }),
      POLICY,
    );
    expect(outcome.verdict).toBe('deny');
    expect(outcome.codes).toContain('DESTINATION_INVALID');
  });

  it('denies an address nothing can sign for', () => {
    // A PDA is well-formed and has no private key; funds sent there are stuck.
    const outcome = destinationRule(
      input({ destinationCheck: { ok: false, reason: 'not_signable' } }),
      POLICY,
    );
    expect(outcome.codes).toContain('DESTINATION_NOT_SIGNABLE');
  });

  it('denies an address the platform owns', () => {
    const outcome = destinationRule(
      input({ destinationCheck: { ok: true, isPlatformOwned: true } }),
      POLICY,
    );
    expect(outcome.verdict).toBe('deny');
    expect(outcome.codes).toContain('DESTINATION_INTERNAL');
  });

  it('approves a known destination', () => {
    const outcome = destinationRule(input(), POLICY);
    expect(outcome.verdict).toBe('approve');
    expect(outcome.codes).toContain('KNOWN_DESTINATION');
  });

  it('REVIEWS a new destination rather than denying it (ADR-0010)', () => {
    // Denying would deny everyone their first withdrawal.
    const outcome = destinationRule(input({ priorDestinations: [] }), POLICY);
    expect(outcome.verdict).toBe('review');
    expect(outcome.codes).toContain('NEW_DESTINATION');
  });

  it('treats a destination older than the window as new again', () => {
    const outcome = destinationRule(
      input({
        priorDestinations: [{ address: DEST, lastUsedAt: new Date('2020-01-01T00:00:00Z') }],
      }),
      POLICY,
    );
    expect(outcome.verdict).toBe('review');
  });

  it('does not confuse one destination with another', () => {
    const outcome = destinationRule(
      input({ priorDestinations: [{ address: 'SomeOtherAddress', lastUsedAt: NOW }] }),
      POLICY,
    );
    expect(outcome.verdict).toBe('review');
  });
});

describe('per-transaction limit (rule 83)', () => {
  it('approves at exactly the limit', () => {
    expect(
      perTransactionLimitRule(input({ amount: POLICY.perTransactionLimit }), POLICY).verdict,
    ).toBe('approve');
  });

  it('denies one base unit above it', () => {
    const outcome = perTransactionLimitRule(
      input({ amount: POLICY.perTransactionLimit + 1n }),
      POLICY,
    );
    expect(outcome.verdict).toBe('deny');
    expect(outcome.codes).toContain('PER_TRANSACTION_LIMIT');
  });
});

describe('rolling daily limit (rules 84-85)', () => {
  it('sums the trailing window, not a calendar day', () => {
    const outcome = dailyLimitRule(
      input({
        amount: 100n * ONE_SOL,
        recentWithdrawals: [
          { amount: 100n * ONE_SOL, asset: SOL, createdAt: hoursAgo(23) },
          { amount: 60n * ONE_SOL, asset: SOL, createdAt: hoursAgo(1) },
        ],
      }),
      POLICY,
    );
    // 100 + 160 = 260 > 250
    expect(outcome.verdict).toBe('deny');
    expect(outcome.codes).toContain('DAILY_LIMIT');
  });

  it('excludes withdrawals older than the window', () => {
    const outcome = dailyLimitRule(
      input({
        amount: 100n * ONE_SOL,
        recentWithdrawals: [{ amount: 240n * ONE_SOL, asset: SOL, createdAt: hoursAgo(25) }],
      }),
      POLICY,
    );
    expect(outcome.verdict).toBe('approve');
  });

  it('has no midnight seam — 23:59 and 00:01 are one window', () => {
    // The failure a calendar reset permits: two full limits ninety seconds
    // apart. The rolling window refuses the second.
    const justBeforeMidnight = new Date('2026-09-11T23:59:00.000Z');
    const justAfter = new Date('2026-09-12T00:01:00.000Z');

    const outcome = dailyLimitRule(
      {
        ...input({ amount: 250n * ONE_SOL }),
        now: justAfter,
        recentWithdrawals: [{ amount: 250n * ONE_SOL, asset: SOL, createdAt: justBeforeMidnight }],
      },
      POLICY,
    );
    expect(outcome.verdict).toBe('deny');
  });

  it('counts only the same asset', () => {
    const outcome = dailyLimitRule(
      input({
        amount: 100n * ONE_SOL,
        recentWithdrawals: [{ amount: 240n * ONE_SOL, asset: 'OTHER', createdAt: hoursAgo(1) }],
      }),
      POLICY,
    );
    expect(outcome.verdict).toBe('approve');
  });
});

describe('velocity (rule 86)', () => {
  it('denies once the count reaches the cap', () => {
    const outcome = velocityRule(
      input({
        recentWithdrawals: Array.from({ length: 10 }, () => ({
          amount: 1n,
          asset: SOL,
          createdAt: minutesAgo(10),
        })),
      }),
      POLICY,
    );
    expect(outcome.verdict).toBe('deny');
    expect(outcome.codes).toContain('VELOCITY_LIMIT');
  });

  it('catches many tiny withdrawals that no value limit would', () => {
    // 10 withdrawals of 1 lamport: far under every value limit.
    const tiny = Array.from({ length: 10 }, () => ({
      amount: 1n,
      asset: SOL,
      createdAt: minutesAgo(1),
    }));
    expect(velocityRule(input({ amount: 1n, recentWithdrawals: tiny }), POLICY).verdict).toBe(
      'deny',
    );
    expect(dailyLimitRule(input({ amount: 1n, recentWithdrawals: tiny }), POLICY).verdict).toBe(
      'approve',
    );
  });

  it('ignores withdrawals outside the window', () => {
    const outcome = velocityRule(
      input({
        recentWithdrawals: Array.from({ length: 20 }, () => ({
          amount: 1n,
          asset: SOL,
          createdAt: minutesAgo(61),
        })),
      }),
      POLICY,
    );
    expect(outcome.verdict).toBe('approve');
  });
});

describe('manual review threshold (rule 89)', () => {
  it('reviews at or above the threshold', () => {
    const outcome = manualReviewThresholdRule(input({ amount: POLICY.manualReviewAbove }), POLICY);
    expect(outcome.verdict).toBe('review');
    expect(outcome.codes).toContain('MANUAL_REVIEW_THRESHOLD');
  });

  it('approves below it', () => {
    expect(
      manualReviewThresholdRule(input({ amount: POLICY.manualReviewAbove - 1n }), POLICY).verdict,
    ).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// Composition (rules 92-93)
// ---------------------------------------------------------------------------

describe('the engine', () => {
  it('approves an ordinary withdrawal and says what it checked', () => {
    const decision = evaluate(input(), POLICY);
    expect(decision.verdict).toBe('approve');
    expect(decision.codes).toContain('WITHIN_ALL_LIMITS');
    expect(decision.evaluatedRules.length).toBeGreaterThanOrEqual(7);
  });

  it('evaluates EVERY rule rather than stopping at the first denial', () => {
    // A suspended account making an over-limit withdrawal to a bad destination.
    // A short-circuiting engine reports one problem; an operator needs all of
    // them.
    const decision = evaluate(
      input({
        accountStatus: 'suspended',
        amount: 500n * ONE_SOL,
        destinationCheck: { ok: false, reason: 'invalid' },
      }),
      POLICY,
    );

    expect(decision.verdict).toBe('deny');
    expect(decision.codes).toContain('ACCOUNT_NOT_ACTIVE');
    expect(decision.codes).toContain('DESTINATION_INVALID');
    expect(decision.codes).toContain('PER_TRANSACTION_LIMIT');
    // Every rule in RULES, asserted by name rather than by count so that
    // adding one forces a deliberate update here instead of a number change.
    expect([...decision.evaluatedRules].sort()).toEqual([
      'account_state',
      'amount',
      'asset_limits_configured',
      'daily_limit',
      'destination',
      'manual_review_threshold',
      'per_transaction_limit',
      'velocity',
    ]);
  });

  it('lets a denial win over a review', () => {
    const decision = evaluate(input({ amount: 500n * ONE_SOL, priorDestinations: [] }), POLICY);
    expect(decision.verdict).toBe('deny');
    // The review reason is still recorded, it just does not decide.
    expect(decision.codes).toContain('NEW_DESTINATION');
  });

  it('does not let a passing rule upgrade a review', () => {
    const decision = evaluate(input({ amount: 30n * ONE_SOL }), POLICY);
    expect(decision.verdict).toBe('review');
    expect(decision.codes).toContain('MANUAL_REVIEW_THRESHOLD');
  });

  it('is deterministic — the same input always decides the same way', () => {
    const shared = input({ amount: 30n * ONE_SOL });
    const first = evaluate(shared, POLICY);
    const second = evaluate(shared, POLICY);
    expect(second.verdict).toBe(first.verdict);
    expect(second.codes).toEqual(first.codes);
    expect(second.evaluatedAt).toEqual(first.evaluatedAt);
  });

  it('never reads the clock', () => {
    // `now` is an argument, so an evaluation dated in the past behaves exactly
    // as it did then — which is what makes a persisted decision replayable.
    const past = new Date('2020-01-01T00:00:00Z');
    const decision = evaluate({ ...input(), now: past }, POLICY);
    expect(decision.evaluatedAt).toEqual(past);
  });

  it('records the policy version', () => {
    expect(evaluate(input(), POLICY).policyVersion).toBeTruthy();
  });

  it('strips informational codes from the problem list', () => {
    const decision = evaluate(input(), POLICY);
    expect(problemCodes(decision)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The client must not learn which limit it hit (rules 81-82)
// ---------------------------------------------------------------------------

describe('client messaging', () => {
  it('collapses every limit into one message', () => {
    const perTx = toClientMessage(['PER_TRANSACTION_LIMIT']);
    const daily = toClientMessage(['DAILY_LIMIT']);
    const velocity = toClientMessage(['VELOCITY_LIMIT']);
    // Identical, so a caller cannot tell which limit it hit and binary-search
    // the threshold with a series of rejected requests.
    expect(daily).toBe(perTx);
    expect(velocity).toBe(perTx);
  });

  it('never leaks a number', () => {
    const decision = evaluate(input({ amount: 500n * ONE_SOL }), POLICY);
    const message = toClientMessage(decision.codes);
    expect(message).not.toMatch(/\d/);
    // The operator, by contrast, gets the figures.
    const outcome = decision.outcomes.find((o) => o.rule === 'per_transaction_limit');
    expect(outcome?.detail?.limit).toBe(POLICY.perTransactionLimit.toString());
  });
});

// ---------------------------------------------------------------------------
// Per-asset limits (prompt_phase4.md rule 127, ADR-0016)
// ---------------------------------------------------------------------------

describe('per-asset limits', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const withUsdc: RiskPolicy = {
    ...POLICY,
    supportedAssets: [SOL, USDC],
    assetLimits: {
      ...POLICY.assetLimits,
      [USDC]: {
        // Six decimals: 100 USDC, not 100 SOL.
        perTransactionLimit: 100_000_000n,
        dailyLimit: 250_000_000n,
        manualReviewAbove: 25_000_000n,
      },
    },
  };

  it('applies the token limit to the token, not the SOL one', () => {
    // 200 USDC in base units. Under the SOL limit (100 * 10^9) this sails
    // through; under the USDC limit (100 * 10^6) it must not.
    const decision = evaluate(input({ asset: USDC, amount: 200_000_000n }), withUsdc);
    expect(decision.codes).toContain('PER_TRANSACTION_LIMIT');
  });

  it('approves an amount within the token limit', () => {
    const decision = evaluate(input({ asset: USDC, amount: 50_000_000n }), withUsdc);
    expect(decision.codes).not.toContain('PER_TRANSACTION_LIMIT');
    expect(decision.codes).not.toContain('DAILY_LIMIT');
  });

  it('does not let a token withdrawal consume the SOL daily allowance', () => {
    const decision = evaluate(
      input({
        asset: USDC,
        amount: 10_000_000n,
        recentWithdrawals: [
          { asset: SOL, amount: 200n * ONE_SOL, createdAt: new Date(NOW.getTime() - 60_000) },
        ],
      }),
      withUsdc,
    );
    expect(decision.codes).not.toContain('DAILY_LIMIT');
  });

  it('DENIES an allowlisted asset that has no limits configured', () => {
    // The core of rule 127. Falling back to SOL's numbers would permit a
    // thousand times the intended value.
    const noLimits: RiskPolicy = { ...POLICY, supportedAssets: [SOL, USDC] };
    const decision = evaluate(input({ asset: USDC, amount: 1n }), noLimits);

    expect(decision.verdict).toBe('deny');
    expect(decision.codes).toContain('ASSET_LIMITS_NOT_CONFIGURED');
    // And it does not ALSO report a limit breach it could not have measured.
    expect(decision.codes).not.toContain('PER_TRANSACTION_LIMIT');
  });

  it('tells the user nothing about which limit or asset', () => {
    const noLimits: RiskPolicy = { ...POLICY, supportedAssets: [SOL, USDC] };
    const decision = evaluate(input({ asset: USDC, amount: 1n }), noLimits);
    expect(toClientMessage(decision.codes)).toBe('That asset is not supported.');
  });

  it('reviews a large token amount against the token threshold', () => {
    const decision = evaluate(input({ asset: USDC, amount: 30_000_000n }), withUsdc);
    expect(decision.codes).toContain('MANUAL_REVIEW_THRESHOLD');
  });
});
