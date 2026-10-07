# ADR-0037: The WebSocket transport

**Status:** accepted · **Date:** 2026-10-07 · **Phase:** S5
**Extends:** ADR-0001 (sessions), ADR-0021 (the cluster dimension), ADR-0033 (what a trader must prove), ADR-0036 (the market-data pipeline)

## Context

Everything live in this codebase polls. S5 adds the first socket, and a socket
quietly steps outside four protections every HTTP route already has:

1. **The CSRF guard passes every safe method**, and an upgrade is a `GET`.
   Browsers do not apply CORS to WebSocket handshakes either. Without an explicit
   check, any site a signed-in user visits can open a socket to this API with
   their cookie attached.
2. **The cluster travels in `X-Solana-Cluster`**, and a browser cannot set a
   header on a WebSocket handshake.
3. **The session guard runs per request.** A socket authenticated once outlives
   logout, revocation and expiry.
4. **The rate limit counts HTTP requests**, not messages on an open socket.

## Decision

### 1. One endpoint, behind `Origin` and a session

`GET /ws`, through `@fastify/websocket`, registered only when trading is enabled
— refused by absence, as the trading routes are.

**`Origin` is checked first, against the one configured web origin.** A missing
or different origin is refused with 403 and no socket is opened. This is its own
check, not the CSRF guard.

**A session is required**, resolved from the session cookie through the same
`SessionManager` the session guard uses. No token is ever accepted in a query
string: URLs are logged by every proxy between the browser and here.

Unauthenticated public market data is a later decision, taken together with
public REST. It does not arrive as a default with the first socket.

### 2. A socket ends when its session does

The session is re-validated on every subscribe and on a timer, every
`WS_SESSION_RECHECK_SECONDS` (default 30). When it is gone the socket is closed
with code `4401`.

**The bound is that interval.** Signing out in one tab ends a socket in another
within it. Nothing private is sent on a socket whose last check failed.

### 3. The cluster is named on every subscription

Each subscribe message carries the cluster. It is validated against the clusters
this deployment serves, exactly as the header is, and **never defaulted**: a
subscription naming no cluster is an error. The wire speaks bare market symbols;
the server resolves the cluster-qualified market.

### 4. Everything a client controls is bounded

| Bound                       | Default | On breach            |
| --------------------------- | ------- | -------------------- |
| Sockets per user            | 5       | upgrade refused, 429 |
| Sockets per IP              | 20      | upgrade refused, 429 |
| Subscriptions per socket    | 20      | closed, `4409`       |
| Inbound message size        | 4 KiB   | closed, `4400`       |
| Inbound messages per second | 20      | closed, `4409`       |
| Outbound buffer             | 1 MiB   | closed, `4408`       |
| Missed heartbeats           | 2       | closed, `4408`       |

A breach closes the socket with a reason. Nothing is ever queued on a client's
behalf.

A client may send three things: subscribe, unsubscribe, and a heartbeat reply.
Anything else is a protocol error (`4400`). **Orders are not accepted over the
socket.** They stay on REST, where the CSRF guard, the idempotency key and the
rate limit already are.

**Closing a socket cancels nothing.** Cancel-on-disconnect is S6, and a
decision.

### 5. A slow consumer is disconnected

Before each send the socket's buffered amount is checked; over the bound, the
socket is closed. The unit of shedding is the connection, never a message:
dropping one book message would silently break the client's sequence check. The
client reconnects and takes a snapshot.

A public message is serialised once and the same bytes are sent to every
subscriber.

### 6. The message contract

Every message, both directions, has a schema in `packages/types`, used by the
server that builds it and the client that parses it. Prices, quantities, amounts
and sequences are strings: a `u64` in a JSON number is corrupted above 2⁵³.

Every outgoing message is built field by field. No event and no database row is
ever forwarded.

**Book.** On subscribe, a snapshot with its `seq`. Then one message per engine
sequence, carrying `seq` and the changed levels — **including sequences that
changed nothing**. The client's whole gap test is that the next `seq` is the
last plus one. When the server's mirror is invalid it sends `book.resync`,
nothing further on that channel, and then a new snapshot.

**Depth is not a server-side filter.** The snapshot is the whole aggregated
book, up to a hard cap of levels per side, and says when it was truncated; level
changes are sent for every level. A client that was sent a filtered book would
miss a change to a level outside its window and never know. How many levels to
draw is the client's decision.

**Trades.** Fill id, price, quantity, taker side, engine timestamp, `seq`, in
`(seq, index)` order. On subscribe, the most recent from the `trades` table.

**Ticker** may be conflated: the latest value replaces its predecessor. The book
and trade channels are never conflated.

### 7. The private channel is a hint, built from PostgreSQL

Its source is the database, after the commit that changed it — never the engine
stream, the gateway's HTTP response or the public tape. A user is told about a
fill when the ledger has it.

**Notify, then read.** After a transaction that changes an order or settles a
fill commits, a notification is published naming the affected user ids and
nothing else. Whichever instance holds that user's socket reads the user's
recently changed orders and new fills from PostgreSQL and sends those. The
notification is published after the commit, never inside the transaction.

An order update is the order's whole current view, so applying it is
replacement and a duplicate converges. A fill update is the user's own side
only: never the counterparty's user id, order id or fee. Balances are not pushed
as numbers; the client is told they may have changed and refetches.

**This channel does not guarantee delivery.** A notification can be lost: the
process can die between the commit and the publish. On every connect and
reconnect the client fetches orders, fills and balances over REST; the channel
only says when to look again. It is a latency optimisation over polling, not a
record.

### 8. Shutdown

Every socket is closed with `1001` before the HTTP server stops, and the stream
readers stop with it.

## Alternatives considered

**A token in the URL for authentication.** Works across origins, and puts a
credential in every access log.

**A cluster per connection, in the query string.** One fewer field per message,
and a socket silently pinned to whatever was chosen at connect while the user
switches network in the interface.

**Dropping messages for slow clients.** Keeps the connection, and makes the
book a client renders wrong without it knowing.

**Pushing balances.** One fewer round trip, and a second place a balance comes
from.

**Server-sent events.** Simpler, one direction, and no subscription message —
each channel a connection of its own against a per-user limit.

## Consequences

- The API now holds long-lived connections, with limits, heartbeats and metrics
  of their own.
- Signing out does not end a socket instantly; it ends it within the re-check
  interval.
- A user who never reconnects and never refetches can be looking at an old order
  list. The private channel makes that unlikely, not impossible.
- Market data is visible to anyone with a session, and to nobody without one.
