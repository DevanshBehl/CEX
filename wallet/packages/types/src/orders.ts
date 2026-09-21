import { z } from 'zod';
import type { Brand } from './brands.js';
import { priceSchema, qtySchema, type Price, type Qty } from './price.js';
import type { BaseUnits } from './money.js';

/**
 * The order and execution contracts (ADR-0025, ADR-0029).
 *
 * Written BEFORE any Rust, from what settlement will need — not from what the
 * engine finds convenient to emit. An event shape that omits which side was the
 * taker is discovered in S4, when settlement cannot attribute a fee, and by then
 * the engine, its journal format and every golden vector encode the mistake
 * (prompt_phase_s1.md rules 14-15).
 */

export type OrderId = Brand<string, 'OrderId'>;
export const asOrderId = (v: string): OrderId => v as OrderId;

export const ORDER_SIDES = ['buy', 'sell'] as const;
export type Side = (typeof ORDER_SIDES)[number];
export const sideSchema = z.enum(ORDER_SIDES);

export const ORDER_TYPES = ['limit', 'market'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const orderTypeSchema = z.enum(ORDER_TYPES);

export const TIME_IN_FORCE = [
  /** Rests until cancelled. */
  'GTC',
  /** Takes what is available immediately; the remainder is cancelled, not rested. */
  'IOC',
  /** Fills entirely or not at all. */
  'FOK',
] as const;
export type TimeInForce = (typeof TIME_IN_FORCE)[number];
export const timeInForceSchema = z.enum(TIME_IN_FORCE);

/**
 * Self-trade prevention, an ENGINE policy — deciding it needs the book.
 *
 * Every mode emits an event for whatever it cancelled or refused. In S3 each of
 * those events releases a hold, and an outcome with no event is money reserved
 * forever (prompt_phase_s1.md rules 99-100).
 */
export const STP_MODES = ['cancel_taker', 'cancel_maker', 'cancel_both'] as const;
export type StpMode = (typeof STP_MODES)[number];
export const stpModeSchema = z.enum(STP_MODES);

/**
 * Reject reasons.
 *
 * APPEND-ONLY, exactly as `REASON_CODES` in `packages/risk` is: never remove a
 * code and never repurpose one, because persisted rejections still carry them
 * and must still mean what they meant then.
 */
export const REJECT_REASONS = [
  // --- market ---
  'UNKNOWN_MARKET',
  'MARKET_NOT_OPEN',
  /**
   * A market order against a book with no trade history and no two-sided quote.
   *
   * An empty book has no opinion about what anything is worth, and a market
   * order is a request to trade at whatever the market says. When the market
   * says nothing, the honest answer is a rejection (ADR-0027).
   */
  'NO_REFERENCE_PRICE',

  // --- structure ---
  'TICK_VIOLATION',
  'LOT_VIOLATION',
  'BELOW_MIN_NOTIONAL',
  'OUTSIDE_COLLAR',
  /**
   * `price * qty / PRICE_SCALE` does not fit u64, or the reserve it implies
   * does not.
   *
   * Reachable from input both schemas accept: price and quantity are each
   * bounded by u64 independently, and their notional is not. Found by the
   * property test in `packages/orders`, where it arrived as a thrown
   * RangeError — a 500 where a 400 belongs.
   */
  'NOTIONAL_OVERFLOW',

  // --- input ---
  'QUANTITY_NOT_POSITIVE',
  'PRICE_REQUIRED',
  'PRICE_NOT_ALLOWED',
  'POST_ONLY_REQUIRES_LIMIT',
  'DUPLICATE_CLIENT_ORDER_ID',

  // --- book ---
  'POST_ONLY_WOULD_CROSS',
  'SELF_TRADE_PREVENTED',
  'UNKNOWN_ORDER',
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];
export const rejectReasonSchema = z.enum(REJECT_REASONS);

export interface OrderRequest {
  readonly clientOrderId: string;
  readonly market: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  /** Absent for a market order; required for a limit order. */
  readonly price: Price | null;
  readonly qty: Qty;
  readonly postOnly: boolean;
  readonly stpMode: StpMode;
  /** Who placed it. The engine uses it only for self-trade prevention. */
  readonly accountId: string;
}

export const orderRequestSchema = z.object({
  clientOrderId: z.string().min(8).max(128),
  market: z.string().min(3).max(64),
  side: sideSchema,
  type: orderTypeSchema,
  timeInForce: timeInForceSchema,
  price: priceSchema.nullable(),
  qty: qtySchema,
  postOnly: z.boolean(),
  stpMode: stpModeSchema,
  accountId: z.string().min(1).max(128),
});

/**
 * What the engine consumes.
 *
 * The sequence and the timestamp are SUPPLIED BY THE CALLER, never read. The
 * engine does not own a clock (ADR-0028): a fill's timestamp is the timestamp of
 * the command that caused it, journaled with it, and therefore reproduced
 * exactly by a replay.
 */
export type EngineCommand =
  | {
      readonly kind: 'place';
      readonly seq: number;
      readonly timestampMs: number;
      readonly orderId: OrderId;
      readonly request: OrderRequest;
    }
  | {
      readonly kind: 'cancel';
      readonly seq: number;
      readonly timestampMs: number;
      readonly orderId: OrderId;
    }
  | {
      readonly kind: 'amend';
      readonly seq: number;
      readonly timestampMs: number;
      readonly orderId: OrderId;
      readonly newOrderId: OrderId;
      readonly price: Price;
      readonly qty: Qty;
    };

/**
 * A fill.
 *
 * `takerSide` is not derivable from anything else in this event and settlement
 * needs it to attribute the taker fee (ADR-0029). The fee fields are carried and
 * left null until S4, because adding them later would invalidate every journal
 * and every golden vector written before them.
 */
export interface Fill {
  readonly fillId: string;
  readonly market: string;
  readonly seq: number;
  readonly takerOrderId: OrderId;
  readonly makerOrderId: OrderId;
  readonly takerSide: Side;
  readonly price: Price;
  readonly qty: Qty;
  readonly timestampMs: number;
  /** Quote base units. Populated in S4. */
  readonly makerFee: BaseUnits | null;
  readonly takerFee: BaseUnits | null;
}

/**
 * Deterministic fill id: the engine sequence and the index of the fill within
 * that command's output.
 *
 * Deterministic so a replay produces the same ids, which is what makes S4's
 * settlement idempotency key stable across one (prompt_phase_s1.md rule 53).
 */
export function fillId(seq: number, index: number): string {
  return `${seq}:${index}`;
}

export type EngineEvent =
  | {
      readonly kind: 'accepted';
      readonly seq: number;
      readonly orderId: OrderId;
      readonly restingQty: Qty;
    }
  | {
      readonly kind: 'rejected';
      readonly seq: number;
      readonly orderId: OrderId;
      readonly reason: RejectReason;
    }
  | ({ readonly kind: 'fill' } & Fill)
  | {
      readonly kind: 'cancelled';
      readonly seq: number;
      readonly orderId: OrderId;
      readonly remainingQty: Qty;
    }
  | {
      readonly kind: 'expired';
      readonly seq: number;
      readonly orderId: OrderId;
      readonly remainingQty: Qty;
    };

/** Events after which an order holds no further reservation. S3 releases on these. */
export const TERMINAL_EVENT_KINDS: ReadonlySet<EngineEvent['kind']> = new Set([
  'rejected',
  'cancelled',
  'expired',
]);
