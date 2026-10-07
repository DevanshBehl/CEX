import { Prisma } from '@prisma/client';
import type { Executor } from '../transaction.js';

/**
 * Public market data (ADR-0036): the trade tape, and candles derived from it.
 *
 * Nothing in this file reads `fills`, `orders` or any table that names a user.
 * That is the point of it being its own repository: public data has no query
 * that could return private data, rather than a serializer trusted to drop it.
 */

export interface InsertTradeInput {
  readonly market: string;
  readonly seq: bigint;
  /** `k` in the engine's fill id `seq:k`. */
  readonly fillIndex: number;
  readonly price: bigint;
  readonly qty: bigint;
  /** `notional(price, qty)`: computed once, by the caller, in integers. */
  readonly quoteQty: bigint;
  readonly takerSide: 'buy' | 'sell';
  readonly engineTimestamp: Date;
}

export interface TradeRecord {
  readonly market: string;
  readonly seq: bigint;
  readonly fillIndex: number;
  readonly price: bigint;
  readonly qty: bigint;
  readonly takerSide: 'buy' | 'sell';
  readonly engineTimestamp: Date;
}

export interface CandleRecord {
  readonly bucketStart: Date;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly baseVolume: bigint;
  readonly quoteVolume: bigint;
  readonly tradeCount: number;
}

export interface TickerRecord {
  /** The most recent trade ever, by `(seq, fill_index)`. Null if none. */
  readonly last: { readonly price: bigint; readonly engineTimestamp: Date } | null;
  /** Null when nothing traded in the window. */
  readonly window: {
    readonly open: bigint;
    readonly high: bigint;
    readonly low: bigint;
    readonly baseVolume: bigint;
    readonly quoteVolume: bigint;
  } | null;
}

export interface MarketDataRepository {
  /**
   * Record a trade, or learn it was already recorded. The constraint decides,
   * never a read beforehand: delivery is at-least-once.
   */
  insertTrade(input: InsertTradeInput, tx?: Executor): Promise<boolean>;

  /**
   * Recompute the one-minute candle a timestamp falls in, from that bucket's
   * trades. An UPSERT, not an append: a trade can land in a bucket that is no
   * longer the latest, because engine timestamps are not monotonic.
   */
  recomputeCandle(market: string, at: Date, tx?: Executor): Promise<void>;

  /** Drop and recompute every candle of a market. Must reproduce the table. */
  rebuildCandles(market: string, tx?: Executor): Promise<number>;

  /** Newest first, by `(seq, fill_index)`. */
  listTrades(
    market: string,
    limit: number,
    before?: { readonly seq: bigint; readonly fillIndex: number },
    tx?: Executor,
  ): Promise<TradeRecord[]>;

  /**
   * Candles at any interval, oldest first, aggregated from the one-minute
   * rows. Only buckets that had a trade.
   */
  listCandles(
    market: string,
    intervalSeconds: number,
    from: Date,
    to: Date,
    limit: number,
    tx?: Executor,
  ): Promise<CandleRecord[]>;

  /**
   * The same candles computed DIRECTLY from trades. For the test that proves
   * `listCandles` agrees with it; nothing serves from this.
   */
  candlesFromTrades(
    market: string,
    intervalSeconds: number,
    from: Date,
    to: Date,
    tx?: Executor,
  ): Promise<CandleRecord[]>;

  /** The window is `[now − 24h, now)`, at one-minute resolution. */
  ticker(market: string, now: Date, tx?: Executor): Promise<TickerRecord>;
}

const EPOCH = Prisma.sql`TIMESTAMPTZ '1970-01-01 00:00:00+00'`;

interface CandleRow {
  bucket_start: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  base_volume: string;
  quote_volume: string;
  trade_count: number;
}

const toCandle = (row: CandleRow): CandleRecord => ({
  bucketStart: row.bucket_start,
  open: BigInt(row.open),
  high: BigInt(row.high),
  low: BigInt(row.low),
  close: BigInt(row.close),
  baseVolume: BigInt(row.base_volume),
  quoteVolume: BigInt(row.quote_volume),
  tradeCount: row.trade_count,
});

/**
 * One-minute candles for the trades matched by `where`.
 *
 * Open and close are picked by `(seq, fill_index)` — engine order — and NEVER
 * by timestamp, which decides only which bucket a trade is in.
 */
const candlesOf = (where: Prisma.Sql) => Prisma.sql`
  SELECT
    market,
    date_bin('1 minute', engine_timestamp, ${EPOCH}) AS bucket_start,
    (array_agg(price ORDER BY seq ASC,  fill_index ASC))[1]  AS open,
    MAX(price) AS high,
    MIN(price) AS low,
    (array_agg(price ORDER BY seq DESC, fill_index DESC))[1] AS close,
    MIN(seq) AS open_seq,
    (array_agg(fill_index ORDER BY seq ASC,  fill_index ASC))[1]  AS open_index,
    MAX(seq) AS close_seq,
    (array_agg(fill_index ORDER BY seq DESC, fill_index DESC))[1] AS close_index,
    SUM(qty) AS base_volume,
    SUM(quote_qty) AS quote_volume,
    COUNT(*)::int AS trade_count
  FROM trades
  WHERE ${where}
  GROUP BY market, date_bin('1 minute', engine_timestamp, ${EPOCH})
`;

const UPSERT = Prisma.sql`
  ON CONFLICT (market, bucket_start) DO UPDATE SET
    open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
    open_seq = EXCLUDED.open_seq, open_index = EXCLUDED.open_index,
    close_seq = EXCLUDED.close_seq, close_index = EXCLUDED.close_index,
    base_volume = EXCLUDED.base_volume, quote_volume = EXCLUDED.quote_volume,
    trade_count = EXCLUDED.trade_count
`;

const COLUMNS = Prisma.sql`
  (market, bucket_start, open, high, low, close, open_seq, open_index, close_seq, close_index,
   base_volume, quote_volume, trade_count)
`;

export function createMarketDataRepository(db: Executor): MarketDataRepository {
  const exec = (tx?: Executor) => tx ?? db;

  return {
    async insertTrade(input, tx) {
      const rows = await exec(tx).$queryRaw<Array<{ seq: bigint }>>`
        INSERT INTO trades
          (market, seq, fill_index, price, qty, quote_qty, taker_side, engine_timestamp, created_at)
        VALUES (
          ${input.market}, ${input.seq}, ${input.fillIndex},
          ${new Prisma.Decimal(input.price.toString())},
          ${new Prisma.Decimal(input.qty.toString())},
          ${new Prisma.Decimal(input.quoteQty.toString())},
          ${input.takerSide}::"OrderSide", ${input.engineTimestamp}, now()
        )
        ON CONFLICT (market, seq, fill_index) DO NOTHING
        RETURNING seq
      `;
      return rows.length > 0;
    },

    async recomputeCandle(market, at, tx) {
      const bucket = Prisma.sql`date_bin('1 minute', ${at}::timestamptz, ${EPOCH})`;
      await exec(tx).$executeRaw`
        INSERT INTO candles ${COLUMNS}
        ${candlesOf(Prisma.sql`
          market = ${market}
          AND engine_timestamp >= ${bucket}
          AND engine_timestamp <  ${bucket} + interval '1 minute'
        `)}
        ${UPSERT}
      `;
    },

    async rebuildCandles(market, tx) {
      const e = exec(tx);
      await e.$executeRaw`DELETE FROM candles WHERE market = ${market}`;
      return e.$executeRaw`
        INSERT INTO candles ${COLUMNS}
        ${candlesOf(Prisma.sql`market = ${market}`)}
      `;
    },

    async listTrades(market, limit, before, tx) {
      const cursor = before
        ? Prisma.sql`AND (seq, fill_index) < (${before.seq}, ${before.fillIndex})`
        : Prisma.empty;
      const rows = await exec(tx).$queryRaw<
        Array<{
          seq: bigint;
          fill_index: number;
          price: string;
          qty: string;
          taker_side: 'buy' | 'sell';
          engine_timestamp: Date;
        }>
      >`
        SELECT seq, fill_index, price::text AS price, qty::text AS qty,
               taker_side::text AS taker_side, engine_timestamp
        FROM trades
        WHERE market = ${market} ${cursor}
        ORDER BY seq DESC, fill_index DESC
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        market,
        seq: row.seq,
        fillIndex: row.fill_index,
        price: BigInt(row.price),
        qty: BigInt(row.qty),
        takerSide: row.taker_side,
        engineTimestamp: row.engine_timestamp,
      }));
    },

    async listCandles(market, intervalSeconds, from, to, limit, tx) {
      const width = Prisma.sql`make_interval(secs => ${intervalSeconds})`;
      // The newest `limit` buckets in range, returned oldest first.
      const rows = await exec(tx).$queryRaw<CandleRow[]>`
        SELECT * FROM (
          SELECT
            date_bin(${width}, bucket_start, ${EPOCH}) AS bucket_start,
            (array_agg(open  ORDER BY open_seq ASC,   open_index ASC))[1]::text   AS open,
            MAX(high)::text AS high,
            MIN(low)::text  AS low,
            (array_agg(close ORDER BY close_seq DESC, close_index DESC))[1]::text AS close,
            SUM(base_volume)::text  AS base_volume,
            SUM(quote_volume)::text AS quote_volume,
            SUM(trade_count)::int   AS trade_count
          FROM candles
          WHERE market = ${market} AND bucket_start >= ${from} AND bucket_start < ${to}
          GROUP BY 1
          ORDER BY 1 DESC
          LIMIT ${limit}
        ) newest
        ORDER BY bucket_start ASC
      `;
      return rows.map(toCandle);
    },

    async candlesFromTrades(market, intervalSeconds, from, to, tx) {
      const width = Prisma.sql`make_interval(secs => ${intervalSeconds})`;
      const rows = await exec(tx).$queryRaw<CandleRow[]>`
        SELECT
          date_bin(${width}, engine_timestamp, ${EPOCH}) AS bucket_start,
          (array_agg(price ORDER BY seq ASC,  fill_index ASC))[1]::text  AS open,
          MAX(price)::text AS high,
          MIN(price)::text AS low,
          (array_agg(price ORDER BY seq DESC, fill_index DESC))[1]::text AS close,
          SUM(qty)::text AS base_volume,
          SUM(quote_qty)::text AS quote_volume,
          COUNT(*)::int AS trade_count
        FROM trades
        WHERE market = ${market} AND engine_timestamp >= ${from} AND engine_timestamp < ${to}
        GROUP BY 1
        ORDER BY 1 ASC
      `;
      return rows.map(toCandle);
    },

    async ticker(market, now, tx) {
      const e = exec(tx);
      const last = await e.$queryRaw<Array<{ price: string; engine_timestamp: Date }>>`
        SELECT price::text AS price, engine_timestamp
        FROM trades WHERE market = ${market}
        ORDER BY seq DESC, fill_index DESC LIMIT 1
      `;
      const window = await e.$queryRaw<
        Array<{
          open: string | null;
          high: string | null;
          low: string | null;
          base_volume: string | null;
          quote_volume: string | null;
        }>
      >`
        SELECT
          (array_agg(open ORDER BY open_seq ASC, open_index ASC))[1]::text AS open,
          MAX(high)::text AS high,
          MIN(low)::text  AS low,
          SUM(base_volume)::text  AS base_volume,
          SUM(quote_volume)::text AS quote_volume
        FROM candles
        WHERE market = ${market}
          AND bucket_start >= date_bin('1 minute', ${now}::timestamptz - interval '24 hours', ${EPOCH})
          AND bucket_start <  ${now}::timestamptz
      `;
      const w = window[0];
      return {
        last: last[0]
          ? { price: BigInt(last[0].price), engineTimestamp: last[0].engine_timestamp }
          : null,
        window:
          w && w.open !== null && w.high !== null && w.low !== null
            ? {
                open: BigInt(w.open),
                high: BigInt(w.high),
                low: BigInt(w.low),
                baseVolume: BigInt(w.base_volume ?? '0'),
                quoteVolume: BigInt(w.quote_volume ?? '0'),
              }
            : null,
      };
    },
  };
}
