import type { EventKey } from '@wallet/db';
import { parseEngineJson } from '../trading/engine-client.js';

/**
 * Engine events as SETTLEMENT reads them (ADR-0034 §§1, 8).
 *
 * The gateway has a tolerant decoder that drops what it does not recognise:
 * for the gateway, a dropped event costs a deferred resolution. Here it would
 * cost money. Settlement keys events by POSITION within their sequence, so one
 * dropped event shifts every key after it, and an unread fill is a fill never
 * settled. This decoder therefore accepts exactly the shapes the engine emits,
 * with every field present and typed, and throws on anything else. A throw is
 * a halt at that key — never a skip.
 */

export type SettlementEvent =
  | {
      readonly kind: 'fill';
      readonly seq: bigint;
      /** `seq:k`, k counting FILLS. Not the event key. */
      readonly fillId: string;
      readonly takerOrderId: string;
      readonly makerOrderId: string;
      readonly takerSide: 'buy' | 'sell';
      readonly price: bigint;
      readonly qty: bigint;
      /** The command's signed timestamp, journaled with it. */
      readonly timestampMs: bigint;
    }
  | { readonly kind: 'accepted'; readonly seq: bigint; readonly orderId: string; readonly restingQty: bigint }
  | { readonly kind: 'rejected'; readonly seq: bigint; readonly orderId: string; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly seq: bigint; readonly orderId: string; readonly remainingQty: bigint }
  | { readonly kind: 'expired'; readonly seq: bigint; readonly orderId: string; readonly remainingQty: bigint }
  | { readonly kind: 'status_changed'; readonly seq: bigint };

/** An event that cannot be read. Always a halt (prompt_phase_s4.md rule 43b). */
export class UndecodableEventError extends Error {
  constructor(readonly reason: string) {
    super(`undecodable engine event: ${reason}`);
    this.name = 'UndecodableEventError';
  }
}

function fail(reason: string): never {
  throw new UndecodableEventError(reason);
}

function integer(body: Record<string, unknown>, field: string, min = 0n): bigint {
  const value = body[field];
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^-?\d+$/.test(value)) parsed = BigInt(value);
  else fail(`${field} is not an integer`);
  if (parsed < min) fail(`${field} is below ${min.toString()}`);
  return parsed;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) fail(`${field} is not a non-empty string`);
  return value;
}

/** Decode one event, as the engine serialises it (`{"Fill": {...}}`). */
export function decodeSettlementEvent(raw: unknown): SettlementEvent {
  const value = typeof raw === 'string' ? parseEngineJson(raw) : raw;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('not an object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) fail('expected exactly one variant tag');
  const [tag, body] = entries[0] as [string, unknown];
  if (typeof body !== 'object' || body === null) fail(`${tag} has no body`);
  const b = body as Record<string, unknown>;
  const seq = integer(b, 'seq', 1n);

  switch (tag) {
    case 'Fill': {
      const side = b.taker_side;
      if (side !== 'buy' && side !== 'sell') fail('taker_side is not buy or sell');
      return {
        kind: 'fill',
        seq,
        fillId: text(b, 'fill_id'),
        takerOrderId: text(b, 'taker_order_id'),
        makerOrderId: text(b, 'maker_order_id'),
        takerSide: side,
        price: integer(b, 'price', 1n),
        qty: integer(b, 'qty', 1n),
        timestampMs: integer(b, 'timestamp_ms', -(2n ** 63n)),
      };
    }
    case 'Accepted':
      return {
        kind: 'accepted',
        seq,
        orderId: text(b, 'order_id'),
        restingQty: integer(b, 'resting_qty'),
      };
    case 'Rejected':
      return { kind: 'rejected', seq, orderId: text(b, 'order_id'), reason: text(b, 'reason') };
    case 'Cancelled':
      return {
        kind: 'cancelled',
        seq,
        orderId: text(b, 'order_id'),
        remainingQty: integer(b, 'remaining_qty'),
      };
    case 'Expired':
      return {
        kind: 'expired',
        seq,
        orderId: text(b, 'order_id'),
        remainingQty: integer(b, 'remaining_qty'),
      };
    case 'StatusChanged':
      return { kind: 'status_changed', seq };
    default:
      return fail(`unknown variant ${tag}`);
  }
}

/** A raw event and its key, as read from the stream or from re-emission. */
export interface KeyedRaw {
  readonly key: EventKey;
  readonly raw: unknown;
}

/**
 * Assign `(seq, idx)` by position, exactly as the engine does when it
 * publishes (ADR-0034 §1). The input must start at a sequence boundary, which
 * `GET /v1/events` guarantees: its pages end only at sequence boundaries.
 *
 * Reads only `seq`, so it works on events that will fail full decoding — the
 * halt must still name the right key.
 */
export function keyByPosition(raws: readonly unknown[]): KeyedRaw[] {
  const out: KeyedRaw[] = [];
  let previous: bigint | null = null;
  let idx = 0;
  for (const raw of raws) {
    const seq = seqOf(raw);
    idx = previous === seq ? idx + 1 : 0;
    previous = seq;
    out.push({ key: { seq, idx }, raw });
  }
  return out;
}

function seqOf(raw: unknown): bigint {
  const value = typeof raw === 'string' ? parseEngineJson(raw) : raw;
  if (typeof value !== 'object' || value === null) fail('not an object');
  const body = Object.values(value as Record<string, unknown>)[0];
  if (typeof body !== 'object' || body === null) fail('no body');
  return integer(body as Record<string, unknown>, 'seq', 1n);
}

/** Render a key for logs and metrics: carries no user, order, amount or price. */
export function formatKey(key: EventKey): string {
  return `${key.seq.toString()}:${String(key.idx)}`;
}
