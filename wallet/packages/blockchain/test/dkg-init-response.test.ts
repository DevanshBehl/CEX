import { describe, expect, it } from 'vitest';
import { dkgIdempotencyKey, parseDkgInitResponse } from '../src/index.js';

/**
 * The API records a user's address on the strength of this response
 * (ADR-0023). Anything short of a complete, finalized DKG result must be
 * refused here rather than written to the database.
 */
const hex = (byte: string): string => byte.repeat(64);

function valid(): Record<string, unknown> {
  return {
    keyRef: 'user:alice',
    groupPublicKey: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    participants: 5,
    threshold: 3,
    existing: false,
    generation: 'dkg',
    publicPackageHash: hex('a'),
    verifyingShares: Object.fromEntries(
      [1, 2, 3, 4, 5].map((i) => [`0${i}`.padEnd(64, '0'), hex(String(i))]),
    ),
  };
}

describe('parseDkgInitResponse', () => {
  it('accepts a finalized ceremony and carries its public metadata', () => {
    const parsed = parseDkgInitResponse('user:alice', valid());
    expect(parsed.address).toBe('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
    expect(parsed.generation).toBe('dkg');
    expect(Object.keys(parsed.verifyingShares ?? {})).toHaveLength(5);
    expect(parsed.publicPackageHash).toBe(hex('a'));
  });

  it.each([
    ['a dealer-era or unknown generation', { generation: 'dealer' }],
    ['a result for a different key', { keyRef: 'user:bob' }],
    ['a missing verification share', { verifyingShares: { [hex('0')]: hex('1') } }],
    [
      'a malformed verification share',
      {
        verifyingShares: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [hex(String(i)), 'zz'])),
      },
    ],
    ['a non-address group key', { groupPublicKey: 'not an address!' }],
    ['a missing package hash', { publicPackageHash: undefined }],
    ['nonsense threshold parameters', { threshold: 6 }],
  ])('refuses %s', (_label, override) => {
    expect(() => parseDkgInitResponse('user:alice', { ...valid(), ...override })).toThrow(
      /incomplete DKG result/,
    );
  });

  it('refuses a non-object', () => {
    expect(() => parseDkgInitResponse('user:alice', null)).toThrow();
  });
});

describe('dkgIdempotencyKey', () => {
  it('is stable per key reference, distinct across them, and within the service limit', () => {
    expect(dkgIdempotencyKey('user:alice')).toBe(dkgIdempotencyKey('user:alice'));
    expect(dkgIdempotencyKey('user:alice')).not.toBe(dkgIdempotencyKey('user:bob'));
    expect(dkgIdempotencyKey('user:' + 'x'.repeat(250)).length).toBeLessThanOrEqual(128);
  });
});
