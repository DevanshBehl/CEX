import { describe, expect, it } from 'vitest';
import {
  createMarket,
  marketId,
  parseMarketId,
  PLACEABLE_STATUSES,
  type MarketDefinition,
} from './market.js';

const SOL_USDC: MarketDefinition = {
  cluster: 'devnet',
  symbol: 'SOL-USDC',
  baseAsset: 'devnet:SOL',
  quoteAsset: 'devnet:USDC',
  tickSize: '1000000',
  lotSize: '1000000',
  minNotional: '1000000',
  collarBps: 1000,
  status: 'open',
};

describe('market id', () => {
  it('is cluster-qualified', () => {
    expect(marketId('devnet', 'SOL-USDC')).toBe('devnet:SOL-USDC');
    expect(parseMarketId('devnet:SOL-USDC')).toEqual({ cluster: 'devnet', symbol: 'SOL-USDC' });
  });

  it('refuses a symbol that is not BASE-QUOTE in uppercase', () => {
    for (const bad of ['sol-usdc', 'SOLUSDC', 'SOL_USDC', 'SOL-', '-USDC', 'SOL-USDC-EXTRA']) {
      expect(() => marketId('devnet', bad), bad).toThrow(TypeError);
    }
  });

  it('refuses an id that is not cluster-qualified or has an unknown cluster', () => {
    for (const bad of ['SOL-USDC', ':SOL-USDC', 'mainnet:SOL-USDC', 'devnet:solusdc']) {
      expect(() => parseMarketId(bad), bad).toThrow(TypeError);
    }
  });
});

describe('createMarket', () => {
  it('builds a coherent market and freezes it', () => {
    const market = createMarket(SOL_USDC);
    expect(market.id).toBe('devnet:SOL-USDC');
    expect(market.minNotional).toBe(1_000_000n);
    expect(Object.isFrozen(market)).toBe(true);
  });

  it('defaults to pre_open, so a new market never trades by accident', () => {
    const { status: _status, ...withoutStatus } = SOL_USDC;
    expect(createMarket(withoutStatus).status).toBe('pre_open');
  });

  // ADR-0021: refused at construction, not at use — the same reason
  // buildTransaction refuses a cross-cluster ledger transaction.
  it('refuses a market that spans clusters', () => {
    expect(() => createMarket({ ...SOL_USDC, quoteAsset: 'mainnet-beta:USDC' })).toThrow(
      /spans clusters/,
    );
    expect(() =>
      createMarket({ ...SOL_USDC, cluster: 'localnet', baseAsset: 'devnet:SOL' }),
    ).toThrow(/spans clusters/);
  });

  it('refuses a market whose base and quote are the same asset', () => {
    expect(() => createMarket({ ...SOL_USDC, quoteAsset: 'devnet:SOL' })).toThrow(
      /same base and quote/,
    );
  });

  it('refuses a non-positive tick, lot, minimum notional or collar', () => {
    expect(() => createMarket({ ...SOL_USDC, tickSize: '0' })).toThrow(/tickSize/);
    expect(() => createMarket({ ...SOL_USDC, lotSize: '0' })).toThrow(/lotSize/);
    expect(() => createMarket({ ...SOL_USDC, minNotional: '0' })).toThrow(/minNotional/);
    expect(() => createMarket({ ...SOL_USDC, collarBps: 0 })).toThrow(/collarBps/);
    expect(() => createMarket({ ...SOL_USDC, collarBps: 1.5 })).toThrow(/collarBps/);
  });
});

describe('status', () => {
  // ADR-0027: a halt stops price formation; it does not take away the exit.
  // Cancellation is handled outside this set precisely so halted can reject a
  // placement without trapping a resting order.
  it('permits placement only when open or post_only', () => {
    expect(PLACEABLE_STATUSES.has('open')).toBe(true);
    expect(PLACEABLE_STATUSES.has('post_only')).toBe(true);
    expect(PLACEABLE_STATUSES.has('halted')).toBe(false);
    expect(PLACEABLE_STATUSES.has('pre_open')).toBe(false);
  });
});
