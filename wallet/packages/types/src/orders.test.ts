import { describe, expect, it } from 'vitest';
import {
  fillId,
  orderRequestSchema,
  REJECT_REASONS,
  TERMINAL_EVENT_KINDS,
  type RejectReason,
} from './orders.js';

describe('reject reasons', () => {
  // Append-only, exactly as packages/risk's REASON_CODES is. A code that was
  // persisted years ago must still mean what it meant then.
  it('has no duplicates', () => {
    expect(new Set(REJECT_REASONS).size).toBe(REJECT_REASONS.length);
  });

  it('carries the reasons the engine and the validator each need', () => {
    const required: RejectReason[] = [
      'UNKNOWN_MARKET',
      'MARKET_NOT_OPEN',
      'NO_REFERENCE_PRICE',
      'TICK_VIOLATION',
      'LOT_VIOLATION',
      'BELOW_MIN_NOTIONAL',
      'OUTSIDE_COLLAR',
      'POST_ONLY_WOULD_CROSS',
      'SELF_TRADE_PREVENTED',
      'UNKNOWN_ORDER',
    ];
    for (const code of required) expect(REJECT_REASONS).toContain(code);
  });
});

describe('fillId', () => {
  // Deterministic so a replay produces the same ids, which is what makes S4's
  // settlement idempotency key stable across one.
  it('is a pure function of the sequence and the index', () => {
    expect(fillId(42, 0)).toBe('42:0');
    expect(fillId(42, 1)).toBe('42:1');
    expect(fillId(42, 0)).toBe(fillId(42, 0));
  });

  it('is unique per (seq, index) pair', () => {
    const ids = new Set<string>();
    for (let seq = 0; seq < 20; seq += 1) {
      for (let i = 0; i < 5; i += 1) ids.add(fillId(seq, i));
    }
    expect(ids.size).toBe(100);
  });
});

describe('terminal events', () => {
  // In S3 each of these releases a hold. An accepted or filled order still
  // holds; a rejected, cancelled or expired one does not.
  it('covers exactly the events after which no reservation remains', () => {
    expect([...TERMINAL_EVENT_KINDS].sort()).toEqual(['cancelled', 'expired', 'rejected']);
    expect(TERMINAL_EVENT_KINDS.has('fill')).toBe(false);
    expect(TERMINAL_EVENT_KINDS.has('accepted')).toBe(false);
  });
});

describe('orderRequestSchema', () => {
  const valid = {
    clientOrderId: 'client-order-0001',
    market: 'devnet:SOL-USDC',
    side: 'buy' as const,
    type: 'limit' as const,
    timeInForce: 'GTC' as const,
    price: '150000000',
    qty: '1000000000',
    postOnly: false,
    stpMode: 'cancel_taker' as const,
    accountId: 'user-1',
  };

  it('accepts a well-formed limit order', () => {
    expect(orderRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a market order with no price', () => {
    expect(orderRequestSchema.safeParse({ ...valid, type: 'market', price: null }).success).toBe(
      true,
    );
  });

  it('refuses a float or a negative for price or quantity', () => {
    expect(orderRequestSchema.safeParse({ ...valid, price: '150000000.5' }).success).toBe(false);
    expect(orderRequestSchema.safeParse({ ...valid, qty: '-1' }).success).toBe(false);
    expect(orderRequestSchema.safeParse({ ...valid, qty: '1e9' }).success).toBe(false);
  });

  it('refuses a client order id too short to be idempotent', () => {
    expect(orderRequestSchema.safeParse({ ...valid, clientOrderId: 'abc' }).success).toBe(false);
  });
});
