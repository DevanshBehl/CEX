import { describe, expect, it } from 'vitest';
import {
  formatDecimal,
  formatScaledPrice,
  parseDecimal,
  parseHumanPrice,
  priceDecimals,
} from './decimal.js';
import { MAX_U64 } from './price.js';

const SOL_USDC = { baseDecimals: 9, quoteDecimals: 6 };

describe('parseDecimal', () => {
  it.each([
    ['150.25', 6, 150_250_000n],
    ['150', 6, 150_000_000n],
    ['0.000001', 6, 1n],
    ['.5', 6, 500_000n],
    ['5.', 6, 5_000_000n],
    ['  1.5  ', 6, 1_500_000n],
    ['007', 0, 7n],
    ['0', 9, 0n],
    // Trailing zeros past the precision are the same number.
    ['1.5000000000', 6, 1_500_000n],
  ])('%s at %i decimals', (input, decimals, expected) => {
    expect(parseDecimal(input, decimals)).toEqual({ ok: true, value: expected });
  });

  // The cases a double gets wrong. None of these reaches a `number`.
  it.each([
    ['0.1', 18, 100_000_000_000_000_000n],
    ['0.3', 18, 300_000_000_000_000_000n],
    ['1.005', 3, 1_005n],
    ['9007199254740993', 0, 9_007_199_254_740_993n],
    ['4.35', 2, 435n],
    ['1.15', 2, 115n],
  ])('is exact where a float is not: %s', (input, decimals, expected) => {
    expect(parseDecimal(input, decimals)).toEqual({ ok: true, value: expected });
  });

  it('refuses a digit it would have to round away', () => {
    expect(parseDecimal('1.0000001', 6)).toEqual({ ok: false, reason: 'too_precise' });
    expect(parseDecimal('0.5', 0)).toEqual({ ok: false, reason: 'too_precise' });
  });

  it.each(['', '   '])('reports empty input as empty: "%s"', (input) => {
    expect(parseDecimal(input, 6)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each(['-1', '+1', '1e3', '1,000', '1.2.3', 'abc', '.', '0x10', '1 000', 'NaN', 'Infinity'])(
    'refuses %s',
    (input) => {
      expect(parseDecimal(input, 6)).toEqual({ ok: false, reason: 'malformed' });
    },
  );

  it('bounds the result at u64, exactly', () => {
    expect(parseDecimal(MAX_U64.toString(), 0)).toEqual({ ok: true, value: MAX_U64 });
    expect(parseDecimal((MAX_U64 + 1n).toString(), 0)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('formatDecimal', () => {
  it.each([
    [150_250_000n, 6, '150.25'],
    [150_000_000n, 6, '150'],
    [1n, 6, '0.000001'],
    [0n, 6, '0'],
    [7n, 0, '7'],
    [-1_500_000n, 6, '-1.5'],
    [9_007_199_254_740_993n, 0, '9007199254740993'],
  ])('%s at %i decimals', (value, decimals, expected) => {
    expect(formatDecimal(value, decimals)).toBe(expected);
  });

  it('pads to a minimum number of fraction digits', () => {
    expect(formatDecimal(150_000_000n, 6, 2)).toBe('150.00');
    expect(formatDecimal(150_250_000n, 6, 2)).toBe('150.25');
    expect(formatDecimal(150_123_400n, 6, 2)).toBe('150.1234');
  });

  it('round-trips with parseDecimal', () => {
    for (const value of [0n, 1n, 999_999n, 1_000_000n, 123_456_789_012n, MAX_U64]) {
      const parsed = parseDecimal(formatDecimal(value, 6), 6);
      expect(parsed).toEqual({ ok: true, value });
    }
  });
});

describe('a price in a market', () => {
  it('SOL/USDC has six price decimals: the worked example in ADR-0026', () => {
    expect(priceDecimals(SOL_USDC)).toBe(6);
    expect(parseHumanPrice('150', SOL_USDC)).toEqual({ ok: true, value: 150_000_000n });
    expect(formatScaledPrice(150_000_000n, SOL_USDC, 2)).toBe('150.00');
  });

  it('follows the decimals of both assets', () => {
    // A 6-decimal base against a 6-decimal quote: one whole per whole is 1e9.
    expect(priceDecimals({ baseDecimals: 6, quoteDecimals: 6 })).toBe(9);
    expect(parseHumanPrice('1', { baseDecimals: 6, quoteDecimals: 6 })).toEqual({
      ok: true,
      value: 1_000_000_000n,
    });
  });

  it('refuses a market the scale cannot price rather than mispricing it', () => {
    expect(() => priceDecimals({ baseDecimals: 18, quoteDecimals: 6 })).toThrow(RangeError);
  });
});
