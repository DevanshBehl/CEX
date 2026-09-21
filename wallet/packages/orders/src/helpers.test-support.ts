import { createMarket, type Market, type OrderRequest } from '@wallet/types';

export const SOL_USDC: Market = createMarket({
  cluster: 'devnet',
  symbol: 'SOL-USDC',
  baseAsset: 'devnet:SOL',
  quoteAsset: 'devnet:USDC',
  // 0.001 USDC per SOL, in scaled price units.
  tickSize: '1000000',
  // 0.001 SOL.
  lotSize: '1000000',
  // 1 USDC.
  minNotional: '1000000',
  collarBps: 1000,
  status: 'open',
});

/** 150 USDC per SOL, scaled (ADR-0026's worked example). */
export const REF = 150_000_000n;

export function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    clientOrderId: 'client-order-0001',
    market: 'devnet:SOL-USDC',
    side: 'buy',
    type: 'limit',
    timeInForce: 'GTC',
    price: '150000000' as OrderRequest['price'],
    qty: '1000000000' as OrderRequest['qty'],
    postOnly: false,
    stpMode: 'cancel_taker',
    accountId: 'user-1',
    ...overrides,
  };
}
