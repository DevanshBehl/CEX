import { z } from 'zod';
import { clusterSchema } from '../clusters.js';
import { baseUnitsSchema } from '../money.js';
import { ORDER_SIDES } from '../orders.js';
import { priceSchema, qtySchema } from '../price.js';
import { marketSymbolSchema, orderSchema, tickerSchema } from './trading.js';

/**
 * Market data: the REST views and every WebSocket message, in both directions
 * (ADR-0036, ADR-0037).
 *
 * One file, used by the server that builds a message and the client that
 * parses it, so the two cannot disagree about a field.
 *
 * Every schema here is `.strict()`. A public message is built field by field
 * from an allowlist, and a strict schema is what makes "this message cannot
 * carry an order id or a user id" a property a test can assert rather than a
 * habit: a field that is not named below does not parse.
 *
 * Prices, quantities, amounts and sequences are STRINGS. A `u64` in a JSON
 * number is corrupted above 2^53 before any code sees it.
 */

/** An engine sequence, as a decimal string. */
export const sequenceSchema = z.string().regex(/^\d+$/, 'sequence must be an integer string');

/** A level's total resting quantity. Wider than one order's: a sum of `u64`s. */
export const levelQtySchema = z.string().regex(/^\d+$/, 'quantity must be an integer string');

// --- Book --------------------------------------------------------------------

/** `[price, total quantity]`. */
export const bookLevelSchema = z.tuple([priceSchema, levelQtySchema]);
export type BookLevelView = z.infer<typeof bookLevelSchema>;

/** `[side, price, total quantity NOW]`. Zero means the level is gone. */
export const levelChangeSchema = z.tuple([z.enum(ORDER_SIDES), priceSchema, levelQtySchema]);
export type LevelChangeView = z.infer<typeof levelChangeSchema>;

export const bookSnapshotSchema = z
  .object({
    market: marketSymbolSchema,
    /** The engine sequence this book reflects. */
    seq: sequenceSchema,
    /** Best first: bids descending, asks ascending. */
    bids: z.array(bookLevelSchema),
    asks: z.array(bookLevelSchema),
    /** True when the book is deeper than the server sends (ADR-0037 §6). */
    truncated: z.boolean(),
  })
  .strict();
export type BookSnapshotView = z.infer<typeof bookSnapshotSchema>;

// --- Trades ------------------------------------------------------------------

/**
 * A public trade. No order id, no user id, no fee — there is no field for one.
 */
export const tradeSchema = z
  .object({
    /** The engine's fill id, `seq:k`. Unique within a market. */
    id: z.string().regex(/^\d+:\d+$/),
    seq: sequenceSchema,
    price: priceSchema,
    qty: qtySchema,
    /** The side that crossed the spread. */
    takerSide: z.enum(ORDER_SIDES),
    /** The command's signed time. NOT monotonic in sequence order. */
    time: z.string().datetime(),
  })
  .strict();
export type TradeView = z.infer<typeof tradeSchema>;

export const listTradesResponseSchema = z
  .object({
    trades: z.array(tradeSchema),
    /** Pass as `before` for the next page. Null when there is none. */
    nextBefore: z.string().nullable(),
  })
  .strict();
export type ListTradesResponse = z.infer<typeof listTradesResponseSchema>;

// --- Candles and ticker ------------------------------------------------------

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const CANDLE_INTERVAL_SECONDS: Readonly<Record<CandleInterval, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

export const candleSchema = z
  .object({
    /** Bucket start, UTC. */
    time: z.string().datetime(),
    open: priceSchema,
    high: priceSchema,
    low: priceSchema,
    close: priceSchema,
    baseVolume: baseUnitsSchema,
    quoteVolume: baseUnitsSchema,
    trades: z.number().int().nonnegative(),
  })
  .strict();
export type CandleView = z.infer<typeof candleSchema>;

/**
 * Only buckets that HAD a trade. A gap is a gap: the client carries the
 * previous close forward to draw it (ADR-0036 §6).
 */
export const listCandlesResponseSchema = z
  .object({ interval: z.enum(CANDLE_INTERVALS), candles: z.array(candleSchema) })
  .strict();
export type ListCandlesResponse = z.infer<typeof listCandlesResponseSchema>;

export const tickerResponseSchema = z.object({ ticker: tickerSchema }).strict();
export type TickerResponse = z.infer<typeof tickerResponseSchema>;

export const bookResponseSchema = z.object({ book: bookSnapshotSchema }).strict();
export type BookResponse = z.infer<typeof bookResponseSchema>;

// --- REST query strings --------------------------------------------------------

/** Every limit has a maximum enforced HERE. Every list is bounded. */
export const listTradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** A trade id, `seq:k`: return trades strictly older than it. */
  before: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional(),
});

export const listCandlesQuerySchema = z.object({
  interval: z.enum(CANDLE_INTERVALS).default('1m'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const listFillsQuerySchema = z.object({
  market: marketSymbolSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(128).optional(),
});

export const marketParamSchema = z.object({ symbol: marketSymbolSchema });

/** What an operator reads when a market stops settling (prompt_phase_s5.md rule 191). */
export const consumerStatusSchema = z.object({
  market: marketSymbolSchema,
  /** The last event key applied, `seq:idx`. Null before anything was. */
  offset: z.string().nullable(),
  /** Engine sequences not yet applied. Null when the engine could not be asked. */
  lag: z.number().int().nullable(),
  halted: z.object({ key: z.string(), reason: z.string() }).nullable(),
});

export const pipelineStatusResponseSchema = z.object({
  settlement: z.array(consumerStatusSchema),
  marketData: z.array(consumerStatusSchema),
});
export type PipelineStatusResponse = z.infer<typeof pipelineStatusResponseSchema>;

// --- The caller's own fills ---------------------------------------------------

/**
 * ONE SIDE of a fill: the caller's. Never the counterparty's user, order or
 * fee — there is no field for them.
 */
export const userFillSchema = z
  .object({
    /** The engine's fill id, `seq:k`. */
    id: z.string(),
    market: marketSymbolSchema,
    orderId: z.string(),
    side: z.enum(ORDER_SIDES),
    role: z.enum(['maker', 'taker']),
    price: priceSchema,
    qty: qtySchema,
    /** Quote base units. */
    notional: baseUnitsSchema,
    /** Quote base units, as recorded at settlement. */
    fee: baseUnitsSchema,
    feeBps: z.number().int().nonnegative(),
    time: z.string().datetime(),
  })
  .strict();
export type UserFillView = z.infer<typeof userFillSchema>;

export const listFillsResponseSchema = z
  .object({ fills: z.array(userFillSchema), nextBefore: z.string().nullable() })
  .strict();
export type ListFillsResponse = z.infer<typeof listFillsResponseSchema>;

// --- WebSocket: client to server ----------------------------------------------

export const WS_PUBLIC_CHANNELS = ['book', 'trades', 'ticker'] as const;
export const WS_PRIVATE_CHANNELS = ['account'] as const;
export const WS_CHANNELS = [...WS_PUBLIC_CHANNELS, ...WS_PRIVATE_CHANNELS] as const;
export type WsChannel = (typeof WS_CHANNELS)[number];

const subscriptionFields = {
  channel: z.enum(WS_CHANNELS),
  /**
   * REQUIRED, and never defaulted. A browser cannot set `X-Solana-Cluster` on
   * a handshake, and a socket that fell back to a default would serve one
   * cluster's market to a client that believes it is on another.
   */
  cluster: clusterSchema,
  /** Required for `book`, `trades` and `ticker`. Absent for `account`. */
  market: marketSymbolSchema.optional(),
};

/** The three things a client may send. Anything else closes the socket. */
export const wsClientMessageSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subscribe'), ...subscriptionFields }).strict(),
  z.object({ op: z.literal('unsubscribe'), ...subscriptionFields }).strict(),
  z.object({ op: z.literal('pong') }).strict(),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

// --- WebSocket: server to client ----------------------------------------------

const scope = { cluster: clusterSchema, market: marketSymbolSchema };

export const wsBookSnapshotMessageSchema = z
  .object({
    type: z.literal('book.snapshot'),
    ...scope,
    seq: sequenceSchema,
    bids: z.array(bookLevelSchema),
    asks: z.array(bookLevelSchema),
    truncated: z.boolean(),
  })
  .strict();

/**
 * One per engine sequence — INCLUDING sequences that changed nothing, so the
 * client's whole gap test is `seq === last + 1`.
 */
export const wsBookDeltaMessageSchema = z
  .object({
    type: z.literal('book.delta'),
    ...scope,
    seq: sequenceSchema,
    changes: z.array(levelChangeSchema),
  })
  .strict();

/** The server cannot vouch for its book. Nothing follows until a snapshot. */
export const wsBookResyncMessageSchema = z
  .object({ type: z.literal('book.resync'), ...scope })
  .strict();

export const wsTradesSnapshotMessageSchema = z
  .object({ type: z.literal('trades.snapshot'), ...scope, trades: z.array(tradeSchema) })
  .strict();

export const wsTradeMessageSchema = z
  .object({ type: z.literal('trade'), ...scope, trade: tradeSchema })
  .strict();

export const wsTickerMessageSchema = z
  .object({ type: z.literal('ticker'), cluster: clusterSchema, ticker: tickerSchema })
  .strict();

/** The caller's own order, whole. Applying it is replacement. */
export const wsOrderMessageSchema = z
  .object({ type: z.literal('order'), cluster: clusterSchema, order: orderSchema })
  .strict();

export const wsFillMessageSchema = z
  .object({ type: z.literal('fill'), cluster: clusterSchema, fill: userFillSchema })
  .strict();

/**
 * Not a number. The client refetches `GET /trading/balances`: the browser
 * never computes a balance, and this channel is not where one comes from.
 */
export const wsBalancesChangedMessageSchema = z
  .object({ type: z.literal('balances.changed'), cluster: clusterSchema })
  .strict();

export const wsSubscribedMessageSchema = z
  .object({
    type: z.literal('subscribed'),
    channel: z.enum(WS_CHANNELS),
    cluster: clusterSchema,
    market: marketSymbolSchema.optional(),
  })
  .strict();

export const wsUnsubscribedMessageSchema = z
  .object({
    type: z.literal('unsubscribed'),
    channel: z.enum(WS_CHANNELS),
    cluster: clusterSchema,
    market: marketSymbolSchema.optional(),
  })
  .strict();

export const WS_ERROR_CODES = [
  'invalid_message',
  'unknown_cluster',
  'cluster_not_served',
  'unknown_market',
  'market_required',
  'not_subscribed',
  'unavailable',
] as const;

/** A refused request. Generic by contract: a code, never a reason with data in it. */
export const wsErrorMessageSchema = z
  .object({ type: z.literal('error'), code: z.enum(WS_ERROR_CODES) })
  .strict();

export const wsPingMessageSchema = z.object({ type: z.literal('ping') }).strict();

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsBookSnapshotMessageSchema,
  wsBookDeltaMessageSchema,
  wsBookResyncMessageSchema,
  wsTradesSnapshotMessageSchema,
  wsTradeMessageSchema,
  wsTickerMessageSchema,
  wsOrderMessageSchema,
  wsFillMessageSchema,
  wsBalancesChangedMessageSchema,
  wsSubscribedMessageSchema,
  wsUnsubscribedMessageSchema,
  wsErrorMessageSchema,
  wsPingMessageSchema,
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

/** Every message a subscriber of a PUBLIC channel can receive. */
export const WS_PUBLIC_MESSAGE_SCHEMAS = [
  wsBookSnapshotMessageSchema,
  wsBookDeltaMessageSchema,
  wsBookResyncMessageSchema,
  wsTradesSnapshotMessageSchema,
  wsTradeMessageSchema,
  wsTickerMessageSchema,
] as const;

/**
 * Application close codes (ADR-0037 §4). In the range a browser hands to
 * `onclose` unchanged.
 */
export const WS_CLOSE = {
  /** The server is going away. Reconnect. */
  goingAway: 1001,
  /** A message that is not one of the three a client may send. */
  protocolError: 4400,
  /** The session ended. Do NOT reconnect: sign in. */
  sessionEnded: 4401,
  /** Not reading fast enough, or missed heartbeats. Reconnect and resnapshot. */
  slowConsumer: 4408,
  /** A bound in ADR-0037 §4 was exceeded. */
  limitExceeded: 4409,
} as const;
