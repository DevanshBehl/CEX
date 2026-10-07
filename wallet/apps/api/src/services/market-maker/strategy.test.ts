import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMarket, notional } from '@wallet/types';
import { affordable, holdFor, ladder, shouldReanchor, type QuoteConfig } from './strategy.js';

const market = createMarket({
  cluster: 'devnet',
  symbol: 'SOL-USDC',
  baseAsset: 'devnet:SOL',
  quoteAsset: 'devnet:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tickSize: '1000',
  lotSize: '1000000',
  minNotional: '1000',
  collarBps: 1_000,
});
const config: QuoteConfig = {
  levels: 5,
  halfSpreadBps: 10,
  levelStepBps: 10,
  levelQty: 1_000_000_000n,
};
const REFERENCE = 150_000_000n;

describe('the ladder', () => {
  const quotes = ladder({ reference: REFERENCE, market, collarReference: REFERENCE, config });
  const bids = quotes.filter((q) => q.side === 'buy');
  const asks = quotes.filter((q) => q.side === 'sell');

  it('quotes every level on both sides, around the reference', () => {
    expect(bids.map((q) => q.price)).toEqual([
      149_850_000n,
      149_700_000n,
      149_550_000n,
      149_400_000n,
      149_250_000n,
    ]);
    expect(asks.map((q) => q.price)).toEqual([
      150_150_000n,
      150_300_000n,
      150_450_000n,
      150_600_000n,
      150_750_000n,
    ]);
  });

  it('is identical for identical input: no clock, no randomness', () => {
    expect(ladder({ reference: REFERENCE, market, collarReference: REFERENCE, config })).toEqual(
      quotes,
    );
  });

  it('never quotes outside the collar the engine would enforce', () => {
    // The book last traded far from where the reference now is.
    const far = ladder({ reference: REFERENCE, market, collarReference: 100_000_000n, config });
    // 10% around 100: nothing at 150 is inside it, so nothing is quoted.
    expect(far).toEqual([]);
    const edge = ladder({ reference: REFERENCE, market, collarReference: 136_500_000n, config });
    // Upper bound 150.15: the best ask is exactly on it, the rest are outside.
    expect(edge.filter((q) => q.side === 'sell').map((q) => q.price)).toEqual([150_150_000n]);
    expect(edge.filter((q) => q.side === 'buy')).toHaveLength(5);
  });

  it('quotes the whole ladder into an empty book, which has no collar yet', () => {
    expect(ladder({ reference: REFERENCE, market, collarReference: null, config })).toEqual(quotes);
  });

  it('quotes nothing for a size below one lot, or without a reference', () => {
    expect(
      ladder({ reference: REFERENCE, market, collarReference: null, config: { ...config, levelQty: 999_999n } }),
    ).toEqual([]);
    expect(ladder({ reference: 0n, market, collarReference: null, config })).toEqual([]);
  });

  it('for any reference and shape: on tick and lot, never crossed, strictly ordered', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 2_000n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 200 }),
        fc.bigInt({ min: 1_000_000n, max: 10n ** 12n }),
        (reference, levels, halfSpreadBps, levelStepBps, levelQty) => {
          const out = ladder({
            reference,
            market,
            collarReference: null,
            config: { levels, halfSpreadBps, levelStepBps, levelQty },
          });
          const buys = out.filter((q) => q.side === 'buy').map((q) => q.price);
          const sells = out.filter((q) => q.side === 'sell').map((q) => q.price);
          for (const quote of out) {
            expect(quote.price % 1_000n).toBe(0n);
            expect(quote.qty % 1_000_000n).toBe(0n);
            expect(quote.price > 0n && quote.qty > 0n).toBe(true);
            expect(notional(quote.price, quote.qty) >= market.minNotional).toBe(true);
          }
          // Each level strictly further out than the last: no two share a price.
          for (let i = 1; i < buys.length; i += 1) expect(buys[i]! < buys[i - 1]!).toBe(true);
          for (let i = 1; i < sells.length; i += 1) expect(sells[i]! > sells[i - 1]!).toBe(true);
          // Its best bid is below its best ask: it can never trade with itself.
          if (buys.length > 0 && sells.length > 0) expect(buys[0]! < sells[0]!).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('what it can afford', () => {
  const quotes = ladder({ reference: REFERENCE, market, collarReference: null, config });

  it('holds what the gateway will hold: quantity for a sell, notional plus the worst fee for a buy', () => {
    expect(holdFor({ side: 'sell', level: 0, price: 150_000_000n, qty: 1_000_000_000n })).toBe(
      1_000_000_000n,
    );
    // 150 notional + 20 bp.
    expect(holdFor({ side: 'buy', level: 0, price: 150_000_000n, qty: 1_000_000_000n })).toBe(
      150_300_000n,
    );
  });

  it('quotes nothing on a side it has nothing for, and that is not an error', () => {
    const onlyBase = affordable(quotes, { base: 10_000_000_000n, quote: 0n });
    expect(onlyBase.every((q) => q.side === 'sell')).toBe(true);
    expect(onlyBase).toHaveLength(5);
    expect(affordable(quotes, { base: 0n, quote: 0n })).toEqual([]);
  });

  it('funds the best levels first, and never more than the budget', () => {
    // Enough base for two asks and a little over.
    const funded = affordable(quotes, { base: 2_500_000_000n, quote: 0n });
    expect(funded.map((q) => q.level)).toEqual([0, 1]);

    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 11n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (base, quote) => {
          const out = affordable(quotes, { base, quote });
          const spent = (side: 'buy' | 'sell') =>
            out.filter((q) => q.side === side).reduce((sum, q) => sum + holdFor(q), 0n);
          expect(spent('sell') <= base).toBe(true);
          expect(spent('buy') <= quote).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('when to requote', () => {
  it('anchors at once, then only when the reference has moved a level', () => {
    expect(shouldReanchor(null, REFERENCE, 10)).toBe(true);
    // Under 10 bp: leave the ladder where it is.
    expect(shouldReanchor(REFERENCE, 150_100_000n, 10)).toBe(false);
    expect(shouldReanchor(REFERENCE, 149_900_000n, 10)).toBe(false);
    expect(shouldReanchor(REFERENCE, 150_150_000n, 10)).toBe(true);
    expect(shouldReanchor(REFERENCE, 149_850_000n, 10)).toBe(true);
  });
});
