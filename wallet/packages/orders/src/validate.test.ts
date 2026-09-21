import { describe, expect, it } from 'vitest';
import { createMarket } from '@wallet/types';
import { validateOrder } from './validate.js';
import { order, REF, SOL_USDC } from './helpers.test-support.js';

const at = (reference: bigint | null = REF) => ({ market: SOL_USDC, reference });

describe('a well-formed order', () => {
  it('passes with no reasons', () => {
    const result = validateOrder({ request: order(), ...at() });
    expect(result).toMatchObject({ ok: true, reasons: [] });
    expect(result.notional).toBe(150_000_000n);
  });
});

describe('every check runs on every order', () => {
  // No short-circuit, for the same reason packages/risk evaluates every rule: a
  // client that fixes the first problem and is rejected again has learned one
  // thing per round trip.
  it('reports a tick violation AND a lot violation together', () => {
    const result = validateOrder({
      request: order({ price: '150000001' as never, qty: '1000000001' as never }),
      ...at(),
    });
    expect(result.reasons).toContain('TICK_VIOLATION');
    expect(result.reasons).toContain('LOT_VIOLATION');
  });

  it('reports a lot violation AND a minimum-notional breach together', () => {
    const result = validateOrder({
      request: order({ qty: '1' as never }),
      ...at(),
    });
    expect(result.reasons).toContain('LOT_VIOLATION');
    expect(result.reasons).toContain('BELOW_MIN_NOTIONAL');
  });
});

describe('market status', () => {
  const inStatus = (status: 'pre_open' | 'halted' | 'post_only') =>
    createMarket({
      cluster: 'devnet',
      symbol: 'SOL-USDC',
      baseAsset: 'devnet:SOL',
      quoteAsset: 'devnet:USDC',
      tickSize: '1000000',
      lotSize: '1000000',
      minNotional: '1000000',
      collarBps: 1000,
      status,
    });

  it('refuses a placement when the market is not open', () => {
    for (const status of ['pre_open', 'halted'] as const) {
      const result = validateOrder({
        request: order(),
        market: inStatus(status),
        reference: REF,
      });
      expect(result.reasons, status).toContain('MARKET_NOT_OPEN');
    }
  });

  it('accepts only post-only orders while the market is post_only', () => {
    const market = inStatus('post_only');
    expect(
      validateOrder({ request: order({ postOnly: false }), market, reference: REF }).reasons,
    ).toContain('MARKET_NOT_OPEN');
    expect(validateOrder({ request: order({ postOnly: true }), market, reference: REF }).ok).toBe(
      true,
    );
  });
});

describe('input coherence', () => {
  it('requires a price on a limit order and refuses one on a market order', () => {
    expect(validateOrder({ request: order({ price: null }), ...at() }).reasons).toContain(
      'PRICE_REQUIRED',
    );
    expect(validateOrder({ request: order({ type: 'market' }), ...at() }).reasons).toContain(
      'PRICE_NOT_ALLOWED',
    );
  });

  it('refuses post-only on anything but a limit order', () => {
    expect(
      validateOrder({
        request: order({ type: 'market', price: null, postOnly: true }),
        ...at(),
      }).reasons,
    ).toContain('POST_ONLY_REQUIRES_LIMIT');
  });

  it('refuses a non-positive quantity', () => {
    expect(validateOrder({ request: order({ qty: '0' as never }), ...at() }).reasons).toContain(
      'QUANTITY_NOT_POSITIVE',
    );
  });
});

describe('the collar', () => {
  it('accepts a price at either edge of the band', () => {
    // collarBps 1000 == 10%. 150e6 +/- 15e6.
    expect(validateOrder({ request: order({ price: '165000000' as never }), ...at() }).ok).toBe(
      true,
    );
    expect(validateOrder({ request: order({ price: '135000000' as never }), ...at() }).ok).toBe(
      true,
    );
  });

  it('refuses a price outside the band', () => {
    expect(
      validateOrder({ request: order({ price: '166000000' as never }), ...at() }).reasons,
    ).toContain('OUTSIDE_COLLAR');
    expect(
      validateOrder({ request: order({ price: '134000000' as never }), ...at() }).reasons,
    ).toContain('OUTSIDE_COLLAR');
  });

  // ADR-0027: an empty book has no opinion about what anything is worth.
  it('refuses a market order when the book has no reference price', () => {
    const result = validateOrder({
      request: order({ type: 'market', price: null }),
      ...at(null),
    });
    expect(result.reasons).toContain('NO_REFERENCE_PRICE');
    expect(result.ok).toBe(false);
  });

  it('does not judge a limit order against a collar that cannot be computed', () => {
    // There is nothing for it to be outside of. The order stands on its own price.
    const result = validateOrder({ request: order(), ...at(null) });
    expect(result.reasons).not.toContain('OUTSIDE_COLLAR');
    expect(result.band).toBeNull();
    expect(result.ok).toBe(true);
  });
});

describe('minimum notional', () => {
  // Checked against the TRUNCATED notional, so an order can never pass
  // validation at a value it will not settle at.
  it('is evaluated after truncation, not before', () => {
    const market = createMarket({
      cluster: 'devnet',
      symbol: 'SOL-USDC',
      baseAsset: 'devnet:SOL',
      quoteAsset: 'devnet:USDC',
      tickSize: '1',
      lotSize: '1',
      minNotional: '1',
      collarBps: 10_000,
      status: 'open',
    });
    // 1 * 999_999_999 / 1e9 truncates to 0, which is below a minimum of 1.
    const result = validateOrder({
      request: order({ price: '1' as never, qty: '999999999' as never }),
      market,
      reference: 1n,
    });
    expect(result.notional).toBe(0n);
    expect(result.reasons).toContain('BELOW_MIN_NOTIONAL');
  });
});

describe('notional overflow', () => {
  // Found by the property test, not by imagination. Price and quantity are each
  // bounded by u64 independently and their notional is not, so this reaches the
  // validator from input both schemas accept. It used to throw.
  const wide = createMarket({
    cluster: 'devnet',
    symbol: 'SOL-USDC',
    baseAsset: 'devnet:SOL',
    quoteAsset: 'devnet:USDC',
    tickSize: '1',
    lotSize: '1',
    minNotional: '1',
    collarBps: 10_000,
    status: 'open',
  });

  it('rejects rather than throwing when price * qty does not fit', () => {
    const request = order({ price: '10000000000000000000' as never, qty: '10000000000' as never });
    expect(() => validateOrder({ request, market: wide, reference: 10n ** 19n })).not.toThrow();
    const result = validateOrder({ request, market: wide, reference: 10n ** 19n });
    expect(result.reasons).toContain('NOTIONAL_OVERFLOW');
    expect(result.ok).toBe(false);
    expect(result.notional).toBeNull();
  });

  // A market buy reserves at the TOP of the collar band, which is strictly
  // above the reference it was judged at. Checking only the judged notional
  // would let an order pass validation and then fail to hold.
  it('rejects a market buy whose reserve overflows even though its notional does not', () => {
    const reference = 9_000_000_000_000_000_000n;
    const request = order({ side: 'buy', type: 'market', price: null, qty: '2000000000' as never });
    const judged = validateOrder({ request, market: wide, reference });
    expect(judged.reasons).toContain('NOTIONAL_OVERFLOW');
  });

  it('still accepts an order whose reserve fits', () => {
    const result = validateOrder({ request: order(), ...{ market: SOL_USDC, reference: REF } });
    expect(result.reasons).not.toContain('NOTIONAL_OVERFLOW');
    expect(result.ok).toBe(true);
  });
});
