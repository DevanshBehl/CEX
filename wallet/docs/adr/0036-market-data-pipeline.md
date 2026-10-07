# ADR-0036: The market-data pipeline

**Status:** accepted · **Date:** 2026-10-07 · **Phase:** S5
**Extends:** ADR-0025 (the engine owns the book), ADR-0026 (fixed point), ADR-0030 (engine transport), ADR-0034 (the event key, halt-don't-skip)

## Context

Until S5 nothing shows a user the market. The engine publishes every event to a
Redis stream, settlement consumes it, and the book exists only inside the engine
and behind `GET /v1/book`.

Four properties of what S1–S4 left behind shape the answer:

1. **The stream cannot rebuild the book.** `Accepted` carries an order id and a
   resting quantity — no side, no price. `Cancelled` carries an order id and a
   remaining quantity. A consumer holding only the stream does not know which
   level an order rested on or left.
2. **A fill's `timestamp_ms` is the gateway-signed command time.** It is
   deterministic across replay and it is not monotonic in sequence order
   (ADR-0031, ADR-0034 §9).
3. **`fills` is not public data.** It carries both user ids, both order ids and
   both fees.
4. **A matched trade is public before it is settled.** The engine publishes a
   fill when it matches; the ledger learns of it when settlement commits.

## Decision

### 1. The engine publishes level changes

After applying a command, the engine reports every `(side, price)` level whose
resting quantity may have changed, with the level's quantity **after** the
command. An emptied level is reported at zero.

They are **absolute quantities, never differences**. Applying one twice leaves a
consumer where it was; applying a difference twice does not.

They are an output _beside_ the event list. The book records which levels each
mutation touched and reads their totals from its own ladders when asked, so
there is no second tally to drift. They are not an `Event`, not journaled, not in
a golden vector and not returned by `GET /v1/events`. `Engine::apply` returns
exactly what it did in S4. The engine is deterministic, so a replayed command
changes the same levels; that is what lets the republish after a crash, or after
a failed publish, carry them.

On the wire they are **one additive field, `levels`, on the last stream entry of
each sequence** — a JSON array of `{side, price, qty}`, `qty` a string as
`GET /v1/book` writes it. A consumer applies them once it has every event of the
sequence. Settlement reads `seq`, `idx` and `event` and ignores the rest.

**Present and empty is not the same as absent.** A sequence that changed no
level carries `[]`. A last entry with no `levels` field means the changes are
unknown, and a consumer treats it exactly like a gap: it takes a new snapshot.

There is no re-emission path for level changes. A consumer that missed a
sequence asks `GET /v1/book` for a snapshot and continues from that snapshot's
`seq`.

A property test proves the claim this decision rests on: applied in order to an
empty book, the level changes of any generated command stream — every order
type, every self-trade mode, cancels and amends — equal the engine's own
aggregated book after every command.

### 2. Three readers of one stream, three positions

| Reader      | Purpose                 | Position                                 | Group |
| ----------- | ----------------------- | ---------------------------------------- | ----- |
| Settlement  | moves money (ADR-0034)  | `engine_offsets`, consumer `settlement`  | yes   |
| Market data | persists the trade tape | `engine_offsets`, consumer `market-data` | yes   |
| Fan-out     | the live book and tape  | in memory, per API instance              | no    |

None reads another's position. None tracks position by Redis id.

The fan-out uses no consumer group, because a group hands each entry to one
member and every API instance must see every entry. Its position is an engine
sequence held in memory; a restart rebuilds it from a snapshot.

### 3. The fan-out's book is a mirror, never an authority

It is one snapshot from `GET /v1/book` at sequence `S0`, plus the level changes
of every sequence in `(S0, S]`. A missing sequence, a missing `levels` field, an
undecodable entry, a stream reset or a restart invalidates it.

An invalid mirror is never served. Subscribers are told the book is
resynchronising and receive a fresh snapshot when there is one; the REST book
answers 503 rather than an old book.

### 4. Public trades come from the stream, into their own table

A `trades` table: market, engine sequence, fill id, the fill's index among its
sequence's fills, price, quantity, taker side, engine timestamp.
`UNIQUE(market, fill_id)`. No order id and no user id — a query that cannot
return one is safer than a serializer that is supposed to drop one. Append-only
by grant and by trigger.

One market-data consumer per market writes it, with `INSERT … ON CONFLICT DO
NOTHING` and its offset advanced **in the same transaction**. It shares the
sequenced-consumer loop with settlement: the same strict decoder, the same gap
recovery through `GET /v1/events`, the same refusal to start with neither an
offset nor a configured starting key.

**Nothing public reads `fills`.** The tape does not wait for settlement, and a
halted settlement worker does not freeze it.

### 5. Halting, at lower stakes

An event the market-data consumer cannot decode halts the persisted tape for
that market at that key. A candle silently missing a trade is the same class of
error as a ledger silently missing a fill.

It stops nothing else: not matching, not settlement, not another market, and not
the live book, which heals through snapshots and does not depend on the
persisted tape.

### 6. Candles are a pure function of `trades`

One stored interval, one minute, keyed by `(market, bucket_start)`: open, high,
low and close as scaled prices, base and quote volume, trade count. Wider
intervals are aggregated from it at read time; storing them would be a second
copy that could disagree with the first.

A trade belongs to the bucket of its `timestamp_ms`. **Within a bucket, order is
`(seq, fill index)`, never timestamp.** Open is the bucket's lowest
`(seq, index)`; close is its highest.

Because timestamps are not monotonic, a trade can land in a bucket that is no
longer the latest. The candle is therefore recomputed from its bucket's trades
and upserted, in the same transaction as the trade insert. It is derived data,
not evidence: it may be updated in place, and a rebuild from `trades` reproduces
every row exactly. A test runs the rebuild and asserts the table is unchanged.

A bucket with no trades has no row. The API returns only buckets that exist and
the client carries the previous close forward. Inventing a flat candle would
make "no trades" indistinguishable from "trades at one price".

Quote volume is `floor(price × qty / PRICE_SCALE)` per trade, summed as
`NUMERIC` — the same integer arithmetic `notional` uses, never a float.

### 7. The ticker, and the one legitimate clock

The 24-hour ticker — last price, change, high, low, volumes — is computed from
candles for the window ending at an injected clock, plus the most recent trade.

**This is the only place in the trading system where the current time is an
input, and it is legitimate only because nothing here is money.** A fee that
depended on when it was computed would be a bug (ADR-0034 §9). A "last 24 hours"
that did not would be meaningless. This is an exception, not a precedent.

A market with no trade in the window has null change, high and low, and its last
price from the most recent trade ever, with that trade's time. Never zero: zero
is a price.

### 8. PostgreSQL, and `recharts`

The store is PostgreSQL. A time-series extension is one more moving part for a
volume this project does not have; one-minute candles for a handful of markets
are a few hundred thousand rows a year.

The chart is drawn with `recharts`, which is already a dependency. A dedicated
charting library is a new dependency and a new audit entry, and nothing in this
phase needs one.

## Alternatives considered

**The gateway derives level changes.** Every engine order has an `orders` row
committed before the engine saw it, so side and price can be looked up; a fill
names its own price. No engine change — and a second implementation of book
arithmetic in another language, which is wrong the first time the engine does
something the mirror did not model. `cancel_maker` self-trade prevention removes
resting orders at prices no fill names. It also makes public market data depend
on the gateway being the engine's only client. Rejected: ADR-0025 says the engine
owns the book.

**The gateway polls `GET /v1/book` and diffs.** No engine change and no second
implementation. It costs a full book read per interval per market on the
engine's single thread, and loses every state between two polls. Rejected for
the live book; it remains exactly how a mirror recovers.

**Level changes inside `Event`.** Would have put them in the journal and the
golden vectors, and invalidated every journal already written.

**Read the tape and candles from `fills`.** Simpler: no second consumer. But it
couples public data to a table of user ids, and stops the tape whenever
settlement halts.

**Store every candle interval.** Faster reads, and two numbers that must agree.

## Consequences

- A user can see the book and the tape, from the engine's own account of each.
- The engine's stream entries carry one more field. Nothing that existed reads
  it.
- There is a second durable consumer to operate, with its own lag metric and its
  own halt.
- Public trade data never touches a row that names a user.
- Candles can change after the fact when a late trade lands. They are derived,
  and the rebuild is the proof.
