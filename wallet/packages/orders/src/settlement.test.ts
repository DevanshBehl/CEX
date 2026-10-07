import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { feeAmount, notional } from '@wallet/types';
import { FEE_TIERS, type FeeTier } from './fees.js';
import { computeHold } from './hold.js';
import { fillAmounts, holdConsumption } from './settlement.js';
import { order, SOL_USDC } from './helpers.test-support.js';

const TIER0 = FEE_TIERS[0] as FeeTier;
const TIER3 = FEE_TIERS[3] as FeeTier;

describe('who pays which rate', () => {
  // The decision that balances whichever way it is made (ADR-0034 §3).
  it('charges the taker rate to the buyer when the taker bought', () => {
    const a = fillAmounts({
      price: 150_000_000n,
      qty: 1_000_000_000n,
      takerSide: 'buy',
      takerTier: TIER0,
      makerTier: TIER3,
    });
    expect(a.buyerIsTaker).toBe(true);
    expect(a.buyerBps).toBe(TIER0.takerBps);
    expect(a.sellerBps).toBe(TIER3.makerBps);
    expect(a.buyerFee).toBe(feeAmount(a.notional, TIER0.takerBps));
    expect(a.sellerFee).toBe(feeAmount(a.notional, TIER3.makerBps));
  });

  it('charges the taker rate to the seller when the taker sold', () => {
    const a = fillAmounts({
      price: 150_000_000n,
      qty: 1_000_000_000n,
      takerSide: 'sell',
      takerTier: TIER0,
      makerTier: TIER3,
    });
    expect(a.buyerIsTaker).toBe(false);
    expect(a.sellerBps).toBe(TIER0.takerBps);
    expect(a.buyerBps).toBe(TIER3.makerBps);
    expect(a.sellerFee).toBe(feeAmount(a.notional, TIER0.takerBps));
    expect(a.buyerFee).toBe(feeAmount(a.notional, TIER3.makerBps));
  });

  it('settles both legs at one truncated notional', () => {
    // 1 tick below a whole quote unit: the product truncates.
    const a = fillAmounts({
      price: 150_000_001n,
      qty: 1_000_000n,
      takerSide: 'buy',
      takerTier: TIER0,
      makerTier: TIER0,
    });
    expect(a.notional).toBe(notional(150_000_001n, 1_000_000n));
    expect(a.notional).toBe(150_000n);
  });

  it('floors a fee to zero on a small enough fill', () => {
    const a = fillAmounts({
      price: 1_000_000n,
      qty: 1_000_000n,
      takerSide: 'buy',
      takerTier: TIER0,
      makerTier: TIER0,
    });
    expect(a.notional).toBe(1_000n);
    expect(a.makerFee).toBe(1n);
    // 1000 * 20 / 10000 = 2; at 1 bps it would floor to 0.
    expect(feeAmount(a.notional, 1)).toBe(0n);
  });
});

/*
 * THE HOLD IS ALWAYS ENOUGH (ADR-0034 §6, prompt_phase_s4.md rule 84).
 *
 * A buy reserves `notional(limit, qty) + fee(that, WORST_CASE_TAKER_BPS)`. Any
 * sequence of fills at or below the limit, at any tier, as maker or taker,
 * consumes at most that. If this property ever fails, the fee table and
 * `WORST_CASE_TAKER_BPS` have diverged — a bug, not a funding problem.
 */
describe('a buy hold covers every way it can be filled', () => {
  const tier = fc.constantFrom(...FEE_TIERS);
  const lot = BigInt(SOL_USDC.lotSize);
  const tick = BigInt(SOL_USDC.tickSize);

  it('holds for any split of the quantity into fills at or below the limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }), // limit, in ticks
        fc.array(
          fc.record({
            lots: fc.integer({ min: 1, max: 5_000 }),
            discountTicks: fc.integer({ min: 0, max: 1_000 }),
            takerSide: fc.constantFrom('buy' as const, 'sell' as const),
            takerTier: tier,
            makerTier: tier,
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (limitTicks, fills) => {
          const limit = BigInt(limitTicks) * tick;
          const qty = fills.reduce((s, f) => s + BigInt(f.lots), 0n) * lot;
          const hold = computeHold({
            request: order({
              side: 'buy',
              price: limit.toString() as never,
              qty: qty.toString() as never,
            }),
            market: SOL_USDC,
            reference: null,
          });

          let consumed = 0n;
          for (const f of fills) {
            const price = limit - BigInt(Math.min(f.discountTicks, limitTicks - 1)) * tick;
            const fillQty = BigInt(f.lots) * lot;
            const amounts = fillAmounts({
              price,
              qty: fillQty,
              takerSide: f.takerSide,
              takerTier: f.takerTier,
              makerTier: f.makerTier,
            });
            consumed += holdConsumption(amounts, fillQty).buyerQuote;
          }
          expect(consumed).toBeLessThanOrEqual(hold.amount);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('a sell consumes exactly its quantity, whatever the price', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (lots, ticks) => {
          const qty = BigInt(lots) * lot;
          const hold = computeHold({
            request: order({ side: 'sell', qty: qty.toString() as never }),
            market: SOL_USDC,
            reference: null,
          });
          const amounts = fillAmounts({
            price: BigInt(ticks) * tick,
            qty,
            takerSide: 'sell',
            takerTier: TIER0,
            makerTier: TIER0,
          });
          expect(holdConsumption(amounts, qty).sellerBase).toBe(hold.amount);
        },
      ),
    );
  });
});
