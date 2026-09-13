import { describe, expect, it } from 'vitest';
import {
  assetKeyInCluster,
  chainId,
  clusterFromChainId,
  isTestCluster,
  ledgerAssetKey,
  parseLedgerAssetKey,
} from './clusters.js';

const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('ledger asset keys (ADR-0021)', () => {
  it('round-trips a native asset', () => {
    const key = ledgerAssetKey('devnet', 'SOL');
    expect(key).toBe('devnet:SOL');
    expect(parseLedgerAssetKey(key)).toEqual({ cluster: 'devnet', asset: 'SOL' });
  });

  it('round-trips a mint', () => {
    const key = ledgerAssetKey('mainnet-beta', USDC_MAINNET);
    expect(parseLedgerAssetKey(key)).toEqual({
      cluster: 'mainnet-beta',
      asset: USDC_MAINNET,
    });
  });

  it('KEEPS THE SAME ASSET ON TWO CLUSTERS APART', () => {
    // The whole reason this type exists. Without it both are `SOL`, the same
    // ledger account, and worthless testnet balances add to real ones while
    // every double-entry invariant still passes.
    expect(ledgerAssetKey('devnet', 'SOL')).not.toBe(ledgerAssetKey('mainnet-beta', 'SOL'));
  });

  it('keeps the same SYMBOL on two clusters apart, even as different mints', () => {
    // Devnet USDC and mainnet USDC are different mints AND different clusters.
    // Either dimension alone would separate them; both is correct.
    expect(ledgerAssetKey('devnet', USDC_DEVNET)).not.toBe(
      ledgerAssetKey('mainnet-beta', USDC_MAINNET),
    );
  });

  it('handles `mainnet-beta`, whose own name contains a hyphen', () => {
    // The separator is `:`, so a hyphenated cluster name is not a problem —
    // but it is the obvious place a naive split would break.
    expect(parseLedgerAssetKey('mainnet-beta:SOL').cluster).toBe('mainnet-beta');
  });

  it('splits on the FIRST separator only', () => {
    // Defensive: if an asset ever contained a colon, parsing must not silently
    // truncate it. The constructor refuses such an asset, and the parser is
    // written so the two agree.
    expect(parseLedgerAssetKey('devnet:a:b').asset).toBe('a:b');
  });

  it('refuses to construct a key from an asset containing the separator', () => {
    expect(() => ledgerAssetKey('devnet', 'a:b')).toThrow(/must not contain/);
  });

  it('refuses an unqualified asset', () => {
    // An asset that reached the ledger without a cluster is the bug this type
    // exists to make impossible; parsing must not quietly invent one.
    expect(() => parseLedgerAssetKey('SOL')).toThrow(/no cluster/);
  });

  it('refuses an unknown cluster', () => {
    expect(() => parseLedgerAssetKey('mainnet:SOL')).toThrow(/unknown cluster/);
  });

  it('refuses an empty asset', () => {
    expect(() => parseLedgerAssetKey('devnet:')).toThrow(/empty asset/);
  });

  it('tests membership without parsing', () => {
    const key = ledgerAssetKey('devnet', 'SOL');
    expect(assetKeyInCluster(key, 'devnet')).toBe(true);
    expect(assetKeyInCluster(key, 'mainnet-beta')).toBe(false);
  });

  it('does not confuse a cluster with a prefix of another', () => {
    // `devnet` is not a prefix of any other cluster today, but the check must
    // compare the separator too or a future `dev` cluster would match `devnet`.
    expect(assetKeyInCluster('devnetX:SOL', 'devnet')).toBe(false);
  });
});

describe('chain ids', () => {
  it('round-trips', () => {
    expect(chainId('devnet')).toBe('solana:devnet');
    expect(clusterFromChainId('solana:devnet')).toBe('devnet');
  });

  it('refuses the old unqualified chain id', () => {
    // Pre-ADR-0021 rows carry `solana`. They must be migrated, not silently
    // treated as some default cluster.
    expect(() => clusterFromChainId('solana')).toThrow(/not a cluster-qualified/);
  });
});

describe('test clusters', () => {
  it('knows which funds are worthless', () => {
    // Used to label simulated valuations. A devnet balance shown with a USD
    // figure and no qualification is a lie the interface tells.
    expect(isTestCluster('devnet')).toBe(true);
    expect(isTestCluster('testnet')).toBe(true);
    expect(isTestCluster('localnet')).toBe(true);
    expect(isTestCluster('mainnet-beta')).toBe(false);
  });
});
