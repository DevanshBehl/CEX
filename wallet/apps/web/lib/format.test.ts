import { describe, expect, it } from 'vitest';
import { formatAmount, isZeroAmount, shortenAddress } from './format';

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
