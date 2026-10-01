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

export const listOrdersResponseSchema = z.object({ orders: z.array(orderSchema) });
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
