import { describe, expect, it } from 'vitest';
import { createAssetRegistry, IGNORED_REASONS, NATIVE_ASSET_KEY } from './assets.js';
import { ledgerAssetKey } from './clusters.js';

const USDC = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };

/** A registry speaks in ledger asset keys, which are cluster-qualified. */
const key = (asset: string): string => ledgerAssetKey('devnet', asset);
const SOL = key(NATIVE_ASSET_KEY);
const USDC_KEY = key(USDC.mint);

describe('asset registry (ADR-0016)', () => {
  const registry = createAssetRegistry({ cluster: 'devnet', nativeDecimals: 9, tokens: [USDC] });

  it('allows the native asset and every allowlisted mint', () => {
    expect(registry.isAllowed(SOL)).toBe(true);
    expect(registry.isAllowed(USDC_KEY)).toBe(true);
  });

  it('DOES NOT allow the same mint from another cluster (ADR-0021)', () => {
    // The mint address is identical; the asset is not. A devnet faucet USDC
    // crediting a mainnet balance is the failure this prevents.
    expect(registry.isAllowed(ledgerAssetKey('mainnet-beta', USDC.mint))).toBe(false);
    expect(registry.isAllowed(ledgerAssetKey('mainnet-beta', NATIVE_ASSET_KEY))).toBe(false);
  });

  it('refuses an unqualified key, which would belong to every cluster at once', () => {
    expect(registry.isAllowed(NATIVE_ASSET_KEY)).toBe(false);
    expect(registry.isAllowed(USDC.mint)).toBe(false);
  });

  it('rejects a mint that is not on the list', () => {
    expect(registry.isAllowed('So11111111111111111111111111111111111111112')).toBe(false);
  });

  it('does NOT resolve a token by its symbol', () => {
    // The whole point of ADR-0016: anyone can mint a token calling itself
    // USDC. If a symbol resolved here, allowlisting would be worthless.
    expect(registry.isAllowed(key('USDC'))).toBe(false);
    expect(registry.token(key('USDC'))).toBeUndefined();
  });

  it('treats the native asset as not-a-token', () => {
    expect(registry.isToken(SOL)).toBe(false);
    expect(registry.isToken(USDC_KEY)).toBe(true);
  });

  it('carries decimals for display and nothing else', () => {
    expect(registry.decimalsOf(USDC_KEY)).toBe(6);
    expect(registry.decimalsOf(SOL)).toBe(9);
  });

  it('falls back to the key when a symbol is unknown, rather than throwing', () => {
    // A ledger row for a de-allowlisted mint must still render.
    expect(registry.symbolOf(key('unknown-mint'))).toBe(key('unknown-mint'));
  });

  it('lists every creditable key with the native asset first', () => {
    expect(registry.keys).toEqual([SOL, USDC_KEY]);
  });

  it('is empty of tokens when none are configured', () => {
    const solOnly = createAssetRegistry({ cluster: 'devnet', nativeDecimals: 9, tokens: [] });
    expect(solOnly.keys).toEqual([SOL]);
    expect(solOnly.isAllowed(USDC_KEY)).toBe(false);
  });

  it('names a reason for every way a transfer can be declined', () => {
    expect(Object.values(IGNORED_REASONS)).toContain('mint_not_allowlisted');
  });
});
