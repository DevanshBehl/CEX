import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  asPrice,
  asQty,
  BPS_DENOMINATOR,
  feeAmount,
  isMultipleOf,
  MAX_U64,
  notional,
  PRICE_SCALE,
  PRICE_SCALE_EXP,
  priceFromBigInt,
  priceSchema,
  qtyFromBigInt,
  qtySchema,
} from './price.js';

/**
 * The vectors are shared with `services/matching` and are the only thing that
 * permits the same arithmetic to exist in two languages (prompt_phase_s1.md
 * rules 76, 137). Both sides decode this file; neither side owns it.
 */
interface Vectors {
  readonly priceScaleExp: number;
  readonly priceScale: string;
  readonly bpsDenominator: string;
  readonly maxU64: string;
  readonly notional: ReadonlyArray<{ name: string; price: string; qty: string; expected: string }>;
  readonly notionalOverflow: ReadonlyArray<{ name: string; price: string; qty: string }>;
  readonly fee: ReadonlyArray<{ name: string; notional: string; bps: number; expected: string }>;
  readonly isMultipleOf: ReadonlyArray<{
    name: string;
    value: string;
    step: string;
    expected: boolean;
  }>;
}

const vectors: Vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../vectors/price-vectors.json', import.meta.url)),
    'utf8',
  ),
) as Vectors;

describe('shared vectors', () => {
  it('agrees with this package on the scale constants', () => {
    expect(vectors.priceScaleExp).toBe(PRICE_SCALE_EXP);
    expect(vectors.priceScale).toBe(PRICE_SCALE.toString());
    expect(vectors.bpsDenominator).toBe(BPS_DENOMINATOR.toString());
    expect(vectors.maxU64).toBe(MAX_U64.toString());
  });

  it.each(vectors.notional.map((v) => [v.name, v] as const))('notional: %s', (_name, v) => {
    expect(notional(BigInt(v.price), BigInt(v.qty)).toString()).toBe(v.expected);
  });

  it.each(vectors.notionalOverflow.map((v) => [v.name, v] as const))(
    'notional overflow: %s',
    (_name, v) => {
      expect(() => notional(BigInt(v.price), BigInt(v.qty))).toThrow(RangeError);
    },
  );

  it.each(vectors.fee.map((v) => [v.name, v] as const))('fee: %s', (_name, v) => {
    expect(feeAmount(BigInt(v.notional), v.bps).toString()).toBe(v.expected);
  });

  it.each(vectors.isMultipleOf.map((v) => [v.name, v] as const))('isMultipleOf: %s', (_name, v) => {
    expect(isMultipleOf(BigInt(v.value), BigInt(v.step))).toBe(v.expected);
  });
});

describe('notional', () => {
  it('truncates toward zero rather than rounding to nearest', () => {
    // 999_999_999 / 1e9 is 0.999999999. Nearest would be 1; the decision is floor.
    expect(notional(1n, 999_999_999n)).toBe(0n);
  });

  it('uses a full-width intermediate', () => {
    // The product here is ~1e23, which wraps in u64. If this ever returns a
    // small number, the Rust side has lost its u128 and this is the vector that
    // says so.
    expect(notional(150_000_000n, 1_000_000_000_000_000n)).toBe(150_000_000_000_000n);
  });

  it('refuses a result above u64 rather than wrapping', () => {
    expect(() => notional(10n ** 19n, 10n ** 10n)).toThrow(/exceeds u64/);
  });

  it('refuses negative operands', () => {
    expect(() => notional(-1n, 1n)).toThrow(RangeError);
    expect(() => notional(1n, -1n)).toThrow(RangeError);
  });

  it('is symmetric in its operands, which is what makes one truncation safe', () => {
    // Both legs of a fill use the identical result, so the only property that
    // matters is that there IS one result, not two.
    expect(notional(7n, 123_456_789n)).toBe(notional(123_456_789n, 7n));
  });
});

describe('feeAmount', () => {
  it('never exceeds the notional for a sane rate', () => {
    expect(feeAmount(1_000_000n, 20)).toBeLessThan(1_000_000n);
  });

  it('truncates toward zero, so a fee is never larger than the schedule says', () => {
    expect(feeAmount(4_999n, 20)).toBe(9n); // 9.998
  });

  it('refuses a negative or fractional rate', () => {
    expect(() => feeAmount(1n, -1)).toThrow(RangeError);
    expect(() => feeAmount(1n, 1.5)).toThrow(RangeError);
  });
});

describe('isMultipleOf', () => {
  it('refuses a non-positive step', () => {
    expect(() => isMultipleOf(10n, 0n)).toThrow(RangeError);
    expect(() => isMultipleOf(10n, -1n)).toThrow(RangeError);
  });
});

describe('branding', () => {
  it('accepts a well-formed integer string', () => {
    expect(asPrice('150000000')).toBe('150000000');
    expect(asQty('0')).toBe('0');
  });

  it('refuses anything that is not a non-negative integer string', () => {
    for (const bad of ['', '-1', '1.5', '01', ' 1', '1e9', 'abc', '+1']) {
      expect(() => asPrice(bad), bad).toThrow();
      expect(() => asQty(bad), bad).toThrow();
    }
  });

  it('refuses a value above u64', () => {
    expect(() => asPrice((MAX_U64 + 1n).toString())).toThrow(RangeError);
    expect(() => qtyFromBigInt(MAX_U64 + 1n)).toThrow(RangeError);
    expect(() => priceFromBigInt(-1n)).toThrow(RangeError);
  });

  // Regression: the bound check used to run even after the shape check failed,
  // so BigInt('1.5') threw out of safeParse. A validator that throws on bad
  // input is a 500 where a 400 belongs.
  it('never throws out of safeParse, whatever the input', () => {
    const junk = ['1.5', '-1', '', 'abc', '1e9', '0x10', ' 1 ', '1_000', '\u0661', 'Infinity'];
    for (const value of junk) {
      expect(() => priceSchema.safeParse(value), value).not.toThrow();
      expect(() => qtySchema.safeParse(value), value).not.toThrow();
      expect(priceSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('round-trips through the schemas', () => {
    expect(priceSchema.parse('150000000')).toBe('150000000');
    expect(qtySchema.parse('1000000000')).toBe('1000000000');
    expect(priceSchema.safeParse('-1').success).toBe(false);
    expect(qtySchema.safeParse((MAX_U64 + 1n).toString()).success).toBe(false);
  });
});
