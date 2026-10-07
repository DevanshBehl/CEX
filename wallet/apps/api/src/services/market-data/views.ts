import type { CandleRecord, TickerRecord, TradeRecord, UserFillRecord } from '@wallet/db';
import type {
  BookLevelView,
  CandleView,
  LevelChangeView,
  TickerView,
  TradeView,
  UserFillView,
} from '@wallet/types';
import type { BookLevel, LevelChange } from './book-mirror.js';
import type { PublicTrade } from './fanout.js';

/**
 * What leaves the building (prompt_phase_s5.md rules 29, 111).
 *
 * Every view here is BUILT, field by field, from an allowlist. Nothing is
 * spread, nothing is forwarded: an engine event carries order ids, and a
 * `fills` row carries the counterparty's user id, order id and fee. A function
 * that names every field it copies cannot leak one it did not name.
 */

const price = (value: bigint) => value.toString() as TradeView['price'];
const qty = (value: bigint) => value.toString() as TradeView['qty'];
const amount = (value: bigint) => value.toString() as CandleView['baseVolume'];

export const toBookLevel = (level: BookLevel): BookLevelView => [
  price(level.price),
  level.qty.toString(),
];

export const toLevelChange = (change: LevelChange): LevelChangeView => [
  change.side,
  price(change.price),
  change.qty.toString(),
];

/** From the live stream. */
export function tradeFromFanout(trade: PublicTrade): TradeView {
  return {
    id: trade.id,
    seq: trade.seq.toString(),
    price: price(trade.price),
    qty: qty(trade.qty),
    takerSide: trade.takerSide,
    time: new Date(Number(trade.timestampMs)).toISOString(),
  };
}

/** From the `trades` table. The same shape, by construction the same fields. */
export function tradeFromRecord(trade: TradeRecord): TradeView {
  return {
    id: `${trade.seq.toString()}:${String(trade.fillIndex)}`,
    seq: trade.seq.toString(),
    price: price(trade.price),
    qty: qty(trade.qty),
    takerSide: trade.takerSide,
    time: trade.engineTimestamp.toISOString(),
  };
}

export function toCandleView(candle: CandleRecord): CandleView {
  return {
    time: candle.bucketStart.toISOString(),
    open: price(candle.open),
    high: price(candle.high),
    low: price(candle.low),
    close: price(candle.close),
    baseVolume: amount(candle.baseVolume),
    quoteVolume: amount(candle.quoteVolume),
    trades: candle.tradeCount,
  };
}

export function toTickerView(symbol: string, ticker: TickerRecord): TickerView {
  return {
    market: symbol,
    // Null, never zero: zero is a price (ADR-0036 §7).
    lastPrice: ticker.last ? price(ticker.last.price) : null,
    lastTradeTime: ticker.last ? ticker.last.engineTimestamp.toISOString() : null,
    open24h: ticker.window ? price(ticker.window.open) : null,
    high24h: ticker.window ? price(ticker.window.high) : null,
    low24h: ticker.window ? price(ticker.window.low) : null,
    baseVolume24h: amount(ticker.window?.baseVolume ?? 0n),
    quoteVolume24h: amount(ticker.window?.quoteVolume ?? 0n),
  };
}

/** The caller's OWN side. The record it is built from has no other. */
export function toUserFillView(fill: UserFillRecord): UserFillView {
  return {
    id: fill.fillId,
    market: fill.market.slice(fill.market.indexOf(':') + 1),
    orderId: fill.orderId,
    side: fill.side,
    role: fill.role,
    price: price(fill.price),
    qty: qty(fill.qty),
    notional: amount(fill.notional),
    fee: amount(fill.fee),
    feeBps: fill.feeBps,
    time: fill.engineTimestamp.toISOString(),
  };
}
