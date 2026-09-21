import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMarket, notional, type Market, type OrderRequest } from '@wallet/types';
import { validateOrder } from './validate.js';
import { computeHold } from './hold.js';
import { collarBand } from './collar.js';

/**
 * Generated markets and orders, not fixtures.
 *
 * Fixtures test what was imagined. The overflow case below was not imagined —
 * it came out of this file.
 */

const positive = (max: bigint) => fc.bigInt({ min: 1n, max }).map((v) => v.toString());

const marketArb: fc.Arbitrary<Market> = fc
  .record({
    tickSize: positive(10n ** 9n),
    lotSize: positive(10n ** 9n),
    minNotional: positive(10n ** 9n),
    collarBps: fc.integer({ min: 1, max: 10_000 }),
    status: fc.constantFrom('open' as const, 'post_only' as const, 'halted' as const),
  })
  .map((m) =>
    createMarket({
      cluster: 'devnet',
      symbol: 'SOL-USDC',
      baseAsset: 'devnet:SOL',
      quoteAsset: 'devnet:USDC',
      ...m,
    }),
  );

const orderArb: fc.Arbitrary<OrderRequest> = fc
  .record({
    side: fc.constantFrom('buy' as const, 'sell' as const),
    type: fc.constantFrom('limit' as const, 'market' as const),
    timeInForce: fc.constantFrom('GTC' as const, 'IOC' as const, 'FOK' as const),
    stpMode: fc.constantFrom(
      'cancel_taker' as const,
      'cancel_maker' as const,
      'cancel_both' as const,
    ),
    // Deliberately spans the whole u64 range the schema admits, which is how
    // the notional overflow was found.
    price: fc.oneof(fc.constant(null), positive(18_446_744_073_709_551_615n)),
    qty: positive(18_446_744_073_709_551_615n),
    postOnly: fc.boolean(),
  })
  .map((o) => ({
    clientOrderId: 'client-order-0001',
    market: 'devnet:SOL-USDC',
    accountId: 'user-1',
    ...o,
  })) as fc.Arbitrary<OrderRequest>;

const referenceArb = fc.oneof(fc.constant(null), fc.bigInt({ min: 1n, max: 10n ** 12n }));

describe('validateOrder', () => {
  // A validator that throws on input it was handed is a 500 where a 400
  // belongs. This is the same class of defect the zod refinement had.
  it('never throws, for any market and any order the schemas admit', () => {
    fc.assert(
      fc.property(marketArb, orderArb, referenceArb, (market, request, reference) => {
        expect(() => validateOrder({ request, market, reference })).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });

  it('is deterministic — the same input always yields the same decision', () => {
    fc.assert(
      fc.property(marketArb, orderArb, referenceArb, (market, request, reference) => {
        const a = validateOrder({ request, market, reference });
        const b = validateOrder({ request, market, reference });
        expect(a).toEqual(b);
      }),
    );
  });

  it('agrees with itself: ok is true exactly when there are no reasons', () => {
    fc.assert(
      fc.property(marketArb, orderArb, referenceArb, (market, request, reference) => {
        const result = validateOrder({ request, market, reference });
        expect(result.ok).toBe(result.reasons.length === 0);
      }),
    );
  });

  it('never reports the same reason twice', () => {
    fc.assert(
      fc.property(marketArb, orderArb, referenceArb, (market, request, reference) => {
        const { reasons } = validateOrder({ request, market, reference });
        expect(new Set(reasons).size).toBe(reasons.length);
      }),
    );
  });

  it('a passing order is always worth at least the minimum notional', () => {
    fc.assert(
      fc.property(marketArb, orderArb, referenceArb, (market, request, reference) => {
        const result = validateOrder({ request, market, reference });
        if (!result.ok) return;
        expect(result.notional).not.toBeNull();
        expect(result.notional!).toBeGreaterThanOrEqual(market.minNotional);
      }),
    );
  });

  it('a passing limit order is always inside the collar, when one exists', () => {
    fc.assert(
      fc.property(marketArb, orderArb, referenceArb, (market, request, reference) => {
        const result = validateOrder({ request, market, reference });
        if (!result.ok || request.type !== 'limit' || result.band === null) return;
        const price = BigInt(request.price!);
        expect(price).toBeGreaterThanOrEqual(result.band.lower);
        expect(price).toBeLessThanOrEqual(result.band.upper);
      }),
    );
  });
});

describe('computeHold', () => {
  // Only ever called on an order that validated, which is what makes its
  // throwing guards unreachable in the gateway.
  const validated = fc
    .tuple(marketArb, orderArb, referenceArb)
    .filter(([market, request, reference]) => validateOrder({ request, market, reference }).ok);

  it('holds quote for a buy and base for a sell, always', () => {
    fc.assert(
      fc.property(validated, ([market, request, reference]) => {
        const hold = computeHold({ request, market, reference });
        expect(hold.asset).toBe(request.side === 'buy' ? market.quoteAsset : market.baseAsset);
      }),
    );
  });

  it('holds exactly the quantity for a sell, with no fee headroom', () => {
    fc.assert(
      fc.property(validated, ([market, request, reference]) => {
        if (request.side !== 'sell') return;
        const hold = computeHold({ request, market, reference });
        expect(hold.amount).toBe(BigInt(request.qty));
        expect(hold.feeHeadroom).toBe(0n);
      }),
    );
  });

  it('never holds less than the notional for a buy', () => {
    fc.assert(
      fc.property(validated, ([market, request, reference]) => {
        if (request.side !== 'buy') return;
        const hold = computeHold({ request, market, reference });
        expect(hold.feeHeadroom).toBeGreaterThanOrEqual(0n);
        expect(hold.amount).toBe(hold.amount - hold.feeHeadroom + hold.feeHeadroom);
        expect(hold.amount).toBeGreaterThanOrEqual(hold.feeHeadroom);
      }),
    );
  });

  it('a market buy never holds less than a limit buy at the reference price', () => {
    fc.assert(
      fc.property(marketArb, fc.bigInt({ min: 1n, max: 10n ** 9n }), (market, reference) => {
        const qty = market.lotSize;
        const upper = collarBand(reference, market).upper;
        const base = {
          clientOrderId: 'c-0000001',
          market: market.id,
          accountId: 'u',
          qty,
        } as const;
        const limit = computeHold({
          request: {
            ...base,
            side: 'buy',
            type: 'limit',
            timeInForce: 'GTC',
            price: reference.toString(),
            postOnly: false,
            stpMode: 'cancel_taker',
          } as unknown as OrderRequest,
          market,
          reference,
        });
        const market_ = computeHold({
          request: {
            ...base,
            side: 'buy',
            type: 'market',
            timeInForce: 'IOC',
            price: null,
            postOnly: false,
            stpMode: 'cancel_taker',
          } as unknown as OrderRequest,
          market,
          reference,
        });
        expect(notional(upper, BigInt(qty))).toBeGreaterThanOrEqual(
          notional(reference, BigInt(qty)),
        );
        expect(market_.amount).toBeGreaterThanOrEqual(limit.amount);
      }),
    );
  });
});
