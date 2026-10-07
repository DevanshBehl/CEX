import { z } from 'zod';
import { baseUnitsSchema } from '../money.js';
import { assetSchema } from './custody.js';
import { MARKET_STATUSES } from '../market.js';
import { ORDER_SIDES, ORDER_TYPES, TIME_IN_FORCE } from '../orders.js';
import { ORDER_STATUSES } from '../order-states.js';
import { priceSchema, qtySchema } from '../price.js';

/**
 * The trading surface (prompt_phase_s3.md §§9, 11, 15).
 *
 * The wire speaks BARE assets and BARE market symbols — `SOL-USDC`, never
 * `devnet:SOL-USDC`. The cluster comes from the request's context, never the
 * body, exactly as it does for withdrawals (ADR-0021): a client that could name
 * the cluster in a payload could ask for another cluster's market.
 */

export const marketSymbolSchema = z
  .string()
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/, 'market must be BASE-QUOTE in uppercase');

/**
 * The 24-hour ticker (ADR-0036 §7). Defined here, beside the market it
 * describes, because a market view carries one.
 */
export const tickerSchema = z
  .object({
    market: marketSymbolSchema,
    /** The most recent trade EVER, or null for a market that never traded. */
    lastPrice: priceSchema.nullable(),
    lastTradeTime: z.string().datetime().nullable(),
    /** Null when nothing traded in the window. Never zero: zero is a price. */
    open24h: priceSchema.nullable(),
    high24h: priceSchema.nullable(),
    low24h: priceSchema.nullable(),
    baseVolume24h: baseUnitsSchema,
    quoteVolume24h: baseUnitsSchema,
  })
  .strict();
export type TickerView = z.infer<typeof tickerSchema>;

/**
 * Whether fills in this market are reaching the ledger — coarse, on purpose.
 *
 *   live      settlement is applying events as they arrive
 *   delayed   it is behind the engine; fills will settle, later
 *   halted    it stopped at an event it could not settle and needs a person
 *   disabled  this deployment does not settle: fills move no balance
 *
 * The halted event and its reason are for operators only.
 */
export const SETTLEMENT_STATES = ['live', 'delayed', 'halted', 'disabled'] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

export const marketSchema = z.object({
  symbol: marketSymbolSchema,
  baseAsset: assetSchema,
  quoteAsset: assetSchema,
  baseSymbol: z.string(),
  quoteSymbol: z.string(),
  baseDecimals: z.number().int().min(0).max(32),
  quoteDecimals: z.number().int().min(0).max(32),
  /** Scaled price units (ADR-0026). */
  tickSize: priceSchema,
  lotSize: qtySchema,
  minNotional: baseUnitsSchema,
  collarBps: z.number().int().positive(),
  status: z.enum(MARKET_STATUSES),
  settlement: z.enum(SETTLEMENT_STATES),
  /** Null when this deployment records no market data. */
  ticker: tickerSchema.nullable(),
});
export type MarketView = z.infer<typeof marketSchema>;

export const listMarketsResponseSchema = z.object({ markets: z.array(marketSchema) });
export type ListMarketsResponse = z.infer<typeof listMarketsResponseSchema>;

/**
 * A CLEARING-tier balance. Distinct from the wallet balance, which is the vault
 * tier: a trading balance sits at the clearing address, not the user's own, and
 * the wallet cannot send it.
 */
export const tradingBalanceSchema = z.object({
  asset: assetSchema,
  symbol: z.string(),
  decimals: z.number().int().min(0).max(32),
  available: baseUnitsSchema,
  /** Order holds plus pending deallocations. */
  locked: baseUnitsSchema,
  total: baseUnitsSchema,
});
export type TradingBalance = z.infer<typeof tradingBalanceSchema>;

export const listTradingBalancesResponseSchema = z.object({
  balances: z.array(tradingBalanceSchema),
});
export type ListTradingBalancesResponse = z.infer<typeof listTradingBalancesResponseSchema>;

export const placeOrderSchema = z.object({
  market: marketSymbolSchema,
  side: z.enum(ORDER_SIDES),
  type: z.enum(ORDER_TYPES),
  timeInForce: z.enum(TIME_IN_FORCE),
  /** Required for a limit order, absent for a market order. */
  price: priceSchema.nullable(),
  qty: qtySchema,
  postOnly: z.boolean().default(false),
  /**
   * Client-supplied and unique per user: a resubmission after a network failure
   * is the SAME order, not a second one with a second hold.
   */
  clientOrderId: z.string().min(8).max(128),
});
export type PlaceOrderRequest = z.infer<typeof placeOrderSchema>;

export const amendOrderSchema = z.object({
  /** The REPLACEMENT order's own idempotency key. An amend places a new order. */
  clientOrderId: z.string().min(8).max(128),
  price: priceSchema,
  qty: qtySchema,
});
export type AmendOrderRequest = z.infer<typeof amendOrderSchema>;

export const orderSchema = z.object({
  id: z.string(),
  clientOrderId: z.string(),
  market: marketSymbolSchema,
  side: z.enum(ORDER_SIDES),
  type: z.enum(ORDER_TYPES),
  timeInForce: z.enum(TIME_IN_FORCE),
  postOnly: z.boolean(),
  price: priceSchema.nullable(),
  qty: qtySchema,
  filledQty: qtySchema,
  status: z.enum(ORDER_STATUSES),
  holdAsset: assetSchema,
  /** The hold as posted. What is still held is a ledger projection. */
  holdAmount: baseUnitsSchema,
  holdsFunds: z.boolean(),
  isTerminal: z.boolean(),
  /** Generic. Never a risk code or an engine reject reason (ADR-0033). */
  statusDetail: z.string(),
  createdAt: z.string().datetime(),
});
export type OrderView = z.infer<typeof orderSchema>;

export const orderResponseSchema = z.object({ order: orderSchema });
export type OrderResponse = z.infer<typeof orderResponseSchema>;

export const listOrdersResponseSchema = z.object({
  orders: z.array(orderSchema),
  /** Pass as `before` for the next page. Null when this was the last. */
  nextBefore: z.string().nullable(),
});

export const listOrdersQuerySchema = z.object({
  market: marketSymbolSchema.optional(),
  /** `open` is what rests or is in flight; `all` is the history. */
  status: z.enum(['open', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().max(128).optional(),
});
export type ListOrdersResponse = z.infer<typeof listOrdersResponseSchema>;

export const cancelAllResponseSchema = z.object({
  /** One entry per order a cancel was attempted for. */
  orders: z.array(orderSchema),
});
export type CancelAllResponse = z.infer<typeof cancelAllResponseSchema>;

/**
 * Moving funds between tiers. An allocation IS a withdrawal whose destination
 * came from configuration (ADR-0017) — so there is no destination field, and
 * the response is the withdrawal it created.
 */
export const allocationRequestSchema = z.object({
  asset: assetSchema,
  amount: baseUnitsSchema,
  idempotencyKey: z.string().min(8).max(128),
});
export type AllocationRequest = z.infer<typeof allocationRequestSchema>;
