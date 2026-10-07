# ADR-0034: The settlement pipeline

**Status:** accepted · **Date:** 2026-10-01 · **Phase:** S4
**Extends:** ADR-0025 (two-tier clearing), ADR-0029 (fees), ADR-0030 (engine transport), ADR-0032 (trading-tier accounts)

## Context

Until S4 a matched order moves no money. The engine journals fills and publishes
them; nothing consumes them, and every S3 hold simply stays held.

Settlement is where that changes, and it is the part of the exchange where a bug
is least likely to be noticed. A double-settled fill balances. A skipped fill
balances. A fee at the wrong rate balances. Double-entry proves the books are
internally consistent, not that they describe what happened. Every decision below
is about making the failure modes that _do_ balance impossible, or loud.

Five properties of what S1–S3 left behind shape the answer:

1. Delivery is at-least-once. The engine republishes from its watermark after a
   crash (ADR-0028), and a publish that times out halfway is retried.
2. One engine command can emit many events, and they share one `seq`.
3. A fill id is `seq:k` where `k` counts **fills**, not events — an amend emits
   `Cancelled` before the replacement's fills.
4. A maker has no disposition event. It learns it was filled to zero from a fill
   inside someone else's command.
5. No database constraint refused a negative user balance (ADR-0025, correction
   of 2026-09-22).

## Decision

### 1. One event key: `(seq, idx)`

Every stream entry carries `idx`, the event's position within its command's event
list, from 0. The engine is deterministic, so a command's event list — and every
event's position in it — is the same on every replay. `(seq, idx)` is therefore a
stable, unique key for every event the engine has ever emitted.

The field is additive: one more `XADD` field, no change to `Engine::apply`, the
journal, the snapshot or the golden vectors.

`GET /v1/events` returns events in emission order and is changed to **cut pages
only at sequence boundaries**: a page may exceed `limit` to finish the sequence it
is in. A consumer recovering through it assigns `idx` by position within each
`seq` and arrives at exactly the keys the stream carried. Without the boundary
rule, a page ending mid-sequence would silently mis-key everything after it.

A fill id is never derived from an event key, nor the reverse.

### 2. One writer of fill-driven state

The settlement worker is the only writer of fill consumption, `filled_qty`, the
`PARTIALLY_FILLED` and `FILLED` transitions, and every terminal release of a hold
that a fill touched.

The gateway keeps what it owns: the order row, the hold, and `PENDING_ENGINE →
OPEN`. It also keeps `finalizeUnfilled` — releasing the whole hold of an order
that **provably never filled** (rejected, expired with no fills in the same
response, cancelled at full quantity, never seen by the engine). Those releases
and the worker's are serialised the same way every time:

1. the guarded status transition runs first, inside the transaction;
2. only its winner posts a release;
3. `ledger_transactions_order_release_uniq` refuses a second release if two paths
   ever race from different states.

Every release path computes its amount with one function — the order's
**outstanding hold** — and the gateway's paths assert that outstanding equals
`hold_amount`. That assertion is the proof that "never filled" was true.

### 3. The fill record and the trade posting

A `fills` row records the fill id, event key, market, engine sequence, both order
ids, taker side, price, quantity, notional, both fee rates and amounts, the fill's
engine timestamp and the settlement's ledger transaction id. `UNIQUE(fill_id)`.

One fill is one `trade_settle` ledger transaction, referenced by **fill id**,
with the quote and base legs each balancing on their own:

```
quote   debit  user_order_locked[buyer]        notional + buyer_fee
        credit user_trading_available[seller]  notional - seller_fee
        credit house_trading_fees              buyer_fee + seller_fee
base    debit  user_order_locked[seller]       qty
        credit user_trading_available[buyer]   qty
```

A leg whose amount is zero is omitted, because the ledger refuses zero entries: a
small fill can floor its fee, or even its notional, to zero.

The buyer is the taker when `taker_side` is `buy`, otherwise the maker. It is
derived once and tested in both directions, because getting it backwards charges
the taker rate to the wrong party and still balances.

### 4. Idempotency by constraint

```sql
CREATE UNIQUE INDEX ledger_transactions_trade_fill_uniq
  ON ledger_transactions (reference_id) WHERE kind = 'trade_settle';
```

Partial, never global: one withdrawal already produces several ledger
transactions sharing `(reference_type, reference_id)`. The `fills` insert is
`ON CONFLICT (fill_id) DO NOTHING RETURNING`; zero rows means already settled,
and the worker commits nothing further except its offset. Nothing catches a
constraint violation inside a transaction.

`trade_settle` is added to the enum in its own migration. PostgreSQL cannot use
an enum value in the transaction that created it, so the index naming it lives in
the next migration.

### 5. Position: an offset per market, in the same transaction

`engine_offsets` holds one row per (consumer, market): the last fully applied
`(seq, idx)`. It advances **in the same database transaction** as the work it
records. `XACK` happens only after that commit. The offset is never read from
Redis; Redis ids do not survive a stream being recreated.

Events are applied in `(seq, idx)` order. Sequences are contiguous — every
command emits at least one event — so a jump is a gap, and a gap, a missing
stream, a trimmed stream or a recreated stream are all recovered the same way:
`GET /v1/events?after=<settled seq>`, skipping keys at or below the offset.

**Starting position is configuration, never a default.** With no offset row, the
worker refuses to start unless a starting key is configured for that market.
`(0, 0)` backfills every S3-era fill, which is correct, because their holds are
still held. A market that ever carried S2 load-client traffic has its journal
reset before settlement is enabled on it.

### 6. Holds are consumed per fill and released once, at the terminal event

An order's outstanding hold is `hold_amount − Σ consumed by its fills − Σ
released`, derived from the ledger. It is never a column.

Before posting, inside the same `SERIALIZABLE` transaction, the worker asserts
each side's consumption fits its outstanding hold. If not, it does not post: it
halts (§8).

An order is terminal when `filled_qty` reaches `qty`, **whichever event does
it** — for a maker, a fill in someone else's command — or on `Cancelled`,
`Expired`, or a `Rejected` other than `UnknownOrder`. At that point whatever is
still outstanding is released once. That release is the only refund mechanism:
it returns a market buy's collar over-hold and the unused worst-case fee
headroom. A release whose outstanding amount is zero posts nothing.

_Amended 2026-10-07 (S5): `PENDING_CANCEL → EXPIRED` is legal too, and
`Expired` is applied from `PENDING_CANCEL`. An IOC that fills in part expires its
remainder in the same engine command; until settlement applies that command the
gateway shows the order `OPEN`, its owner can cancel it, the cancel finds nothing
in the book, and the order is left `PENDING_CANCEL` when the `Expired` arrives.
Found by driving the real engine with a generated order flow: the market
halted._

`OPEN → CANCELLED` and `PARTIALLY_FILLED → CANCELLED` become legal. A `Cancelled`
is a fact about the book; the gateway can lose the race to move an order to
`PENDING_CANCEL` first, and refusing to record what the engine did would only
halt the market. A partial fill on a `PENDING_CANCEL` order patches `filled_qty`
and leaves the status alone, so the in-flight cancel is not forgotten.

### 7. The database refuses a negative trading balance

**Decided: yes.** A deferred constraint trigger on `ledger_entries` refuses to
commit any transaction that leaves a user's `user_trading_available`,
`user_order_locked` or `user_trading_locked` balance below zero for the account
it touched.

§6's check remains the primary guard, and it halts with a clear key. The trigger
turns a bug in §6 from a negative balance that commits into a transaction that
does not — at the cost of one balance sum per touched trading account per commit.
Custody-tier accounts are unchanged; their existing locks are not in scope here.

### 8. Halt, don't skip

An event the worker cannot settle — unknown order, an order in the wrong market
or asset, over-consumption, an undecodable event, a status the event cannot
legally follow — **stops that market's worker at that key**. It is not skipped
and not parked in the in-memory dead-letter queue, and the offset does not pass
it. A skip settles every later fill for the same users against a ledger missing
one. A park is a skip that a restart makes permanent.

Transient failures (serialization conflicts, lost connections) retry with bounded
backoff first. A halt is loud — an error log naming only the event key, a metric,
an operator runbook — and stops only that market; each market has its own stream
and offset.

### 9. Fees: per-day tier snapshots, one quote asset

Fees are charged in the quote asset at `floor(notional × bps / 10 000)`.

**The tier is fixed per user per UTC day.** It comes from quote volume in fills
whose engine timestamp lies in the 30 days before that day's 00:00 UTC. It is
written once to an immutable `fee_tier_snapshots` row the first time any market
needs it, and never recomputed.

An exact rolling window ending at each fill is not reproducible here. Fill
timestamps are gateway-signed and only bounded by the engine's tolerance window,
so they are not monotonic in sequence order. Each market settles on its own
worker, so the fills "before" a given fill depend on which worker ran first. The
snapshot depends only on recorded data. The accepted consequence: a market that
settles very late, such as one recovered from a halt, cannot change a snapshot
that already exists.

**Volume is summed across markets only because every market shares one quote
asset.** That is enforced when markets load. Quote base units of different assets
do not add up, and pricing volume through ADR-0022 would make fees depend on a
price feed.

The rate and amount are recorded on the `fills` row, so a settlement is auditable
without recomputing anything. `now()` appears nowhere in fee computation. The
engine's `Fill.maker_fee` / `taker_fee` stay `None` forever: the engine never sees
a tier.

## Alternatives considered

**The gateway settles fills from its own HTTP response.** It sees the fills first.
But a 503 means the gateway saw nothing that the engine journaled, and a second
writer of the same state is a double release waiting for a race. The stream is
the only source.

**Track position by Redis id.** Simpler to code and wrong the first time the
stream is recreated.

**Advance the offset after commit, separately.** Either ahead of the ledger (a
skipped fill) or behind it. Behind is safe only because of §4, and ahead is not
safe at all. One transaction removes the question.

**No database non-negative constraint.** Cheaper commits, and the earlier
position (ADR-0025's correction). Rejected for S4, because S4 is the first phase
where a computation, rather than a single read-then-post, decides how much is
debited from a hold.

**Exact rolling 30-day tier window.** Matches ADR-0029's wording literally.
Rejected because it is not reproducible across independent per-market workers
(§9).

## Consequences

- Trades move money. A fill settles exactly once, whatever the delivery count.
- A halted market stops settling until a person intervenes. That is the correct
  failure, and it needs a runbook (`docs/runbooks/settlement-halted.md`).
- Every trading-tier commit pays for a balance check on each user account it
  touches.
- Adding a market with a different quote asset requires a new decision on
  volume, not a configuration change.
- The gateway's `finalizeUnfilled` survives, but it now asserts its own
  precondition rather than assuming it.
