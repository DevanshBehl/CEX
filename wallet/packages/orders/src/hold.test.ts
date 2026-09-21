import { describe, expect, it } from 'vitest';
import { notional } from '@wallet/types';
import { computeHold } from './hold.js';
import { WORST_CASE_TAKER_BPS } from './fees.js';
import { order, REF, SOL_USDC } from './helpers.test-support.js';

const hold = (o: Parameters<typeof order>[0], reference: bigint | null = REF) =>
  computeHold({ request: order(o), market: SOL_USDC, reference });

describe('the held asset follows the side, not the quote asset', () => {
  // Getting this backwards reserves an asset the order does not spend, which
  // passes every balance check and still cannot settle.
  it('a buy holds quote', () => {
    expect(hold({ side: 'buy' }).asset).toBe('devnet:USDC');
    expect(hold({ side: 'buy', type: 'market', price: null }).asset).toBe('devnet:USDC');
  });

  it('a sell holds base', () => {
    expect(hold({ side: 'sell' }).asset).toBe('devnet:SOL');
    expect(hold({ side: 'sell', type: 'market', price: null }).asset).toBe('devnet:SOL');
  });
});

describe('a sell holds bare quantity', () => {
  // The fee comes out of the proceeds, which are quote. Holding a fee in base
  // would reserve an asset the fee is not charged in.
  it('holds exactly the quantity, with no fee headroom', () => {
    const result = hold({ side: 'sell' });
    expect(result.amount).toBe(1_000_000_000n);
    expect(result.feeHeadroom).toBe(0n);
  });
});

describe('a limit buy', () => {
  it('holds the notional plus the worst-case taker fee', () => {
    const result = hold({ side: 'buy', price: '150000000' as never });
    const value = notional(150_000_000n, 1_000_000_000n);
    expect(value).toBe(150_000_000n);
    // Tier 0 taker is the most expensive rate in the schedule.
    expect(result.feeHeadroom).toBe((value * BigInt(WORST_CASE_TAKER_BPS)) / 10_000n);
    expect(result.amount).toBe(value + result.feeHeadroom);
    expect(result.amount).toBeGreaterThan(value);
  });
});

describe('a market buy', () => {
  // Reserving against the reference would under-hold exactly when the book is
  // thin, which is when a market order costs the most.
  it('reserves against the TOP of the collar band, not the reference', () => {
    const result = hold({ side: 'buy', type: 'market', price: null });
    const upper = REF + (REF * 1000n) / 10_000n; // +10%
    expect(upper).toBe(165_000_000n);
    const value = notional(upper, 1_000_000_000n);
    expect(result.amount).toBe(value + result.feeHeadroom);
    // Strictly more than a limit buy at the reference price would hold.
    expect(result.amount).toBeGreaterThan(hold({ side: 'buy' }).amount);
  });

  it('refuses to hold when there is no reference to reserve against', () => {
    expect(() => hold({ side: 'buy', type: 'market', price: null }, null)).toThrow(
      /needs a reference price/,
    );
  });
});

describe('guards', () => {
  it('refuses a non-positive quantity', () => {
    expect(() => hold({ qty: '0' as never })).toThrow(RangeError);
  });

  it('refuses a limit order with no price', () => {
    expect(() => hold({ type: 'limit', price: null })).toThrow(/must carry a price/);
  });
});
