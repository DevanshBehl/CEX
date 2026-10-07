import {
  createLedgerRepository,
  createUserRepository,
  type OrderRecord,
  type PrismaClient,
} from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import type { Cluster, SettlementState } from '@wallet/types';
import type { WalletMetrics } from '../../observability/metrics.js';
import type { MarketEntry, MarketRegistry } from '../trading/markets.js';
import type { OrderService } from '../trading/order.service.js';
import type { ReferencePriceSource } from './reference-price.js';
import { affordable, holdFor, ladder, shouldReanchor, type Quote, type QuoteConfig } from './strategy.js';

/**
 * The demo market maker (ADR-0038).
 *
 * IT IS A USER. Everything it does goes through `OrderService` — the same
 * object the HTTP controllers call — so its quotes pass pre-trade risk, take
 * real holds, and are swept, settled and reconciled like anyone's. It holds no
 * engine client, no ledger repository it writes through, and no order
 * repository. There is no exemption for it anywhere, because there is nowhere
 * in this file an exemption could be asked for.
 *
 * It is never funded here. With nothing to quote a side with, it does not
 * quote that side.
 */

export interface MarketMakerDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly metrics?: WalletMetrics;
  readonly cluster: Cluster;
  readonly orders: OrderService;
  readonly markets: MarketRegistry;
  readonly source: ReferencePriceSource;
  /** The user it trades as. */
  readonly userId: string;
  /** SYMBOL -> what it quotes there. */
  readonly quoting: Readonly<Record<string, { readonly levelQty: bigint }>>;
  readonly levels: number;
  readonly halfSpreadBps: number;
  readonly levelStepBps: number;
  readonly intervalMs: number;
  /** A reference older than this is not quoted around. */
  readonly staleMs: number;
  /** Whether fills in a market are reaching the ledger. */
  readonly settlementState: (symbol: string) => SettlementState;
  readonly clock?: () => Date;
}

export interface MarketMaker {
  /** Verify it may run. False — and a security event — if it may not. */
  init(): Promise<boolean>;
  /** One pass over every market it quotes. */
  runOnce(): Promise<void>;
  start(): void;
  /** Stop, and cancel what it has resting, best effort. */
  stop(): Promise<void>;
}

const OPEN_PAGE = 200;

export function createMarketMaker(deps: MarketMakerDeps): MarketMaker {
  const now = deps.clock ?? (() => new Date());
  const ledger = createLedgerRepository(deps.db);
  /** Where each market's ladder was last anchored. In memory: a restart re-anchors. */
  const anchors = new Map<string, { price: bigint; generation: string }>();
  /** Why each market is not being quoted, so a state is logged once, not every cycle. */
  const pulled = new Map<string, string>();
  let ready = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const count = (symbol: string, outcome: string): void =>
    deps.metrics?.makerQuotes.inc({ market: symbol, outcome });

  const openOrders = (symbol: string): Promise<OrderRecord[]> =>
    deps.orders.page(deps.userId, { symbol, limit: OPEN_PAGE, openOnly: true });

  /** Cancel everything it has resting in a market. Each cancel is independent. */
  async function pull(symbol: string, reason: string): Promise<void> {
    if (pulled.get(symbol) !== reason) {
      pulled.set(symbol, reason);
      logSecurityEvent(deps.logger, 'market_maker.quotes_pulled', {
        outcome: 'success',
        targetType: 'market',
        targetId: symbol,
        reason,
      });
    }
    anchors.delete(symbol);
    for (const order of await openOrders(symbol)) await cancel(symbol, order);
  }

  async function cancel(symbol: string, order: OrderRecord): Promise<void> {
    // Still being placed: the gateway refuses to cancel it, as it would for
    // any user. The sweeper resolves it and the next cycle sees it.
    if (order.status === 'PENDING_ENGINE') return;
    try {
      await deps.orders.cancel(deps.userId, order.id, `market-maker:${symbol}`);
      count(symbol, 'cancelled');
    } catch {
      count(symbol, 'skipped');
    }
  }

  async function place(entry: MarketEntry, quote: Quote, generation: string): Promise<void> {
    try {
      const order = await deps.orders.place({
        userId: deps.userId,
        symbol: entry.symbol,
        side: quote.side,
        type: 'limit',
        timeInForce: 'GTC',
        price: quote.price.toString(),
        qty: quote.qty.toString(),
        postOnly: false,
        // Deterministic from market, generation, side and level: a restart
        // that re-issues this generation submits the SAME order, and the
        // gateway returns the one it already has instead of placing a second.
        clientOrderId: `mm:${entry.symbol}:${generation}:${quote.side}:${String(quote.level)}`,
        correlationId: `market-maker:${entry.symbol}`,
      });
      // A self-trade rejection, a collar the book moved past: ordinary
      // outcomes, the hold already returned by the gateway.
      count(entry.symbol, order.status === 'REJECTED' ? 'rejected' : 'placed');
    } catch {
      // Refused before any hold was taken: a risk limit, the order-rate limit
      // it shares with every user, insufficient funds after a fill. Not an
      // error and not retried this cycle.
      count(entry.symbol, 'skipped');
    }
  }

  async function quoteMarket(entry: MarketEntry, config: QuoteConfig): Promise<void> {
    const symbol = entry.symbol;

    // Its view of its own inventory is behind where fills are not settling.
    const settlement = deps.settlementState(symbol);
    if (settlement === 'halted' || settlement === 'delayed') {
      return pull(symbol, `settlement_${settlement}`);
    }

    const routable = await deps.markets.routable(symbol);
    if (!routable.ok || routable.market.status !== 'open') return pull(symbol, 'market_not_open');

    const reference = await deps.source.price({
      symbol,
      tickSize: BigInt(entry.market.tickSize),
      baseDecimals: entry.baseDecimals,
      quoteDecimals: entry.quoteDecimals,
    });
    const age = reference ? now().getTime() - reference.observedAt.getTime() : null;
    if (age !== null) deps.metrics?.makerReferenceAge.set(Math.max(0, age), { market: symbol });
    // NEVER a price it cannot see, and never a different source's instead.
    if (!reference || age === null || age > deps.staleMs) return pull(symbol, 'reference_stale');
    pulled.delete(symbol);

    const anchor = anchors.get(symbol);
    if (shouldReanchor(anchor?.price ?? null, reference.price, config.levelStepBps)) {
      anchors.set(symbol, { price: reference.price, generation: reference.generation });
    }
    const anchored = anchors.get(symbol)!;

    const book = await entry.engine.book();
    const wanted = ladder({
      reference: anchored.price,
      market: routable.market,
      collarReference: book?.referencePrice ?? null,
      config,
    });

    const open = await openOrders(symbol);
    const matches = (order: OrderRecord, quote: Quote) =>
      order.side === quote.side &&
      order.price === quote.price.toString() &&
      BigInt(order.qty) - BigInt(order.filledQty) === quote.qty;

    // Cancel FIRST. Anything it no longer wants is gone before anything new is
    // placed, so a new bid can never meet its own stale ask: self-trade
    // prevention would reject the quote, and a hold would have been taken and
    // released for nothing.
    const kept: OrderRecord[] = [];
    for (const order of open) {
      if (wanted.some((quote) => matches(order, quote))) kept.push(order);
      else await cancel(symbol, order);
    }

    // What it may hold: what is free now, plus what the kept quotes already hold.
    const balances = await ledger.getUserTradingBalances(deps.userId, deps.cluster);
    const available = (asset: string) =>
      BigInt(balances.find((row) => row.asset === asset)?.available ?? '0');
    const held = (side: 'buy' | 'sell') =>
      wanted
        .filter((quote) => quote.side === side && kept.some((order) => matches(order, quote)))
        .reduce((sum, quote) => sum + holdFor(quote), 0n);
    const funded = affordable(wanted, {
      base: available(entry.market.baseAsset) + held('sell'),
      quote: available(entry.market.quoteAsset) + held('buy'),
    });
    if (funded.length < wanted.length && pulled.get(`${symbol}:funds`) === undefined) {
      pulled.set(`${symbol}:funds`, 'short');
      deps.logger.info('market maker cannot fund every quote; quoting what it can', {
        targetType: 'market',
        targetId: symbol,
      });
    } else if (funded.length === wanted.length) {
      pulled.delete(`${symbol}:funds`);
    }

    for (const quote of funded) {
      if (kept.some((order) => matches(order, quote))) continue;
      await place(entry, quote, anchored.generation);
    }
  }

  const maker: MarketMaker = {
    async init() {
      const refuse = (reason: string): false => {
        logSecurityEvent(deps.logger, 'market_maker.start_refused', {
          outcome: 'failure',
          reason,
        });
        return false;
      };
      // It trades as an existing user. It is never created here.
      const user = await createUserRepository(deps.db).findById(deps.userId);
      if (!user) return refuse('no_such_user');
      const known = Object.keys(deps.quoting).filter((symbol) => deps.markets.get(symbol));
      if (known.length === 0) return refuse('nothing_to_quote');
      ready = true;
      logSecurityEvent(deps.logger, 'market_maker.started', {
        outcome: 'success',
        reason: deps.source.name,
        count: known.length,
      });
      return true;
    },

    async runOnce() {
      if (!ready) return;
      for (const [symbol, { levelQty }] of Object.entries(deps.quoting)) {
        const entry = deps.markets.get(symbol);
        if (!entry) continue;
        try {
          await quoteMarket(entry, {
            levels: deps.levels,
            halfSpreadBps: deps.halfSpreadBps,
            levelStepBps: deps.levelStepBps,
            levelQty,
          });
        } catch (error) {
          // One market failing does not stop the next.
          deps.logger.warn('market maker could not quote a market this cycle', {
            targetType: 'market',
            targetId: symbol,
            errorName: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
    },

    start() {
      if (!ready || timer) return;
      const tick = (): void => {
        // One pass at a time: a slow cycle is not overlapped by the next.
        if (running) return;
        running = maker.runOnce().finally(() => {
          running = undefined;
        });
      };
      timer = setInterval(tick, deps.intervalMs);
      timer.unref();
      tick();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
      if (!ready) return;
      ready = false;
      // Best effort. What it could not cancel stays resting, with its hold,
      // and is cancelled on the next start.
      for (const symbol of Object.keys(deps.quoting)) {
        if (!deps.markets.get(symbol)) continue;
        try {
          for (const order of await openOrders(symbol)) await cancel(symbol, order);
        } catch {
          // Shutting down regardless.
        }
      }
      logSecurityEvent(deps.logger, 'market_maker.stopped', { outcome: 'success' });
    },
  };
  return maker;
}
