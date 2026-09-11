import { describe, expect, it } from 'vitest';
import { createAssetRegistry, IGNORED_REASONS, NATIVE_ASSET_KEY } from './assets.js';

const USDC = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };

describe('asset registry (ADR-0016)', () => {
  const registry = createAssetRegistry({ nativeDecimals: 9, tokens: [USDC] });

  it('allows the native asset and every allowlisted mint', () => {
    expect(registry.isAllowed(NATIVE_ASSET_KEY)).toBe(true);
    expect(registry.isAllowed(USDC.mint)).toBe(true);
  });

  it('rejects a mint that is not on the list', () => {
    expect(registry.isAllowed('So11111111111111111111111111111111111111112')).toBe(false);
  });

  it('does NOT resolve a token by its symbol', () => {
    // The whole point of ADR-0016: anyone can mint a token calling itself
    // USDC. If a symbol resolved here, allowlisting would be worthless.
    expect(registry.isAllowed('USDC')).toBe(false);
    expect(registry.token('USDC')).toBeUndefined();
  });

  it('treats the native asset as not-a-token', () => {
    expect(registry.isToken(NATIVE_ASSET_KEY)).toBe(false);
    expect(registry.isToken(USDC.mint)).toBe(true);
  });

  it('carries decimals for display and nothing else', () => {
    expect(registry.decimalsOf(USDC.mint)).toBe(6);
    expect(registry.decimalsOf(NATIVE_ASSET_KEY)).toBe(9);
  });

  it('falls back to the key when a symbol is unknown, rather than throwing', () => {
    // A ledger row for a de-allowlisted mint must still render.
    expect(registry.symbolOf('unknown-mint')).toBe('unknown-mint');
  });

  it('lists every creditable key with the native asset first', () => {
    expect(registry.keys).toEqual([NATIVE_ASSET_KEY, USDC.mint]);
  });

  it('is empty of tokens when none are configured', () => {
    const solOnly = createAssetRegistry({ nativeDecimals: 9, tokens: [] });
    expect(solOnly.keys).toEqual([NATIVE_ASSET_KEY]);
    expect(solOnly.isAllowed(USDC.mint)).toBe(false);
  });

  it('names a reason for every way a transfer can be declined', () => {
    expect(Object.values(IGNORED_REASONS)).toContain('mint_not_allowlisted');
  });
});
