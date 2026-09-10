import { describe, expect, it } from 'vitest';
import { asBaseUnits, baseUnitsSchema } from './money.js';

describe('BaseUnits', () => {
  it('accepts integer strings', () => {
    expect(asBaseUnits('0')).toBe('0');
    expect(asBaseUnits('1000000000')).toBe('1000000000');
    expect(asBaseUnits('-42')).toBe('-42');
  });

  it('rejects anything that would lose precision or sneak in a float', () => {
    for (const bad of ['1.5', '1e9', '0x10', '', ' 1', '01', 'NaN', 'Infinity']) {
      expect(() => asBaseUnits(bad)).toThrow();
    }
  });

  it('rejects values a JS number would have mangled', () => {
    // 2^53 + 1 — not representable as a double, must survive as a string.
    const big = '9007199254740993';
    expect(asBaseUnits(big)).toBe(big);
    expect(String(Number(big))).not.toBe(big);
  });

  it('parses through the schema', () => {
    expect(baseUnitsSchema.parse('123')).toBe('123');
    expect(baseUnitsSchema.safeParse('1.0').success).toBe(false);
  });
});
