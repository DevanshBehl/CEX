import { describe, expect, it } from 'vitest';
import { decodeSettlementEvent, keyByPosition, UndecodableEventError } from './events.js';

const fill = {
  Fill: {
    fill_id: '7:0',
    seq: 7,
    taker_order_id: 't',
    maker_order_id: 'm',
    taker_side: 'buy',
    price: 150_000_000,
    qty: 1_000_000,
    timestamp_ms: 1_700_000_000_000,
    maker_fee: null,
    taker_fee: null,
  },
};

describe('the settlement decoder', () => {
  it('reads every event the engine emits, timestamp included', () => {
    const event = decodeSettlementEvent(fill);
    expect(event).toMatchObject({
      kind: 'fill',
      seq: 7n,
      fillId: '7:0',
      takerSide: 'buy',
      timestampMs: 1_700_000_000_000n,
    });
    expect(decodeSettlementEvent({ Accepted: { seq: 1, order_id: 'o', resting_qty: 0 } })).toEqual({
      kind: 'accepted',
      seq: 1n,
      orderId: 'o',
      restingQty: 0n,
    });
    expect(
      decodeSettlementEvent({ StatusChanged: { seq: 2, previous: 'open', current: 'halted' } }),
    ).toEqual({ kind: 'status_changed', seq: 2n });
  });

  it('reads integers above 2^53 exactly, from the engine JSON text', () => {
    const text =
      '{"Fill":{"fill_id":"7:0","seq":7,"taker_order_id":"t","maker_order_id":"m",' +
      '"taker_side":"sell","price":99999999999999999,"qty":1,"timestamp_ms":1}}';
    const event = decodeSettlementEvent(text);
    expect(event.kind === 'fill' && event.price).toBe(99_999_999_999_999_999n);
  });

  // The gateway's decoder drops these. Settlement must halt on them instead:
  // a dropped event shifts every later key and loses a fill (rule 43b).
  it.each([
    ['an unknown variant', { Liquidated: { seq: 1 } }],
    ['two tags', { Accepted: { seq: 1 }, Rejected: { seq: 1 } }],
    ['a missing field', { Fill: { ...fill.Fill, timestamp_ms: undefined } }],
    ['an unknown side', { Fill: { ...fill.Fill, taker_side: 'short' } }],
    ['a zero quantity', { Fill: { ...fill.Fill, qty: 0 } }],
    ['a fractional number', { Fill: { ...fill.Fill, price: 1.5 } }],
    ['a sequence of zero', { Accepted: { seq: 0, order_id: 'o', resting_qty: 1 } }],
    ['not an object', 'null'],
  ])('throws on %s, never skips', (_name, raw) => {
    expect(() => decodeSettlementEvent(raw)).toThrow(UndecodableEventError);
  });
});

describe('keys by position', () => {
  it('restarts idx at each new sequence', () => {
    const keys = keyByPosition([
      { Accepted: { seq: 3 } },
      { Cancelled: { seq: 4 } },
      { Fill: { seq: 4 } },
      { Fill: { seq: 4 } },
      { Accepted: { seq: 5 } },
    ]).map((k) => `${k.key.seq.toString()}:${String(k.key.idx)}`);
    expect(keys).toEqual(['3:0', '4:0', '4:1', '4:2', '5:0']);
  });
});
