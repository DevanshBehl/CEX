import { describe, expect, it } from 'vitest';
import { FEE_TIERS, tierForVolume, WORST_CASE_TAKER_BPS } from './fees.js';

describe('the fee schedule', () => {
  it('never puts the maker above the taker', () => {
    for (const tier of FEE_TIERS) {
      expect(tier.makerBps, `tier ${tier.tier}`).toBeLessThan(tier.takerBps);
    }
  });

  // A rebate is a way to pay out money the exchange has not collected, which
  // needs an accounting treatment this project does not have (ADR-0029).
  it('never offers a negative maker fee', () => {
    for (const tier of FEE_TIERS) {
      expect(tier.makerBps, `tier ${tier.tier}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('gets cheaper as volume rises, on both sides', () => {
    for (let i = 1; i < FEE_TIERS.length; i += 1) {
      const previous = FEE_TIERS[i - 1]!;
      const current = FEE_TIERS[i]!;
      expect(current.minVolume).toBeGreaterThan(previous.minVolume);
      expect(current.makerBps).toBeLessThan(previous.makerBps);
      expect(current.takerBps).toBeLessThan(previous.takerBps);
    }
  });

  it('starts at zero volume, so every account has a tier', () => {
    expect(FEE_TIERS[0]!.minVolume).toBe(0n);
    expect(tierForVolume(0n).tier).toBe(0);
  });
});

describe('tierForVolume', () => {
  it('picks the highest tier the volume reaches', () => {
    expect(tierForVolume(0n).tier).toBe(0);
    expect(tierForVolume(99_999_999_999n).tier).toBe(0);
    expect(tierForVolume(100_000_000_000n).tier).toBe(1);
    expect(tierForVolume(10_000_000_000_000n).tier).toBe(3);
    expect(tierForVolume(10n ** 30n).tier).toBe(3);
  });

  it('refuses a negative volume', () => {
    expect(() => tierForVolume(-1n)).toThrow(RangeError);
  });
});

describe('WORST_CASE_TAKER_BPS', () => {
  // The hold is taken before the tier is known, and a hold that is too small is
  // an unfillable order.
  it('is the most expensive taker rate in the schedule', () => {
    expect(WORST_CASE_TAKER_BPS).toBe(Math.max(...FEE_TIERS.map((t) => t.takerBps)));
    for (const tier of FEE_TIERS) {
      expect(tier.takerBps).toBeLessThanOrEqual(WORST_CASE_TAKER_BPS);
    }
  });
});
