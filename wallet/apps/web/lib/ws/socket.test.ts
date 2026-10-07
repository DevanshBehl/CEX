import { describe, expect, it } from 'vitest';
import { WS_CLOSE, type WsServerMessage } from '@wallet/types';
import { createSocketClient, type SocketLike, type SocketState } from './socket';

/** A socket a test drives from the server's side. */
class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: number | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.drop(code ?? 1005);
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const states: SocketState[] = [];
  const client = createSocketClient({
    url: 'ws://test/ws',
    create: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
  });
  client.onState((state) => states.push(state));
  return { client, sockets, timers, states, latest: () => sockets[sockets.length - 1]! };
}

const BOOK = { channel: 'book', cluster: 'devnet', market: 'SOL-USDC' } as const;
const snapshot = {
  type: 'book.snapshot',
  cluster: 'devnet',
  market: 'SOL-USDC',
  seq: '1',
  bids: [],
  asks: [],
  truncated: false,
};

describe('the socket client', () => {
  it('subscribes once connected, naming the cluster on every subscription', () => {
    const { client, latest } = harness();
    client.subscribe(BOOK, () => undefined);
    expect(latest().sent).toEqual([]);
    latest().accept();
    expect(latest().sent).toEqual([
      { op: 'subscribe', channel: 'book', cluster: 'devnet', market: 'SOL-USDC' },
    ]);
    expect(client.state).toBe('open');
  });

  it('routes a message to the subscription it belongs to, and to no other', () => {
    const { client, latest } = harness();
    const book: WsServerMessage[] = [];
    const other: WsServerMessage[] = [];
    client.subscribe(BOOK, (m) => book.push(m));
    client.subscribe({ ...BOOK, market: 'BTC-USDC' }, (m) => other.push(m));
    client.subscribe({ channel: 'account', cluster: 'devnet' }, (m) => other.push(m));
    latest().accept();
    latest().deliver(snapshot);
    expect(book.map((m) => m.type)).toEqual(['book.snapshot']);
    expect(other).toEqual([]);
  });

  it('answers the heartbeat itself: a component never sees it', () => {
    const { client, latest } = harness();
    const seen: WsServerMessage[] = [];
    client.subscribe(BOOK, (m) => seen.push(m));
    latest().accept();
    latest().deliver({ type: 'ping' });
    expect(latest().sent.at(-1)).toEqual({ op: 'pong' });
    expect(seen).toEqual([]);
  });

  it('drops the connection on a frame the contract does not describe', () => {
    const { client, latest, timers } = harness();
    const seen: WsServerMessage[] = [];
    client.subscribe(BOOK, (m) => seen.push(m));
    latest().accept();
    // An extra field: a strict schema refuses it rather than passing it on.
    latest().deliver({ ...snapshot, orderId: 'leaked' });
    expect(seen).toEqual([]);
    expect(client.state).toBe('connecting');
    expect(timers).toHaveLength(1);
    latest().deliver('not json');
  });

  it('reconnects with capped backoff, and resubscribes to everything it had', () => {
    const { client, sockets, timers, states } = harness();
    client.subscribe(BOOK, () => undefined);
    client.subscribe({ channel: 'account', cluster: 'devnet' }, () => undefined);
    sockets[0]!.accept();
    sockets[0]!.drop();
    expect(states).toEqual(['open', 'connecting']);

    // 100ms ceiling, half of it with zero jitter; then doubling, to the cap.
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const next = timers.pop()!;
      delays.push(next.ms);
      next.fn();
      sockets[sockets.length - 1]!.drop();
    }
    expect(delays).toEqual([50, 100, 200, 400, 500, 500]);

    timers.pop()!.fn();
    const fresh = sockets[sockets.length - 1]!;
    fresh.accept();
    // Both subscriptions, again: the server kept nothing of the old socket.
    expect(fresh.sent).toEqual([
      { op: 'subscribe', channel: 'book', cluster: 'devnet', market: 'SOL-USDC' },
      { op: 'subscribe', channel: 'account', cluster: 'devnet' },
    ]);
    expect(client.state).toBe('open');
    // A success resets the backoff.
    fresh.drop();
    expect(timers.pop()!.ms).toBe(50);
  });

  it('does not reconnect when the session ended: it would only be refused', () => {
    const { client, latest, timers } = harness();
    client.subscribe(BOOK, () => undefined);
    latest().accept();
    latest().drop(WS_CLOSE.sessionEnded);
    expect(client.state).toBe('signed_out');
    expect(timers).toEqual([]);
    client.reconnect();
    expect(timers).toEqual([]);
  });

  it('unsubscribes when the last handler goes, and not before', () => {
    const { client, latest } = harness();
    const offA = client.subscribe(BOOK, () => undefined);
    const offB = client.subscribe(BOOK, () => undefined);
    latest().accept();
    expect(latest().sent).toHaveLength(1);
    offA();
    expect(latest().sent).toHaveLength(1);
    offB();
    expect(latest().sent.at(-1)).toEqual({
      op: 'unsubscribe',
      channel: 'book',
      cluster: 'devnet',
      market: 'SOL-USDC',
    });
  });

  it('a forced reconnect drops the socket so every subscription is snapshotted again', () => {
    const { client, sockets, timers } = harness();
    client.subscribe(BOOK, () => undefined);
    sockets[0]!.accept();
    client.reconnect();
    expect(sockets[0]!.readyState).toBe(3);
    timers.pop()!.fn();
    sockets[1]!.accept();
    expect(sockets[1]!.sent[0]).toMatchObject({ op: 'subscribe', channel: 'book' });
  });

  it('stays closed once closed', () => {
    const { client, latest, timers } = harness();
    latest().accept();
    client.close();
    expect(client.state).toBe('closed');
    expect(timers).toEqual([]);
  });
});
