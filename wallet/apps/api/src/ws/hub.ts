import { randomUUID } from 'node:crypto';
import {
  createMarketDataRepository,
  createOrderRepository,
  createUserFillsRepository,
  type PrismaClient,
} from '@wallet/db';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import {
  CLUSTERS,
  WS_CLOSE,
  wsClientMessageSchema,
  type Cluster,
  type WsChannel,
  type WsServerMessage,
} from '@wallet/types';
import { toOrderView } from '../controllers/trading.controller.js';
import type { WalletMetrics } from '../observability/metrics.js';
import type { FanoutMessage, MarketFanout } from '../services/market-data/fanout.js';
import {
  toBookLevel,
  toLevelChange,
  toTickerView,
  toUserFillView,
  tradeFromFanout,
  tradeFromRecord,
} from '../services/market-data/views.js';

/**
 * Every open socket, and what each is owed (ADR-0037).
 *
 * The hub knows nothing about HTTP. The plugin beside it has already checked
 * `Origin`, resolved a session and applied the per-user and per-IP limits by
 * the time a socket reaches `attach` — what happens here is everything after:
 * subscriptions, bounds, heartbeats, re-validation, and who gets which bytes.
 *
 * Three rules shape it:
 *
 *   - A PUBLIC message is serialised once and the same string goes to every
 *     subscriber. A private message is built for one user from rows read for
 *     that user, and is never put on a shared path.
 *   - A client that breaches a bound, or does not read, loses its CONNECTION.
 *     Nothing is queued for it and no single message is dropped: a book with
 *     one message missing is a wrong book the client cannot detect.
 *   - Nothing private is sent on a socket whose session has ended.
 */

/** The part of a `ws` socket the hub uses. */
export interface HubSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

export interface HubMarket {
  readonly symbol: string;
  /** Cluster-qualified, as the tables store it. */
  readonly marketId: string;
  readonly fanout: MarketFanout;
}

export interface HubLimits {
  readonly sessionRecheckMs: number;
  readonly heartbeatMs: number;
  readonly maxSocketsPerUser: number;
  readonly maxSocketsPerIp: number;
  readonly maxSubscriptions: number;
  readonly maxMessageBytes: number;
  readonly maxMessagesPerSecond: number;
  readonly maxBufferedBytes: number;
}

export interface HubDeps {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly metrics?: WalletMetrics;
  /** The ONE cluster trading runs on. */
  readonly cluster: Cluster;
  /** Every cluster this deployment serves, for telling "unknown" from "not here". */
  readonly servedClusters: readonly Cluster[];
  readonly markets: readonly HubMarket[];
  readonly limits: HubLimits;
  /** Is this session still good, and still this user's? */
  readonly sessionValid: (token: string, userId: string) => Promise<boolean>;
  readonly clock?: () => Date;
}

export interface HubConnection {
  onMessage(data: string | Buffer): void;
  onClose(): void;
}

export interface SocketHub {
  /** Would one more socket breach a bound? Asked BEFORE the upgrade. */
  admit(input: { userId: string; ip: string }): 'ok' | 'user_limit' | 'ip_limit';
  attach(
    input: { userId: string; ip: string; sessionToken: string },
    socket: HubSocket,
  ): HubConnection;
  /** These users' rows changed. Read them and tell their sockets. */
  usersChanged(userIds: readonly string[]): void;
  /** A trade was recorded for this market: its ticker moved. */
  tapeChanged(marketId: string): void;
  start(): void;
  stop(): void;
  /** Open sockets, for tests and the metric. */
  size(): number;
}

type CloseReason = 'slow_consumer' | 'limit' | 'session_ended' | 'protocol_error' | 'shutdown';

interface Connection {
  readonly id: string;
  readonly userId: string;
  readonly ip: string;
  readonly sessionToken: string;
  readonly socket: HubSocket;
  /** `channel|symbol` — the cluster is always the trading cluster. */
  readonly subscriptions: Set<string>;
  closed: boolean;
  unansweredPings: number;
  windowStartedAt: number;
  messagesInWindow: number;
  /** The private channel: read rows changed at or after this. */
  accountCursor: Date | null;
  pushing: boolean;
  pushAgain: boolean;
}

/**
 * How far back a private read reaches behind its cursor.
 *
 * `updated_at` is set when a statement runs, not when its transaction
 * commits, so a row can become visible with a timestamp slightly in the past.
 * Re-reading a few seconds costs duplicates, which converge — an order update
 * is a replacement and a fill is keyed by its id — and never a missed row.
 */
const PRIVATE_OVERLAP_MS = 5_000;
const PRIVATE_BATCH = 200;
const RECENT_TRADES = 50;
/** The ticker is conflated: at most one refresh per market per interval. */
const TICKER_INTERVAL_MS = 1_000;

const key = (channel: WsChannel, symbol: string): string => `${channel}|${symbol}`;

export function createSocketHub(deps: HubDeps): SocketHub {
  const now = deps.clock ?? (() => new Date());
  const connections = new Set<Connection>();
  const byUser = new Map<string, Set<Connection>>();
  const byIp = new Map<string, number>();
  const subscribers = new Map<string, Set<Connection>>();
  const bySymbol = new Map(deps.markets.map((market) => [market.symbol, market]));
  const byMarketId = new Map(deps.markets.map((market) => [market.marketId, market]));
  const tickerDirty = new Set<string>();
  const unsubscribeFanout: Array<() => void> = [];
  const timers: NodeJS.Timeout[] = [];

  const marketData = createMarketDataRepository(deps.db);
  const orders = createOrderRepository(deps.db);
  const fills = createUserFillsRepository(deps.db);

  const subscriptionCounts = new Map<string, number>();
  function countSubscription(channel: string, by: number): void {
    const count = Math.max(0, (subscriptionCounts.get(channel) ?? 0) + by);
    subscriptionCounts.set(channel, count);
    deps.metrics?.socketSubscriptions.set(count, { channel });
  }

  function close(connection: Connection, code: number, reason: CloseReason): void {
    if (connection.closed) return;
    detach(connection);
    deps.metrics?.socketsClosed.inc({ reason });
    if (reason !== 'shutdown') {
      // By connection id. Never the user, never what they were subscribed to.
      logSecurityEvent(
        deps.logger,
        reason === 'session_ended' ? 'ws.session_ended' : 'ws.closed_by_server',
        { outcome: 'failure', targetType: 'socket', targetId: connection.id, reason },
      );
    }
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  function detach(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    connections.delete(connection);
    const mine = byUser.get(connection.userId);
    mine?.delete(connection);
    if (mine?.size === 0) byUser.delete(connection.userId);
    const remaining = (byIp.get(connection.ip) ?? 1) - 1;
    if (remaining <= 0) byIp.delete(connection.ip);
    else byIp.set(connection.ip, remaining);
    for (const subscription of connection.subscriptions) {
      subscribers.get(subscription)?.delete(connection);
      countSubscription(subscription.split('|')[0]!, -1);
    }
    connection.subscriptions.clear();
    deps.metrics?.socketsOpen.set(connections.size);
  }

  /** Send already-serialised bytes, or drop the connection if it is not reading. */
  function sendRaw(connection: Connection, data: string, channel: string): void {
    if (connection.closed) return;
    if (connection.socket.bufferedAmount > deps.limits.maxBufferedBytes) {
      close(connection, WS_CLOSE.slowConsumer, 'slow_consumer');
      return;
    }
    try {
      connection.socket.send(data);
      deps.metrics?.socketMessages.inc({ channel });
    } catch {
      detach(connection);
    }
  }

  const send = (connection: Connection, message: WsServerMessage, channel: string): void =>
    sendRaw(connection, JSON.stringify(message), channel);

  /** One serialisation, the same bytes to every subscriber. */
  function broadcast(channel: WsChannel, symbol: string, message: WsServerMessage): void {
    const audience = subscribers.get(key(channel, symbol));
    if (!audience || audience.size === 0) return;
    const data = JSON.stringify(message);
    for (const connection of [...audience]) sendRaw(connection, data, channel);
  }

  const scope = (symbol: string) => ({ cluster: deps.cluster, market: symbol });

  function bookSnapshot(market: HubMarket): WsServerMessage {
    const book = market.fanout.book();
    if (!book) return { type: 'book.resync', ...scope(market.symbol) };
    return {
      type: 'book.snapshot',
      ...scope(market.symbol),
      seq: book.seq.toString(),
      bids: book.bids.map(toBookLevel),
      asks: book.asks.map(toBookLevel),
      truncated: book.truncated,
    };
  }

  function onFanout(market: HubMarket, message: FanoutMessage): void {
    switch (message.kind) {
      case 'snapshot':
        broadcast('book', market.symbol, bookSnapshot(market));
        // The live tape had a hole while the book was being rebuilt. Hand
        // trade subscribers the recorded tape again rather than leave it.
        void recentTrades(market).then((trades) => {
          broadcast('trades', market.symbol, {
            type: 'trades.snapshot',
            ...scope(market.symbol),
            trades,
          });
        });
        return;
      case 'resync':
        broadcast('book', market.symbol, { type: 'book.resync', ...scope(market.symbol) });
        return;
      case 'delta':
        broadcast('book', market.symbol, {
          type: 'book.delta',
          ...scope(market.symbol),
          seq: message.seq.toString(),
          changes: message.changes.map(toLevelChange),
        });
        return;
      case 'trade':
        broadcast('trades', market.symbol, {
          type: 'trade',
          ...scope(market.symbol),
          trade: tradeFromFanout(message.trade),
        });
        return;
    }
  }

  async function recentTrades(market: HubMarket) {
    try {
      const rows = await marketData.listTrades(market.marketId, RECENT_TRADES);
      // Oldest first, as the live channel delivers them.
      return rows.reverse().map(tradeFromRecord);
    } catch {
      return [];
    }
  }

  async function ticker(market: HubMarket): Promise<WsServerMessage | null> {
    try {
      const record = await marketData.ticker(market.marketId, now());
      return { type: 'ticker', cluster: deps.cluster, ticker: toTickerView(market.symbol, record) };
    } catch {
      return null;
    }
  }

  /**
   * The private channel: read this user's changed rows, send them to this
   * socket. One read at a time per socket; a notification that arrives during
   * a read schedules exactly one more.
   */
  async function pushAccount(connection: Connection): Promise<void> {
    if (connection.pushing) {
      connection.pushAgain = true;
      return;
    }
    connection.pushing = true;
    try {
      do {
        connection.pushAgain = false;
        const cursor = connection.accountCursor;
        if (connection.closed || cursor === null) return;
        const readAt = now();
        const since = new Date(cursor.getTime() - PRIVATE_OVERLAP_MS);
        // Filtered by THIS user in the query, never after it.
        const [changedOrders, newFills] = await Promise.all([
          orders.listChangedSince(connection.userId, since, PRIVATE_BATCH),
          fills.listForUser(connection.userId, { since, limit: PRIVATE_BATCH }),
        ]);
        if (connection.closed || connection.accountCursor === null) return;
        // Checked against the SESSION, not assumed from the upgrade: nothing
        // private goes to a socket whose session has ended.
        if (!(await deps.sessionValid(connection.sessionToken, connection.userId))) {
          close(connection, WS_CLOSE.sessionEnded, 'session_ended');
          return;
        }
        for (const order of changedOrders) {
          send(
            connection,
            { type: 'order', cluster: deps.cluster, order: toOrderView(order) },
            'account',
          );
        }
        for (const fill of newFills) {
          send(
            connection,
            { type: 'fill', cluster: deps.cluster, fill: toUserFillView(fill) },
            'account',
          );
        }
        // Not a number. The client refetches: this is not where a balance
        // comes from.
        send(connection, { type: 'balances.changed', cluster: deps.cluster }, 'account');
        connection.accountCursor = readAt;
      } while (connection.pushAgain && !connection.closed);
    } catch {
      // A hint that could not be built. The client's refetch covers it.
    } finally {
      connection.pushing = false;
    }
  }

  function resolveMarket(
    connection: Connection,
    cluster: Cluster,
    symbol: string | undefined,
    needsMarket: boolean,
  ): HubMarket | null | 'refused' {
    const refuse = (code: Extract<WsServerMessage, { type: 'error' }>['code']) => {
      send(connection, { type: 'error', code }, 'control');
      return 'refused' as const;
    };
    if (!(CLUSTERS as readonly string[]).includes(cluster)) return refuse('unknown_cluster');
    if (!deps.servedClusters.includes(cluster)) return refuse('cluster_not_served');
    // Trading lives on one cluster. Another served cluster has no markets.
    if (cluster !== deps.cluster) return refuse(needsMarket ? 'unknown_market' : 'unavailable');
    if (!needsMarket) return null;
    if (symbol === undefined) return refuse('market_required');
    return bySymbol.get(symbol) ?? refuse('unknown_market');
  }

  async function subscribe(
    connection: Connection,
    channel: WsChannel,
    cluster: Cluster,
    symbol: string | undefined,
  ): Promise<void> {
    // A subscription is the moment new data starts flowing to this socket.
    if (!(await deps.sessionValid(connection.sessionToken, connection.userId))) {
      close(connection, WS_CLOSE.sessionEnded, 'session_ended');
      return;
    }
    if (connection.closed) return;

    const market = resolveMarket(connection, cluster, symbol, channel !== 'account');
    if (market === 'refused') return;
    const subscription = key(channel, market?.symbol ?? '');
    if (!connection.subscriptions.has(subscription)) {
      if (connection.subscriptions.size >= deps.limits.maxSubscriptions) {
        close(connection, WS_CLOSE.limitExceeded, 'limit');
        return;
      }
      connection.subscriptions.add(subscription);
      countSubscription(channel, 1);
    }
    const confirmation: WsServerMessage = {
      type: 'subscribed',
      channel,
      cluster,
      ...(market ? { market: market.symbol } : {}),
    };
    send(connection, confirmation, 'control');

    if (channel === 'account') {
      // From now. Everything before this the client fetches over REST.
      connection.accountCursor ??= now();
      return;
    }
    if (!market) return;

    if (channel === 'book') {
      // Registered and snapshotted in ONE synchronous step: the fan-out emits
      // synchronously, so no delta can fall between the snapshot and the
      // subscription, and none can arrive before it.
      send(connection, bookSnapshot(market), 'book');
      audience(subscription).add(connection);
      return;
    }
    audience(subscription).add(connection);
    if (channel === 'trades') {
      // A live trade may arrive before this resolves. The client merges by id.
      const trades = await recentTrades(market);
      send(connection, { type: 'trades.snapshot', ...scope(market.symbol), trades }, 'trades');
      return;
    }
    const current = await ticker(market);
    if (current) send(connection, current, 'ticker');
  }

  function audience(subscription: string): Set<Connection> {
    let set = subscribers.get(subscription);
    if (!set) {
      set = new Set();
      subscribers.set(subscription, set);
    }
    return set;
  }

  function unsubscribe(
    connection: Connection,
    channel: WsChannel,
    cluster: Cluster,
    symbol: string | undefined,
  ): void {
    const subscription = key(channel, channel === 'account' ? '' : (symbol ?? ''));
    if (!connection.subscriptions.delete(subscription)) {
      send(connection, { type: 'error', code: 'not_subscribed' }, 'control');
      return;
    }
    subscribers.get(subscription)?.delete(connection);
    countSubscription(channel, -1);
    if (channel === 'account') connection.accountCursor = null;
    send(
      connection,
      { type: 'unsubscribed', channel, cluster, ...(symbol ? { market: symbol } : {}) },
      'control',
    );
  }

  function onMessage(connection: Connection, data: string | Buffer): void {
    if (connection.closed) return;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    if (bytes > deps.limits.maxMessageBytes) {
      close(connection, WS_CLOSE.protocolError, 'protocol_error');
      return;
    }
    const at = Date.now();
    if (at - connection.windowStartedAt >= 1_000) {
      connection.windowStartedAt = at;
      connection.messagesInWindow = 0;
    }
    connection.messagesInWindow += 1;
    if (connection.messagesInWindow > deps.limits.maxMessagesPerSecond) {
      close(connection, WS_CLOSE.limitExceeded, 'limit');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      close(connection, WS_CLOSE.protocolError, 'protocol_error');
      return;
    }
    // Parsed, never cast. A client may send three things; anything else is
    // not a request this server knows how to refuse politely.
    const message = wsClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      close(connection, WS_CLOSE.protocolError, 'protocol_error');
      return;
    }
    switch (message.data.op) {
      case 'pong':
        connection.unansweredPings = 0;
        return;
      case 'subscribe':
        void subscribe(
          connection,
          message.data.channel,
          message.data.cluster,
          message.data.market,
        ).catch(() => send(connection, { type: 'error', code: 'unavailable' }, 'control'));
        return;
      case 'unsubscribe':
        unsubscribe(connection, message.data.channel, message.data.cluster, message.data.market);
        return;
    }
  }

  function heartbeat(): void {
    for (const connection of [...connections]) {
      // Two unanswered: a half-open connection, or a client not reading.
      if (connection.unansweredPings >= 2) {
        close(connection, WS_CLOSE.slowConsumer, 'slow_consumer');
        continue;
      }
      connection.unansweredPings += 1;
      send(connection, { type: 'ping' }, 'control');
    }
  }

  async function recheckSessions(): Promise<void> {
    for (const connection of [...connections]) {
      if (connection.closed) continue;
      let valid = false;
      try {
        valid = await deps.sessionValid(connection.sessionToken, connection.userId);
      } catch {
        // The session store could not answer. That is not evidence the session
        // ended; ask again next time rather than sign everyone out.
        continue;
      }
      if (!valid) close(connection, WS_CLOSE.sessionEnded, 'session_ended');
    }
  }

  async function flushTickers(): Promise<void> {
    const due = [...tickerDirty];
    tickerDirty.clear();
    for (const marketId of due) {
      const market = byMarketId.get(marketId);
      if (!market || !subscribers.get(key('ticker', market.symbol))?.size) continue;
      const message = await ticker(market);
      if (message) broadcast('ticker', market.symbol, message);
    }
  }

  return {
    admit({ userId, ip }) {
      if ((byUser.get(userId)?.size ?? 0) >= deps.limits.maxSocketsPerUser) return 'user_limit';
      if ((byIp.get(ip) ?? 0) >= deps.limits.maxSocketsPerIp) return 'ip_limit';
      return 'ok';
    },

    attach(input, socket) {
      const connection: Connection = {
        id: randomUUID(),
        userId: input.userId,
        ip: input.ip,
        sessionToken: input.sessionToken,
        socket,
        subscriptions: new Set(),
        closed: false,
        unansweredPings: 0,
        windowStartedAt: Date.now(),
        messagesInWindow: 0,
        accountCursor: null,
        pushing: false,
        pushAgain: false,
      };
      connections.add(connection);
      let mine = byUser.get(input.userId);
      if (!mine) {
        mine = new Set();
        byUser.set(input.userId, mine);
      }
      mine.add(connection);
      byIp.set(input.ip, (byIp.get(input.ip) ?? 0) + 1);
      deps.metrics?.socketsOpen.set(connections.size);
      return {
        onMessage: (data) => onMessage(connection, data),
        onClose: () => detach(connection),
      };
    },

    usersChanged(userIds) {
      for (const userId of userIds) {
        for (const connection of byUser.get(userId) ?? []) {
          if (connection.accountCursor !== null) void pushAccount(connection);
        }
      }
    },

    tapeChanged(marketId) {
      tickerDirty.add(marketId);
    },

    start() {
      for (const market of deps.markets) {
        unsubscribeFanout.push(market.fanout.subscribe((message) => onFanout(market, message)));
      }
      timers.push(setInterval(heartbeat, deps.limits.heartbeatMs));
      timers.push(setInterval(() => void recheckSessions(), deps.limits.sessionRecheckMs));
      timers.push(setInterval(() => void flushTickers(), TICKER_INTERVAL_MS));
      for (const timer of timers) timer.unref();
    },

    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      for (const off of unsubscribeFanout.splice(0)) off();
      for (const connection of [...connections]) close(connection, WS_CLOSE.goingAway, 'shutdown');
    },

    size: () => connections.size,
  };
}
