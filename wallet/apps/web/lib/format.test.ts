import { describe, expect, it } from 'vitest';
import { formatAmount, isZeroAmount, parseAmount, shortenAddress } from './format';

describe('formatAmount', () => {
  it('renders lamports as SOL', () => {
    expect(formatAmount('1000000000', 9)).toBe('1');
    expect(formatAmount('1500000000', 9)).toBe('1.5');
    expect(formatAmount('1', 9)).toBe('0.000000001');
    expect(formatAmount('0', 9)).toBe('0');
  });

  it('groups the whole part', () => {
    expect(formatAmount('1234567000000000', 9)).toBe('1,234,567');
  });

  it('trims trailing zeros but keeps significant digits', () => {
    expect(formatAmount('1230000000', 9)).toBe('1.23');
    expect(formatAmount('1000000001', 9)).toBe('1.000000001');
  });

  it('handles values above 2^53 exactly', () => {
    // A number-based implementation would round this.
    expect(formatAmount('9007199254740993000000000', 9)).toBe('9,007,199,254,740,993');
  });

  it('handles negatives', () => {
    expect(formatAmount('-1500000000', 9)).toBe('-1.5');
  });

  it('handles zero decimals', () => {
    expect(formatAmount('42', 0)).toBe('42');
  });
});

describe('isZeroAmount', () => {
  it('recognises zero in any spelling', () => {
    expect(isZeroAmount('0')).toBe(true);
    expect(isZeroAmount('000')).toBe(true);
    expect(isZeroAmount('-0')).toBe(true);
    expect(isZeroAmount('1')).toBe(false);
  });
});

describe('shortenAddress', () => {
  it('shortens long addresses and leaves short ones alone', () => {
    expect(shortenAddress('So11111111111111111111111111111111111111112')).toBe('So1111…111112');
    expect(shortenAddress('short')).toBe('short');
  });
});

describe('parseAmount', () => {
  it("scales by the asset's own decimals", () => {
    expect(parseAmount('1', 9)).toEqual({ ok: true, baseUnits: '1000000000' });
    // The same string, a different asset. This is the whole reason the form
    // cannot hard-code nine.
    expect(parseAmount('1', 6)).toEqual({ ok: true, baseUnits: '1000000' });
    expect(parseAmount('1.5', 6)).toEqual({ ok: true, baseUnits: '1500000' });
    expect(parseAmount('.5', 6)).toEqual({ ok: true, baseUnits: '500000' });
    expect(parseAmount('  2.25  ', 6)).toEqual({ ok: true, baseUnits: '2250000' });
  });

  it('is exact where a float is not', () => {
    // 0.1 * 1e9 is 100000000.00000001 as a JS number.
    expect(parseAmount('0.1', 9)).toEqual({ ok: true, baseUnits: '100000000' });
    // Far above 2^53, which a number-based parse cannot represent.
    expect(parseAmount('9007199254740993', 9)).toEqual({
      ok: true,
      baseUnits: '9007199254740993000000000',
    });
  });

  it('round-trips through formatAmount', () => {
    for (const [value, decimals] of [
      ['1.5', 9],
      ['0.000001', 6],
      ['1,234,567', 9],
    ] as const) {
      const plain = value.replace(/,/g, '');
      const parsed = parseAmount(plain, decimals);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(formatAmount(parsed.baseUnits, decimals)).toBe(value);
    }
  });

  it('refuses more precision than the asset has, rather than rounding', () => {
    // Rounding would send an amount other than the one on screen.
    expect(parseAmount('1.0000001', 6)).toEqual({ ok: false, reason: 'too_precise' });
    expect(parseAmount('1.000000', 6)).toEqual({ ok: true, baseUnits: '1000000' });
  });

  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', '   ', 'abc', '1e9', '-1', '1.2.3', '.', '1,000']) {
      expect(parseAmount(bad, 9).ok).toBe(false);
    }
  });

  it('refuses zero', () => {
    expect(parseAmount('0', 9)).toEqual({ ok: false, reason: 'not_positive' });
    expect(parseAmount('0.000000000', 9)).toEqual({ ok: false, reason: 'not_positive' });
  });
});
