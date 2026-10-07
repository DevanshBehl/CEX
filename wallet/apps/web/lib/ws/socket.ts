import {
  WS_CLOSE,
  wsServerMessageSchema,
  type Cluster,
  type WsChannel,
  type WsServerMessage,
} from '@wallet/types';

/**
 * THE ONLY PLACE A WebSocket IS CONSTRUCTED (prompt_phase_s5.md rule 138).
 *
 * Enforced by `no-restricted-globals` in eslint.config.js, which exempts
 * exactly this directory — the same rule, for the same reason, as `fetch` and
 * `lib/api/`. What is decided once here, so that no component can get it
 * wrong: reconnection, resubscription, the heartbeat, and that every frame is
 * PARSED with the schema the server builds it from, never cast.
 *
 * A component never sees a frame. It sees typed messages for a subscription
 * it made, and a connection state it must show (rule 143): a book that has
 * stopped updating looks exactly like a quiet market unless something says so.
 */

export type SocketState =
  /** Not connected yet, or between attempts. Nothing received is current. */
  | 'connecting'
  | 'open'
  /** The session ended. Reconnecting would only be refused: sign in. */
  | 'signed_out'
  | 'closed';

export interface Subscription {
  readonly channel: WsChannel;
  readonly cluster: Cluster;
  readonly market?: string;
}

export type MessageHandler = (message: WsServerMessage) => void;

export interface SocketClient {
  readonly state: SocketState;
  /**
   * Subscribe, and stay subscribed across reconnects. The handler receives
   * every message for this subscription's channel, cluster and market.
   * Returns a function that unsubscribes.
   */
  subscribe(subscription: Subscription, handler: MessageHandler): () => void;
  /**
   * Called on every state change — and on every successful (re)connection,
   * which is when a caller refetches what it holds over REST (ADR-0037 §7).
   */
  onState(listener: (state: SocketState) => void): () => void;
  /** Drop the connection and reconnect, forcing fresh snapshots. */
  reconnect(): void;
  close(): void;
}

/** The slice of the browser's WebSocket this module uses, so a test can supply one. */
export interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface SocketClientOptions {
  readonly url: string;
  readonly create?: (url: string) => SocketLike;
  /** Reconnect delays: capped exponential backoff, with jitter. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** [0, 1). Injected so a test's delays are not random. */
  readonly random?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

const keyOf = (s: { channel: string; cluster: string; market?: string | undefined }): string =>
  `${s.channel}|${s.cluster}|${s.market ?? ''}`;

/** Which subscription a server message belongs to. */
function routeOf(message: WsServerMessage): string | null {
  switch (message.type) {
    case 'book.snapshot':
    case 'book.delta':
    case 'book.resync':
      return keyOf({ channel: 'book', cluster: message.cluster, market: message.market });
    case 'trades.snapshot':
    case 'trade':
      return keyOf({ channel: 'trades', cluster: message.cluster, market: message.market });
    case 'ticker':
      return keyOf({ channel: 'ticker', cluster: message.cluster, market: message.ticker.market });
    case 'order':
    case 'fill':
    case 'balances.changed':
      return keyOf({ channel: 'account', cluster: message.cluster });
    default:
      return null;
  }
}

export function createSocketClient(options: SocketClientOptions): SocketClient {
  const create = options.create ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 15_000;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));

  const subscriptions = new Map<
    string,
    { subscription: Subscription; handlers: Set<MessageHandler> }
  >();
  const stateListeners = new Set<(state: SocketState) => void>();
  let socket: SocketLike | null = null;
  let state: SocketState = 'connecting';
  let attempts = 0;
  let timer: unknown;
  let stopped = false;

  function setState(next: SocketState): void {
    state = next;
    for (const listener of [...stateListeners]) listener(next);
  }

  function send(message: unknown): void {
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(message));
  }

  const request = (op: 'subscribe' | 'unsubscribe', s: Subscription) =>
    send({ op, channel: s.channel, cluster: s.cluster, ...(s.market ? { market: s.market } : {}) });

  function scheduleReconnect(): void {
    if (stopped) return;
    // Capped exponential, with full jitter: after an outage every client must
    // not come back in the same instant.
    const ceiling = Math.min(maxDelay, baseDelay * 2 ** attempts);
    attempts += 1;
    timer = setTimer(connect, Math.floor(ceiling / 2 + random() * (ceiling / 2)));
  }

  function connect(): void {
    if (stopped) return;
    const current = create(options.url);
    socket = current;

    current.onopen = () => {
      if (socket !== current) return;
      attempts = 0;
      // Everything, again: the server kept nothing of the last connection,
      // and every book subscription gets a fresh snapshot in answer.
      for (const { subscription } of subscriptions.values()) request('subscribe', subscription);
      setState('open');
    };

    current.onmessage = (event) => {
      if (socket !== current) return;
      let message: WsServerMessage;
      try {
        // Parsed, never cast. A frame the contract does not describe is not
        // acted on — and a server that sends one has broken the contract, so
        // what this client holds can no longer be trusted either.
        message = wsServerMessageSchema.parse(JSON.parse(String(event.data)));
      } catch {
        current.close();
        return;
      }
      if (message.type === 'ping') {
        send({ op: 'pong' });
        return;
      }
      const route = routeOf(message);
      if (route === null) return;
      for (const handler of [...(subscriptions.get(route)?.handlers ?? [])]) handler(message);
    };

    current.onclose = (event) => {
      if (socket !== current) return;
      socket = null;
      if (stopped) return;
      if (event.code === WS_CLOSE.sessionEnded) {
        // Not an outage. Retrying would be refused every time.
        setState('signed_out');
        return;
      }
      setState('connecting');
      scheduleReconnect();
    };

    current.onerror = () => {
      // `onclose` always follows, and is where the reconnect is decided.
    };
  }

  connect();

  return {
    get state() {
      return state;
    },

    subscribe(subscription, handler) {
      const key = keyOf(subscription);
      let entry = subscriptions.get(key);
      if (!entry) {
        entry = { subscription, handlers: new Set() };
        subscriptions.set(key, entry);
        request('subscribe', subscription);
      }
      entry.handlers.add(handler);
      return () => {
        const current = subscriptions.get(key);
        if (!current) return;
        current.handlers.delete(handler);
        if (current.handlers.size === 0) {
          subscriptions.delete(key);
          request('unsubscribe', subscription);
        }
      };
    },

    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    reconnect() {
      if (stopped || state === 'signed_out') return;
      // Closing is enough: `onclose` schedules the reconnect, and reconnecting
      // resubscribes, which is what brings fresh snapshots.
      socket?.close();
    },

    close() {
      stopped = true;
      clearTimer(timer);
      const current = socket;
      socket = null;
      current?.close(1000);
      setState('closed');
    },
  };
}
