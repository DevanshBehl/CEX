import type { FastifyRequest } from 'fastify';
import {
  createMarketDataRepository,
  createUserFillsRepository,
  type PrismaClient,
} from '@wallet/db';
import { DependencyUnavailableError, NotFoundError, ValidationError } from '@wallet/errors';
import {
  CANDLE_INTERVAL_SECONDS,
  type BookResponse,
  type CandleInterval,
  type Cluster,
  type ListCandlesResponse,
  type ListFillsResponse,
  type ListTradesResponse,
  type PipelineStatusResponse,
  type SettlementState,
  type TickerResponse,
  type TickerView,
} from '@wallet/types';
import { requireSessionRecord } from '../middleware/guards.js';
import type { MarketFanout } from '../services/market-data/fanout.js';
import type { TapeConsumer } from '../services/market-data/tape-consumer.js';
import {
  toBookLevel,
  toCandleView,
  toTickerView,
  toUserFillView,
  tradeFromRecord,
} from '../services/market-data/views.js';
import { formatKey } from '../services/settlement/events.js';
import type { SettlementWorker } from '../services/settlement/worker.js';

/**
 * Market data over REST (prompt_phase_s5.md §10).
 *
 * Every read here is answered from this process's own state — the fan-out's
 * mirror, or PostgreSQL. NOTHING is proxied to the engine per request: the
 * engine has one caller, and a public endpoint that forwarded to it would make
 * its capacity a public resource.
 */

/** Behind the engine by more than this is "delayed" rather than "live". */
const DELAYED_AFTER_SEQUENCES = 100;

export interface MarketDataMarket {
  readonly symbol: string;
  /** Cluster-qualified. */
  readonly marketId: string;
  readonly fanout: MarketFanout | null;
  readonly tape: TapeConsumer | null;
}

export interface MarketDataControllerDeps {
  readonly db: PrismaClient;
  readonly cluster: Cluster;
  readonly markets: readonly MarketDataMarket[];
  /** Empty when settlement is off. */
  readonly settlement: ReadonlyMap<string, SettlementWorker>;
  readonly settlementEnabled: boolean;
  readonly clock?: () => Date;
}

export interface MarketDataControllers {
  book(request: FastifyRequest): Promise<BookResponse>;
  trades(request: FastifyRequest): Promise<ListTradesResponse>;
  candles(request: FastifyRequest): Promise<ListCandlesResponse>;
  ticker(request: FastifyRequest): Promise<TickerResponse>;
  fills(request: FastifyRequest): Promise<ListFillsResponse>;
  pipeline(request: FastifyRequest): Promise<PipelineStatusResponse>;
  /** For `GET /markets`: null when this deployment records no market data. */
  tickerFor(symbol: string): Promise<TickerView | null>;
  settlementState(symbol: string): SettlementState;
}

export function createMarketDataControllers(deps: MarketDataControllerDeps): MarketDataControllers {
  const now = deps.clock ?? (() => new Date());
  const repository = createMarketDataRepository(deps.db);
  const fills = createUserFillsRepository(deps.db);
  const bySymbol = new Map(deps.markets.map((market) => [market.symbol, market]));

  function market(request: FastifyRequest): MarketDataMarket {
    // Trading lives on one cluster. Any other is told it does not exist here,
    // rather than answered from the trading cluster and looking correct.
    if (request.cluster !== deps.cluster) {
      throw new NotFoundError('Trading is not available on this network');
    }
    const { symbol } = request.params as { symbol: string };
    const found = bySymbol.get(symbol);
    if (!found) throw new NotFoundError('Unknown market');
    return found;
  }

  const status = (
    symbol: string,
    worker: {
      status(): {
        offset: { seq: bigint; idx: number } | null;
        lag: number | null;
        halted: { key: string; reason: string } | null;
      };
    },
  ) => {
    const current = worker.status();
    return {
      market: symbol,
      offset: current.offset ? formatKey(current.offset) : null,
      lag: current.lag,
      halted: current.halted,
    };
  };

  return {
    async book(request) {
      const found = market(request);
      const book = found.fanout?.book() ?? null;
      // Never an old book: a 503 says "not now", a stale answer says something false.
      if (!book) throw new DependencyUnavailableError('order book');
      return {
        book: {
          market: found.symbol,
          seq: book.seq.toString(),
          bids: book.bids.map(toBookLevel),
          asks: book.asks.map(toBookLevel),
          truncated: book.truncated,
        },
      };
    },

    async trades(request) {
      const found = market(request);
      const { limit, before } = request.query as { limit: number; before?: string };
      const cursor = before?.split(':');
      const rows = await repository.listTrades(
        found.marketId,
        limit,
        cursor ? { seq: BigInt(cursor[0]!), fillIndex: Number(cursor[1]) } : undefined,
      );
      const trades = rows.map(tradeFromRecord);
      return {
        trades,
        nextBefore: rows.length === limit ? (trades[trades.length - 1]?.id ?? null) : null,
      };
    },

    async candles(request) {
      const found = market(request);
      const query = request.query as {
        interval: CandleInterval;
        from?: string;
        to?: string;
        limit: number;
      };
      const seconds = CANDLE_INTERVAL_SECONDS[query.interval];
      const to = query.to ? new Date(query.to) : now();
      const from = query.from
        ? new Date(query.from)
        : new Date(to.getTime() - query.limit * seconds * 1_000);
      if (from >= to) {
        throw new ValidationError([{ path: 'from', message: 'must be before `to`' }]);
      }
      const rows = await repository.listCandles(found.marketId, seconds, from, to, query.limit);
      return { interval: query.interval, candles: rows.map(toCandleView) };
    },

    async ticker(request) {
      const found = market(request);
      return { ticker: toTickerView(found.symbol, await repository.ticker(found.marketId, now())) };
    },

    async fills(request) {
      if (request.cluster !== deps.cluster) {
        throw new NotFoundError('Trading is not available on this network');
      }
      const { userId } = requireSessionRecord(request);
      const query = request.query as { market?: string; limit: number; before?: string };
      const found = query.market === undefined ? undefined : bySymbol.get(query.market);
      if (query.market !== undefined && !found) throw new NotFoundError('Unknown market');

      let before: { createdAt: Date; seq: bigint; idx: number } | undefined;
      if (query.before !== undefined) {
        const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(query.before);
        if (!match) throw new ValidationError([{ path: 'before', message: 'not a cursor' }]);
        before = {
          createdAt: new Date(Number(match[1])),
          seq: BigInt(match[2]!),
          idx: Number(match[3]),
        };
      }
      // The session's user id is IN the query. No row for anyone else is read.
      const rows = await fills.listForUser(userId, {
        ...(found ? { market: found.marketId } : {}),
        limit: query.limit,
        ...(before ? { before } : {}),
      });
      const last = rows[rows.length - 1];
      return {
        fills: rows.map(toUserFillView),
        nextBefore:
          rows.length === query.limit && last
            ? `${String(last.createdAt.getTime())}.${last.seq.toString()}.${String(last.idx)}`
            : null,
      };
    },

    async pipeline() {
      return {
        settlement: [...deps.settlement.entries()].map(([symbol, worker]) =>
          status(symbol, worker),
        ),
        marketData: deps.markets.flatMap((entry) =>
          entry.tape ? [status(entry.symbol, entry.tape)] : [],
        ),
      };
    },

    async tickerFor(symbol) {
      const found = bySymbol.get(symbol);
      if (!found?.tape) return null;
      return toTickerView(symbol, await repository.ticker(found.marketId, now()));
    },

    settlementState(symbol) {
      if (!deps.settlementEnabled) return 'disabled';
      const worker = deps.settlement.get(symbol);
      if (!worker) return 'disabled';
      const current = worker.status();
      if (current.halted) return 'halted';
      return current.lag !== null && current.lag > DELAYED_AFTER_SEQUENCES ? 'delayed' : 'live';
    },
  };
}
