# The matching engine's control plane

Reference for `services/matching`'s HTTP surface, added in Phase S2. The
decisions are in [ADR-0030](../adr/0030-engine-transport-and-backpressure.md)
and [ADR-0031](../adr/0031-engine-authentication-and-replay.md); this is the
shape and the reasoning you need while reading the code.

The engine's only legitimate caller is the order gateway. An end user never
reaches it, and anything that can reach it can trade without a hold.

## Endpoints

| Method   | Path                 | Purpose                                                  |
| -------- | -------------------- | -------------------------------------------------------- |
| `POST`   | `/v1/orders`         | place                                                    |
| `DELETE` | `/v1/orders/:id`     | cancel                                                   |
| `PATCH`  | `/v1/orders/:id`     | amend — atomic cancel-and-replace, losing time priority  |
| `GET`    | `/v1/orders/lookup`  | journal-backed: "do you have this client order id?"      |
| `GET`    | `/v1/events`         | re-emit from a sequence                                  |
| `GET`    | `/v1/book`           | authoritative depth snapshot, for S5's resnapshot-on-gap |
| `POST`   | `/v1/markets/status` | `pre_open` / `open` / `post_only` / `halted`             |
| `GET`    | `/v1/health`         | unauthenticated; reveals no order                        |

Every mutating endpoint returns the events the command produced, in emission
order, exactly as `Engine::apply` emitted them.

## Status codes

**A rejected order is a 200 carrying a `Rejected` event.** A rejection is a
business outcome the engine computed; a 4xx says the request never got that far.
Conflating them leaves the gateway unable to tell "your order was refused" from
"your request was malformed".

| Status | Meaning                                                               |
| ------ | --------------------------------------------------------------------- |
| 200    | the command was processed — including when it was rejected            |
| 400    | malformed body                                                        |
| 401    | missing, stale or invalid signature                                   |
| 404    | unknown route                                                         |
| 409    | **replayed request id** — its own code, distinct from a bad signature |
| 503    | the events did not reach the stream — **ambiguous**, see below        |

### 503 does not mean "did not happen"

The command is journaled and the book has mutated before publication is
attempted. A 503 means the caller lost _certainty_, not the order.

Resolve it with `/v1/orders/lookup`, never by retrying blind. S3's gateway must
not treat 503 as a failure to act — it is the same shape as the wallet's
ambiguous broadcast, and it has the same answer: ask, do not guess.

## The canonical string

```
method \n path-and-query \n request_id \n hex(sha256(body)) \n timestamp
```

Copied from `services/mpc` field for field. Field-separated by a character that
cannot appear in any field, so `("ab","c")` and `("a","bc")` cannot collide. The
body is covered by its hash, so the string stays bounded and nothing tempts a
maintainer to log it.

Headers: `x-atlas-signature`, `x-atlas-timestamp`, `x-atlas-request-id`.

**The query string is part of what is signed.** Verifying the path alone would
leave every query parameter unsigned, so a captured `GET /v1/events?after=0`
could be rewritten to `after=999999` — same path, empty body, still a valid
signature. The signature covers exactly the bytes that arrived, which is also
why an empty body hashes as empty rather than as the string `null`.

## The replay cache

`services/mpc` has none and does not need one: `/v1/sign` is idempotent on
`requestId`. Placing an order is not — `Engine::place` rejects a duplicate order
id only while that id is still _resting_, so a replayed placement of an order
that already filled and left the book mints a second trade.

The cache holds request ids seen inside the tolerance window, and its TTL **is**
that window. Once a timestamp falls outside tolerance the clock check refuses
the request regardless, so an older entry cannot change an outcome and evicting
it is free. Memory is bounded by rate x window, never by uptime.

It is in memory and lost on restart, which is sufficient because a request
signed before the restart is outside tolerance by the time the process is
serving again.

## Write path

```
1. assign a monotonic u64 sequence      \
2. append the command to the journal     |  under the runtime mutex
3. fsync                                 |
4. match in memory                      /
5. XADD to the stream, in sequence order    <- mutex released, egress lock held
6. acknowledge the request
```

Steps 1–4 are [ADR-0028](../adr/0028-engine-durability-and-replay.md)'s.

**The mutex is released before the network call.** A Redis stall inside the
critical section would halt matching for everyone — a delivery problem turned
into a trading outage.

**Ordering survives that** through hand-over-hand locking in `Service::submit`:
the egress lock is acquired while the runtime lock is still held, so publication
order is sequence order. Matching stays concurrent with publishing; publishing
stays serial with itself. Nothing in the crate may take these locks the other
way round.

## Crash between the journal and the stream

The window at step 4–5 is real: the command is durable, the events are not
published.

The engine persists a **published watermark** — the highest sequence confirmed
into the stream — fsynced on a cadence rather than per event. On boot, after
recovery, it republishes every event from the watermark forward by re-deriving
them from the journal.

Republishing an event a consumer already saw is safe, because settlement is
idempotent by construction. Skipping one is not. That asymmetry is why the
watermark may lag its true value and must never lead it.

Verified end to end: hard-kill the process with the watermark unflushed, delete
the Redis stream, restart — every event is re-derived and republished.

## Re-emission

`GET /v1/events?after=<seq>` serves from a bounded in-memory ring when it
reaches back far enough, and from a journal replay when it does not.

Events are not journaled; commands are. That keeps events a _function_ of the
journal rather than a second artefact that can disagree with it. A request that
falls out of the ring is logged at `warn` — correct, but a consumer that
routinely needs it is broken.

Re-emission never takes the runtime lock: it is a read and must not disturb the
live engine.

## The lookup, and why it reads the journal

S3's sweeper reverses a hold when the engine says it never saw an order. An
order accepted and immediately filled in full is **gone from the book and
present in the journal** — consulting the book would report it missing and the
sweeper would release a hold against a fill that really happened.

The response distinguishes three cases and never collapses them:

- `never_seen` — the engine has no record
- `seen` — with the sequence and the **engine's** order id, which is what every
  event carries
- `rebuilding` — the index cannot answer yet

`rebuilding` is its own answer deliberately. A sweeper that reads it as
`never_seen` reverses a live hold.
