/**
 * The maker/taker fee schedule (ADR-0029).
 *
 * Fees are charged in the market's QUOTE asset for both sides. That follows
 * from the hold, not from preference: a buyer reserves quote and a seller
 * receives quote, so a quote-denominated fee always comes out of something the
 * fill already moves. Charging each side in the asset it receives would add a
 * base-asset fee leg, so both assets would move on both legs and a settlement
 * would need four legs instead of three.
 *
 * S1 carries these numbers and charges nothing. S4 applies them.
 */

export interface FeeTier {
  readonly tier: number;
  /** Trailing 30-day quote volume, in quote base units, to reach this tier. */
  readonly minVolume: bigint;
  readonly makerBps: number;
  readonly takerBps: number;
}

/**
 * Maker below taker at every tier, and never a negative maker fee.
 *
 * A rebate is a real way to attract liquidity and also a way to pay out money
 * the exchange has not collected, which needs an accounting treatment this
 * project does not have. If the demo market maker needs an incentive it gets a
 * funded account, not a rebate.
 */
export const FEE_TIERS: readonly FeeTier[] = Object.freeze([
  { tier: 0, minVolume: 0n, makerBps: 10, takerBps: 20 },
  { tier: 1, minVolume: 100_000_000_000n, makerBps: 8, takerBps: 18 },
  { tier: 2, minVolume: 1_000_000_000_000n, makerBps: 5, takerBps: 15 },
  { tier: 3, minVolume: 10_000_000_000_000n, makerBps: 2, takerBps: 10 },
]);

/**
 * The most expensive taker rate in the schedule.
 *
 * This is what a hold must assume, because the hold is taken before the tier is
 * known and a hold that is too small is an unfillable order. S4 refunds the
 * difference, by the same mechanism that refunds a market buy's collar
 * over-hold.
 */
export const WORST_CASE_TAKER_BPS: number = FEE_TIERS.reduce(
  (worst, tier) => Math.max(worst, tier.takerBps),
  0,
);

/** The tier a trailing 30-day quote volume earns. */
export function tierForVolume(volume: bigint): FeeTier {
  if (volume < 0n) throw new RangeError(`volume must be non-negative: ${volume}`);
  let found = FEE_TIERS[0] as FeeTier;
  for (const tier of FEE_TIERS) {
    if (volume >= tier.minVolume) found = tier;
  }
  return found;
}
