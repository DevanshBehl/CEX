import { describe, expect, it } from 'vitest';
import type { MarketView } from '@wallet/types';
import { draftOrder, type DraftInput } from './order-draft';

const market = {
  symbol: 'SOL-USDC',
  baseAsset: 'SOL',
  quoteAsset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  baseSymbol: 'SOL',
  quoteSymbol: 'USDC',
  baseDecimals: 9,
  quoteDecimals: 6,
  tickSize: '10000',
  lotSize: '1000000',
  minNotional: '1000000',
  collarBps: 1_000,
  status: 'open',
  settlement: 'live',
  ticker: null,
} as unknown as MarketView;

const base: DraftInput = {
  cluster: 'devnet',
  market,
  side: 'buy',
  type: 'limit',
  timeInForce: 'GTC',
  postOnly: false,
  price: '150.25',
  qty: '1.5',
  reference: 150_000_000n,
};

describe('drafting an order', () => {
  it('turns what was typed into scaled integers, exactly', () => {
    const draft = draftOrder(base);
    expect(draft).toMatchObject({
      ok: true,
      body: {
        market: 'SOL-USDC',
        side: 'buy',
        type: 'limit',
        timeInForce: 'GTC',
        price: '150250000',
        qty: '1500000000',
        postOnly: false,
      },
    });
  });

  it('shows the hold the gateway will take: notional plus the worst-case fee for a buy', () => {
    const draft = draftOrder(base);
    if (!draft.ok) throw new Error('expected a draft');
    // 150.25 × 1.5 = 225.375 USDC; 20 bp of it is 0.45075.
    expect(draft.notional).toBe(225_375_000n);
    expect(draft.feeHeadroom).toBe(450_750n);
    expect(draft.hold).toEqual({ asset: 'quote', amount: 225_825_750n });
    expect(draft.estimatedFee).toBe(450_750n);
  });

  it('a sell holds the quantity itself, in the base asset, with no fee held', () => {
    const draft = draftOrder({ ...base, side: 'sell' });
    if (!draft.ok) throw new Error('expected a draft');
    expect(draft.hold).toEqual({ asset: 'base', amount: 1_500_000_000n });
    expect(draft.feeHeadroom).toBe(0n);
  });

  it('a market buy reserves at the TOP of the collar band, and is sent as IOC with no price', () => {
    const draft = draftOrder({ ...base, type: 'market', price: 'ignored', qty: '1' });
    if (!draft.ok) throw new Error('expected a draft');
    expect(draft.body).toMatchObject({ type: 'market', price: null, timeInForce: 'IOC' });
    // 10% above 150 is 165; plus 20 bp.
    expect(draft.hold.amount).toBe(165_000_000n + 330_000n);
  });

  it('a market order with no reference price cannot be sized, and says so', () => {
    const draft = draftOrder({ ...base, type: 'market', reference: null });
    expect(draft).toEqual({
      ok: false,
      errors: ['This market has no reference price yet, so a market order cannot be sized.'],
    });
  });

  it.each([
    [{ price: '150.255' }, /tick/],
    [{ qty: '1.0000001' }, /lots/],
    [{ qty: '0.001', price: '150' }, /minimum size/],
    [{ price: '200' }, /too far from the market/],
    [{ qty: '0' }, /greater than zero/],
  ])('refuses %o with a reason a person can act on', (change, message) => {
    const draft = draftOrder({ ...base, ...change });
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.errors.join(' ')).toMatch(message);
  });

  it.each([
    [{ price: '1e3' }, 'Price must be a number, with no signs or separators.'],
    [{ price: '' }, 'Price is required.'],
    [{ qty: '-1' }, 'Quantity must be a number, with no signs or separators.'],
    [{ qty: '1.0000000001' }, 'Quantity has more decimal places than this market allows.'],
    [{ price: '150.0000001' }, 'Price has more decimal places than this market allows.'],
  ])('refuses input it would have to guess at: %o', (change, message) => {
    expect(draftOrder({ ...base, ...change })).toEqual({ ok: false, errors: [message] });
  });

  it('reports every problem at once, not one per attempt', () => {
    const draft = draftOrder({ ...base, price: '150.255', qty: '1.0000001' });
    if (draft.ok) throw new Error('expected a refusal');
    expect(draft.errors).toHaveLength(2);
  });

  it('never lets a float in: prices a double cannot hold come through exactly', () => {
    const precise = { ...market, tickSize: '1', lotSize: '1', minNotional: '1' } as MarketView;
    const draft = draftOrder({
      ...base,
      market: precise,
      price: '0.300001',
      qty: '0.100000001',
      reference: null,
    });
    if (!draft.ok) throw new Error('expected a draft');
    expect(draft.body.price).toBe('300001');
    expect(draft.body.qty).toBe('100000001');
  });

  it('refuses a market that is not open', () => {
    const draft = draftOrder({ ...base, market: { ...market, status: 'halted' } as MarketView });
    expect(draft).toEqual({
      ok: false,
      errors: ['This market is not accepting orders right now.'],
    });
  });
});
