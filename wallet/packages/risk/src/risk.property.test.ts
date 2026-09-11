import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  INFORMATIONAL_CODES,
  problemCodes,
  REASON_CODES,
  toClientMessage,
  type RiskInput,
  type RiskPolicy,
} from './index.js';

/**
 * Properties of every possible decision (prompt_phase3.md rule 166).
 *
 * The worked examples prove the cases someone thought of. These prove the
 * claims the engine makes about ITSELF — that a denial always explains itself,
 * that a decision never depends on anything but its inputs, and that no input
 * makes the client message reveal a threshold.
 */

const SOL = 'SOL';
const ONE_SOL = 1_000_000_000n;

const POLICY: RiskPolicy = {
  supportedAssets: [SOL, 'USDC'],
  perTransactionLimit: 100n * ONE_SOL,
  dailyLimit: 250n * ONE_SOL,
  velocityWindowMinutes: 60,
  velocityMaxCount: 10,
  manualReviewAbove: 25n * ONE_SOL,
  reviewNewDestinations: true,
  knownDestinationWindowDays: 90,
};

const anyInput: fc.Arbitrary<RiskInput> = fc.record({
  userId: fc.uuid(),
  accountStatus: fc.constantFrom('active' as const, 'suspended' as const, 'closed' as const),
  asset: fc.constantFrom(SOL, 'USDC', 'UNKNOWN'),
  // Includes zero, negatives, and values far above every limit.
  amount: fc.bigInt({ min: -(10n ** 12n), max: 10n ** 21n }),
  destination: fc.constantFrom('DestA', 'DestB', 'DestC'),
  destinationCheck: fc.oneof(
    fc.record({ ok: fc.constant(true as const), isPlatformOwned: fc.boolean() }),
    fc.record({
      ok: fc.constant(false as const),
      reason: fc.constantFrom('invalid' as const, 'not_signable' as const),
    }),
  ),
  priorDestinations: fc.array(
    fc.record({
      address: fc.constantFrom('DestA', 'DestB', 'DestC'),
      lastUsedAt: fc.date({ min: new Date('2024-01-01'), max: new Date('2026-09-11') }),
    }),
    { maxLength: 5 },
  ),
  recentWithdrawals: fc.array(
    fc.record({
      amount: fc.bigInt({ min: 0n, max: 10n ** 20n }),
      asset: fc.constantFrom(SOL, 'USDC'),
      createdAt: fc.date({ min: new Date('2026-09-09'), max: new Date('2026-09-11') }),
    }),
    { maxLength: 30 },
  ),
  now: fc.constant(new Date('2026-09-11T12:00:00.000Z')),
});

describe('every decision explains itself', () => {
  it('a denial always carries at least one problem code (rule 78)', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const decision = evaluate(input, POLICY);
        if (decision.verdict === 'deny') {
          expect(problemCodes(decision).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('a review always carries the codes that triggered it (rule 79)', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const decision = evaluate(input, POLICY);
        if (decision.verdict === 'review') {
          expect(problemCodes(decision).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('an approval is never silent (rule 80)', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const decision = evaluate(input, POLICY);
        if (decision.verdict === 'approve') {
          expect(decision.codes.length).toBeGreaterThan(0);
          expect(decision.codes.every((c) => INFORMATIONAL_CODES.has(c))).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('every emitted code is a declared one', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        for (const code of evaluate(input, POLICY).codes) {
          expect(REASON_CODES).toContain(code);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('records every rule it ran, whatever the outcome', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const decision = evaluate(input, POLICY);
        expect(decision.evaluatedRules).toHaveLength(decision.outcomes.length);
        expect(new Set(decision.evaluatedRules).size).toBe(decision.evaluatedRules.length);
      }),
      { numRuns: 300 },
    );
  });
});

describe('determinism (master-prompt rule 153)', () => {
  it('the same input always produces an identical decision', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const a = evaluate(input, POLICY);
        const b = evaluate(input, POLICY);
        expect(b.verdict).toBe(a.verdict);
        expect(b.codes).toEqual(a.codes);
        expect(b.outcomes).toEqual(a.outcomes);
      }),
      { numRuns: 300 },
    );
  });

  it('is unaffected by the order of history', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const reversed: RiskInput = {
          ...input,
          recentWithdrawals: [...input.recentWithdrawals].reverse(),
          priorDestinations: [...input.priorDestinations].reverse(),
        };
        expect(evaluate(reversed, POLICY).verdict).toBe(evaluate(input, POLICY).verdict);
      }),
      { numRuns: 300 },
    );
  });
});

describe('the client is never told a threshold (rules 81-82)', () => {
  it('no input makes the client message contain a digit', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const message = toClientMessage(evaluate(input, POLICY).codes);
        expect(message).not.toMatch(/\d/);
      }),
      { numRuns: 500 },
    );
  });

  it('every value limit produces the same message', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const decision = evaluate(input, POLICY);
        const limits = (['PER_TRANSACTION_LIMIT', 'DAILY_LIMIT', 'VELOCITY_LIMIT'] as const).filter(
          (code) => decision.codes.includes(code),
        );
        if (limits.length > 1) {
          const messages = new Set(limits.map((code) => toClientMessage([code])));
          expect(messages.size).toBe(1);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('monotonicity', () => {
  it('raising the amount never turns a denial into an approval', () => {
    fc.assert(
      fc.property(anyInput, fc.bigInt({ min: 1n, max: 10n ** 18n }), (input, increase) => {
        const smaller = evaluate(input, POLICY);
        const larger = evaluate({ ...input, amount: input.amount + increase }, POLICY);

        const rank = { approve: 0, review: 1, deny: 2 } as const;
        // A larger withdrawal is never treated more leniently than a smaller
        // one with everything else held constant.
        expect(rank[larger.verdict]).toBeGreaterThanOrEqual(rank[smaller.verdict]);
      }),
      { numRuns: 400 },
    );
  });
});
