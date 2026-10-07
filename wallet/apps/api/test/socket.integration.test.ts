import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  WS_CLOSE,
  WS_PUBLIC_MESSAGE_SCHEMAS,
  wsServerMessageSchema,
  type WsServerMessage,
} from '@wallet/types';
import { createArenas, ONE_SOL, type Arena, type Arenas, type Trader } from './arena.js';
import { seedSession, TEST_CLUSTER, WEB_ORIGIN } from './helpers.js';
import type { HubSocket } from '../src/ws/hub.js';

/**
 * The WebSocket, over a real listening server (prompt_phase_s5.md §17,
 * ADR-0037).
 *
 * Injection cannot test an upgrade, so this suite binds a port and connects
 * with a real client — which, unlike a browser, will send any `Origin` it is
 * told to. That is the point: the checks under test are the ones a browser's
 * own rules do not make for the server.
 */

const LIMITS = {
  maxSocketsPerUser: 2,
  maxSocketsPerIp: 50,
  maxSubscriptions: 4,
  maxMessagesPerSecond: 12,
  maxMessageBytes: 512,
  // Short, so "within the documented bound" is a wait a test can afford.
  sessionRecheckMs: 250,
  heartbeatMs: 200,
};

let t: Arenas;
let url: string;
const open: Client[] = [];

beforeAll(async () => {
  t = await createArenas({ count: 30, socket: LIMITS });
  await t.h.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = t.h.app.server.address() as AddressInfo;
  url = `ws://127.0.0.1:${String(port)}/ws`;
}, 120_000);

afterEach(() => {
  for (const client of open.splice(0)) client.ws.terminate();
});

afterAll(async () => {
  await t.h.cleanup();
});

// --- a client --------------------------------------------------------------

interface Client {
  readonly ws: WebSocket;
  readonly messages: WsServerMessage[];
  /** Every frame as it arrived, for asserting on bytes rather than objects. */
  readonly raw: string[];
  readonly closed: Promise<{ code: number; reason: string }>;
  send(message: unknown): void;
  /** The first message matching, already received or yet to come. */
  next<T extends WsServerMessage['type']>(
    type: T,
    where?: (message: Extract<WsServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<WsServerMessage, { type: T }>>;
  subscribe(channel: string, market?: string): Promise<void>;
}

interface ConnectOptions {
  /** `null` sends no Origin header at all. */
  readonly origin?: string | null;
  readonly cookie?: string | null;
  /** Answer the server's heartbeat. On unless a test is about not answering. */
  readonly pong?: boolean;
}

/** Resolves with a client, or rejects with the HTTP status that refused the upgrade. */
function connect(
  who: Pick<Trader, 'cookie'> | null,
  options: ConnectOptions = {},
): Promise<Client> {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  const cookie = options.cookie === undefined ? (who?.cookie ?? null) : options.cookie;
  if (cookie !== null) headers.cookie = cookie;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages: WsServerMessage[] = [];
    const raw: string[] = [];
    const waiters: Array<{
      test: (m: WsServerMessage) => boolean;
      done: (m: WsServerMessage) => void;
    }> = [];
    let closeResult: (value: { code: number; reason: string }) => void = () => undefined;
    const closed = new Promise<{ code: number; reason: string }>((r) => (closeResult = r));

    ws.on('unexpected-response', (_request, response) => {
      reject(new Error(`upgrade refused: ${String(response.statusCode)}`));
      response.resume();
    });
    ws.on('error', () => undefined);
    ws.on('close', (code, reason) => closeResult({ code, reason: reason.toString() }));
    ws.on('message', (data) => {
      const text = (data as Buffer).toString('utf8');
      // Parsed with the SAME schema the web client uses: a message the server
      // sends and the contract does not describe fails here.
      const message = wsServerMessageSchema.parse(JSON.parse(text));
      if (message.type === 'ping') {
        if (options.pong !== false) ws.send(JSON.stringify({ op: 'pong' }));
        return;
      }
      raw.push(text);
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.test(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done(message);
        }
      }
    });
    ws.on('open', () => {
      const client: Client = {
        ws,
        messages,
        raw,
        closed,
        send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
        next(type, where) {
          const test = (m: WsServerMessage) =>
            m.type === type && (where ? where(m as never) : true);
          const already = messages.find(test);
          if (already) return Promise.resolve(already as never);
          return new Promise((done, fail) => {
            const timer = setTimeout(
              () =>
                fail(
                  new Error(
                    `no ${type} message within 5s; got ${messages.map((m) => m.type).join(', ')}`,
                  ),
                ),
              5_000,
            );
            waiters.push({
              test,
              done: (m) => {
                clearTimeout(timer);
                done(m as never);
              },
            });
          });
        },
        async subscribe(channel, market) {
          client.send({
            op: 'subscribe',
            channel,
            cluster: TEST_CLUSTER,
            ...(market ? { market } : {}),
          });
          await client.next('subscribed', (m) => m.channel === channel);
        },
      };
      open.push(client);
      resolve(client);
    });
  });
}

const settled = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hub = () => t.h.app.trading!.hub!;

// ---------------------------------------------------------------------------

describe('the upgrade', () => {
  it('refuses a foreign origin, a missing origin, and anyone without a live session', async () => {
    const a = t.market();
    const who = await t.trader(a);

    // The check the CSRF guard does NOT make: an upgrade is a GET.
    await expect(connect(who, { origin: 'https://evil.example' })).rejects.toThrow('403');
    await expect(connect(who, { origin: null })).rejects.toThrow('403');
    await expect(connect(null)).rejects.toThrow('401');
    await expect(connect(who, { cookie: `${who.cookieName}=not-a-session` })).rejects.toThrow(
      '401',
    );
    expect(hub().size()).toBe(0);

    const refusals = t.h.logs.entries().filter((entry) => entry.event === 'ws.upgrade_refused');
    expect(refusals.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(['origin', 'session']),
    );

    const client = await connect(who);
    expect(hub().size()).toBe(1);
    client.ws.close();
  });

  it('never accepts a session in the URL', async () => {
    const a = t.market();
    const who = await t.trader(a);
    const token = who.cookie.slice(who.cookie.indexOf('=') + 1);
    const before = url;
    url = `${before}?session=${encodeURIComponent(token)}&${who.cookieName}=${encodeURIComponent(token)}`;
    try {
      await expect(connect(null)).rejects.toThrow('401');
    } finally {
      url = before;
    }
  });

  it('bounds the sockets one user may hold', async () => {
    const a = t.market();
    const who = await t.trader(a);
    await connect(who);
    await connect(who);
    await expect(connect(who)).rejects.toThrow('429');
    // Someone else is unaffected.
    await connect(await t.trader(a));
  });
});

describe('the protocol', () => {
  async function closeCode(send: (client: Client) => void): Promise<number> {
    const a = t.market();
    const client = await connect(await t.trader(a));
    send(client);
    return (await client.closed).code;
  }

  it('closes on anything that is not subscribe, unsubscribe or a heartbeat reply', async () => {
    expect(await closeCode((c) => c.send('not json'))).toBe(WS_CLOSE.protocolError);
    expect(await closeCode((c) => c.send({ op: 'place', side: 'buy' }))).toBe(
      WS_CLOSE.protocolError,
    );
    // Orders are NOT accepted over the socket, however well-formed.
    expect(
      await closeCode((c) =>
        c.send({
          op: 'subscribe',
          channel: 'book',
          cluster: TEST_CLUSTER,
          market: 'SOL-X',
          extra: 1,
        }),
      ),
    ).toBe(WS_CLOSE.protocolError);
    expect(await closeCode((c) => c.send({ op: 'pong', padding: 'x'.repeat(600) }))).toBe(
      WS_CLOSE.protocolError,
    );
  });

  it('the cluster is named on every subscription and never defaulted', async () => {
    // No cluster at all is not "the default cluster": it is not a subscription.
    expect(
      await closeCode((c) => c.send({ op: 'subscribe', channel: 'book', market: 'SOL-X' })),
    ).toBe(WS_CLOSE.protocolError);

    const a = t.market();
    const client = await connect(await t.trader(a));
    const other = (['devnet', 'testnet', 'localnet'] as const).find((c) => c !== TEST_CLUSTER)!;
    client.send({ op: 'subscribe', channel: 'book', cluster: other, market: a.symbol });
    expect((await client.next('error')).code).toBe('cluster_not_served');
    // Refused, with the socket open and nothing subscribed.
    client.send({ op: 'subscribe', channel: 'book', cluster: TEST_CLUSTER, market: 'NOPE-NOPE' });
    await client.next('error', (m) => m.code === 'unknown_market');
    client.send({ op: 'subscribe', channel: 'book', cluster: TEST_CLUSTER });
    await client.next('error', (m) => m.code === 'market_required');
    expect(client.messages.every((m) => m.type === 'error')).toBe(true);
  });

  it('closes a socket that subscribes past its limit, or sends too fast', async () => {
    const a = t.market();
    const client = await connect(await t.trader(a));
    for (const channel of ['book', 'trades', 'ticker']) await client.subscribe(channel, a.symbol);
    await client.subscribe('account');
    // The fifth distinct subscription.
    const b = t.market();
    client.send({ op: 'subscribe', channel: 'book', cluster: TEST_CLUSTER, market: b.symbol });
    expect((await client.closed).code).toBe(WS_CLOSE.limitExceeded);

    expect(
      await closeCode((c) => {
        for (let i = 0; i < 30; i += 1) c.send({ op: 'pong' });
      }),
    ).toBe(WS_CLOSE.limitExceeded);
  });

  it('closes a socket that stops answering the heartbeat', async () => {
    const a = t.market();
    const client = await connect(await t.trader(a), { pong: false });
    expect((await client.closed).code).toBe(WS_CLOSE.slowConsumer);
  });
});

describe('a session that ends', () => {
  it('ends its sockets within the re-check interval', async () => {
    const a = t.market();
    const who = await t.trader(a);
    const client = await connect(who);
    await client.subscribe('account');

    const revokedAt = Date.now();
    await t.h.app.appDeps.sessions.revoke(who.sessionId, who.userId);
    const { code } = await client.closed;
    expect(code).toBe(WS_CLOSE.sessionEnded);
    // The documented bound, with room for the timer and the lookup.
    expect(Date.now() - revokedAt).toBeLessThan(LIMITS.sessionRecheckMs * 4);
    expect(t.h.logs.entries().some((entry) => entry.event === 'ws.session_ended')).toBe(true);
  });

  it('a subscription on a dead session is refused by closing, not served', async () => {
    const a = t.market();
    const who = await t.trader(a);
    const client = await connect(who);
    await t.h.app.appDeps.sessions.revoke(who.sessionId, who.userId);
    client.send({ op: 'subscribe', channel: 'account', cluster: TEST_CLUSTER });
    expect((await client.closed).code).toBe(WS_CLOSE.sessionEnded);
    expect(client.messages).toEqual([]);
  });
});

describe('the book and the tape', () => {
  async function resting(a: Arena, seller: Trader, prices: string[]) {
    for (const price of prices) await t.sell(a, seller, { price });
    await t.fan(a);
  }

  it('a snapshot, then one message per sequence with nothing missing', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    await resting(a, seller, ['151000000']);

    const client = await connect(buyer);
    await client.subscribe('book', a.symbol);
    await client.subscribe('trades', a.symbol);
    const snapshot = await client.next('book.snapshot');
    expect(snapshot).toMatchObject({
      cluster: TEST_CLUSTER,
      market: a.symbol,
      seq: '1',
      bids: [],
      asks: [['151000000', ONE_SOL.toString()]],
      truncated: false,
    });

    await t.sell(a, seller, { price: '152000000' });
    await t.buy(a, buyer, { price: '151000000' });
    // A command that changes no level still has a sequence.
    a.engine.changeStatus();
    await t.fan(a);

    await client.next('book.delta', (m) => m.seq === '4');
    const deltas = client.messages.filter((m) => m.type === 'book.delta');
    // Contiguous from the snapshot: the client's whole gap test.
    expect(deltas.map((m) => m.seq)).toEqual(['2', '3', '4']);
    expect(deltas.map((m) => m.changes)).toEqual([
      [['sell', '152000000', ONE_SOL.toString()]],
      // The level emptied: zero, not an absence.
      [['sell', '151000000', '0']],
      [],
    ]);
    const trade = await client.next('trade');
    expect(trade.trade).toMatchObject({ id: '3:0', price: '151000000', takerSide: 'buy' });
  });

  it('no public message can carry an order id or a user id', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    const watcher = await connect(await t.trader(a));
    await t.fan(a);
    for (const channel of ['book', 'trades', 'ticker']) await watcher.subscribe(channel, a.symbol);

    const maker = await t.sell(a, seller);
    const taker = await t.buy(a, buyer);
    await t.pump(a);
    await watcher.next('trade');

    const everything = watcher.raw.join('\n');
    for (const secret of [maker.id, taker.id, seller.userId, buyer.userId]) {
      expect(everything).not.toContain(secret);
    }
    // And by construction: every public schema is strict, so a field that is
    // not named in it does not parse — there is no key an id could travel in.
    for (const schema of WS_PUBLIC_MESSAGE_SCHEMAS) {
      const sample = watcher.messages.find((m) => m.type === schema.shape.type.value);
      if (!sample) continue;
      expect(schema.safeParse({ ...sample, orderId: maker.id }).success).toBe(false);
      expect(schema.safeParse({ ...sample, userId: seller.userId }).success).toBe(false);
    }
  });

  it('a hole in the stream is announced, then healed by a snapshot', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    await t.fan(a);
    const client = await connect(await t.trader(a));
    await client.subscribe('book', a.symbol);
    await client.next('book.snapshot');

    await t.sell(a, seller, { price: '151000000' });
    await t.sell(a, seller, { price: '152000000' });
    await a.fanoutSource.publish();
    a.fanoutSource.drop((entry) => entry.seq === 1n);
    const fanout = t.h.app.trading!.fanouts.get(a.symbol)!;
    await fanout.runOnce();
    await client.next('book.resync');
    // Nothing was applied across the hole.
    expect(client.messages.some((m) => m.type === 'book.delta')).toBe(false);

    await fanout.runOnce();
    const healed = await client.next('book.snapshot', (m) => m.seq === '2');
    expect(healed.asks).toEqual([
      ['151000000', ONE_SOL.toString()],
      ['152000000', ONE_SOL.toString()],
    ]);
  });

  it('a dropped connection reconnects, resubscribes and holds the server’s book', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const who = await t.trader(a);
    await resting(a, seller, ['151000000']);

    const first = await connect(who);
    await first.subscribe('book', a.symbol);
    await first.next('book.snapshot');
    first.ws.terminate();
    await first.closed;

    // The market moves while nobody is listening.
    await t.sell(a, seller, { price: '152000000' });
    await t.fan(a);

    const second = await connect(who);
    await second.subscribe('book', a.symbol);
    const snapshot = await second.next('book.snapshot');
    const book = t.h.app.trading!.fanouts.get(a.symbol)!.book()!;
    expect(snapshot.seq).toBe(book.seq.toString());
    expect(snapshot.asks).toEqual(book.asks.map((l) => [l.price.toString(), l.qty.toString()]));
  });

  it('a client that is not reading is disconnected, and everyone else keeps receiving', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const slowUser = await seedSession(t.h);
    await t.fan(a);

    // A socket whose send buffer is already past the bound: a client that has
    // stopped reading, without waiting for a kernel buffer to fill.
    const closes: number[] = [];
    const sent: string[] = [];
    const stuck: HubSocket = {
      bufferedAmount: 10 * 1024 * 1024,
      send: (data) => void sent.push(data),
      close: (code) => void closes.push(code),
    };
    const connection = hub().attach(
      {
        userId: slowUser.userId,
        ip: '10.0.0.9',
        sessionToken: slowUser.cookie.slice(slowUser.cookie.indexOf('=') + 1),
      },
      stuck,
    );
    // It can still ASK: the subscribe is processed. What it cannot do is be owed.
    Object.assign(stuck, { bufferedAmount: 0 });
    connection.onMessage(
      JSON.stringify({ op: 'subscribe', channel: 'book', cluster: TEST_CLUSTER, market: a.symbol }),
    );
    await settled(100);
    Object.assign(stuck, { bufferedAmount: 10 * 1024 * 1024 });

    const healthy = await connect(await t.trader(a));
    await healthy.subscribe('book', a.symbol);
    await healthy.next('book.snapshot');

    await t.sell(a, seller, { price: '151000000' });
    await t.fan(a);

    // The connection is shed. No message was dropped FOR it and kept.
    expect(closes).toEqual([WS_CLOSE.slowConsumer]);
    expect(sent.some((frame) => frame.includes('book.delta'))).toBe(false);
    await healthy.next('book.delta', (m) => m.seq === '1');
  });
});

describe('the private channel', () => {
  it('each user receives exactly their own side, and nothing about anyone else', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    const stranger = await t.trader(a);
    await t.fan(a);
    const sockets = {
      seller: await connect(seller),
      buyer: await connect(buyer),
      stranger: await connect(stranger),
    };
    // Subscribed to EVERYTHING each may ask for.
    for (const client of Object.values(sockets)) {
      await client.subscribe('account');
      for (const channel of ['book', 'trades', 'ticker']) await client.subscribe(channel, a.symbol);
    }

    const maker = await t.sell(a, seller);
    const taker = await t.buy(a, buyer);
    await t.pump(a);

    const sellerFill = await sockets.seller.next('fill');
    const buyerFill = await sockets.buyer.next('fill');
    expect(sellerFill.fill).toMatchObject({ orderId: maker.id, side: 'sell', role: 'maker' });
    expect(buyerFill.fill).toMatchObject({ orderId: taker.id, side: 'buy', role: 'taker' });
    await sockets.seller.next(
      'order',
      (m) => m.order.id === maker.id && m.order.status === 'FILLED',
    );
    await sockets.buyer.next(
      'order',
      (m) => m.order.id === taker.id && m.order.status === 'FILLED',
    );
    // Told to look, never told a number.
    await sockets.buyer.next('balances.changed');
    await settled(300);

    const privateOf = (client: Client) =>
      client.messages.filter((m) => m.type === 'order' || m.type === 'fill');
    for (const m of privateOf(sockets.seller)) {
      expect(m.type === 'order' ? m.order.id : m.fill.orderId).toBe(maker.id);
    }
    for (const m of privateOf(sockets.buyer)) {
      expect(m.type === 'order' ? m.order.id : m.fill.orderId).toBe(taker.id);
    }
    // On the bytes: neither socket was sent the other's order, user or fee.
    const sellerBytes = sockets.seller.raw.join('\n');
    const buyerBytes = sockets.buyer.raw.join('\n');
    for (const secret of [taker.id, buyer.userId]) expect(sellerBytes).not.toContain(secret);
    for (const secret of [maker.id, seller.userId]) expect(buyerBytes).not.toContain(secret);
    expect(sellerFill.fill.fee).not.toBe(buyerFill.fill.fee);
    expect(buyerBytes).not.toContain(`"fee":"${sellerFill.fill.fee}"`);
    expect(sellerBytes).not.toContain(`"fee":"${buyerFill.fill.fee}"`);

    // A third user, subscribed to the same market, saw the PUBLIC trade and
    // received nothing private at all.
    await sockets.stranger.next('trade');
    expect(privateOf(sockets.stranger)).toEqual([]);
    const strangerBytes = sockets.stranger.raw.join('\n');
    for (const secret of [maker.id, taker.id, seller.userId, buyer.userId]) {
      expect(strangerBytes).not.toContain(secret);
    }
  });

  it('shows a fill when the ledger has it, not when the tape does', async () => {
    const a = t.market();
    const seller = await t.trader(a);
    const buyer = await t.trader(a);
    const client = await connect(buyer);
    await client.subscribe('account');
    await client.subscribe('trades', a.symbol);
    await t.fan(a);

    await t.sell(a, seller);
    const taker = await t.buy(a, buyer);
    // Matched and public; not settled.
    await t.fan(a);
    await client.next('trade');
    await client.next('order', (m) => m.order.id === taker.id);
    await settled(300);
    expect(client.messages.some((m) => m.type === 'fill')).toBe(false);
    const matched = client.messages.filter((m) => m.type === 'order').at(-1)!;
    // Open, nothing filled as far as the ledger knows.
    expect(matched).toMatchObject({ order: { status: 'OPEN', filledQty: '0' } });

    await t.settle(a);
    expect((await client.next('fill')).fill.orderId).toBe(taker.id);
  });

  it('a socket that never subscribed to its account is sent nothing private', async () => {
    const a = t.market();
    const who = await t.trader(a);
    const client = await connect(who);
    await client.subscribe('ticker', a.symbol);
    await t.buy(a, who);
    await settled(400);
    expect(client.messages.some((m) => m.type === 'order' || m.type === 'fill')).toBe(false);
  });
});
