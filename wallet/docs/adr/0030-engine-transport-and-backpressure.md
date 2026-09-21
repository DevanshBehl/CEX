# ADR-0030: Engine transport, backpressure and re-emission

**Status:** accepted · **Date:** 2026-09-21 · **Phase:** S2
**Extends:** ADR-0025 (CLOB and two-tier clearing), ADR-0028 (durability and replay)

## Context

S1's engine is a library: correct, deterministic, and unreachable. S2 gives it a
way in and a way out, and the way out is the harder half.

[ADR-0025](./0025-clob-and-two-tier-clearing.md) makes settlement a consumer of a
sequenced event stream. [ADR-0028](./0028-engine-durability-and-replay.md) makes
the engine's write-ahead journal the source of truth for sequencing and Redis
merely transport. Neither says what happens when the transport is unavailable,
and "unavailable" is not hypothetical — Redis will be unreachable at some point,
and a policy nobody decided becomes whatever the first `?` operator did.

The failure that matters is asymmetric. A refused order is a client retrying. A
**dropped execution report** is a fill that happened, that the ledger never
learns about, and that no reconciliation can reconstruct — because the only other
record of it is the stream that just proved it can lose things.

There is a second question underneath. The gateway will ask the engine to place
an order and will get an answer. What does that answer _mean_? If it means "the
book changed" but not "anyone downstream will hear about it", then a successful
response is compatible with a fill that never settles.

## Decision

**Egress is blocking: the ingress request is not acknowledged until the events it
produced are in the stream. The engine never holds its runtime mutex across a
network call, and the journal is the backstop that makes both safe.**

### The ordering, extended from ADR-0028

```
1. assign a monotonic u64 sequence
2. append the command to the journal
3. fsync                          <- the command has now happened
4. match in memory                <- the book mutates
5. XADD to the stream, in sequence order
6. acknowledge the HTTP request   <- only now
```

Steps 1–4 are ADR-0028's, unchanged. Step 5 is new, and step 6 is the contract:
**a 2xx response means the events reached the stream.** A caller that got one
never has to wonder whether settlement will see the fill.

### The mutex is released before the network call

Steps 1–4 happen under the runtime mutex. Step 5 does not.

Holding the mutex across `XADD` would put a network stall inside the critical
section, and a market that stops matching because Redis is slow is a market
halted by an infrastructure hiccup. That is the one thing this design will not
trade for simplicity.

Releasing the mutex before publishing reintroduces an ordering problem: two
requests matched at sequences 5 and 6 could publish out of order. So publishing
is funnelled through a **single ordered publisher**, and a request waits for its
own sequence to be confirmed before it acknowledges. Matching stays concurrent
with publishing; publishing stays serial with itself.

### When the stream is unreachable

`XADD` fails or times out ⇒ the request is **not acknowledged**. It returns 503.

The command has still happened — it is journaled and the book has mutated, and
neither is reversible. What the client loses is certainty, not the order. That is
the same ambiguity a broadcast withdrawal has when the RPC times out, and it has
the same answer: **ask, do not guess**. The client resolves it through the
journal-backed lookup endpoint, never by retrying blind.

This makes Redis load-bearing for _accepting_ orders, not merely for delivering
events, and that cost is accepted deliberately. The alternative — acknowledging
before publishing — buys availability by making a success response mean less than
the caller will assume it means.

Sustained unavailability therefore sheds load at ingress. Nothing is ever dropped
at egress, because there is no event in flight that is safe to lose.

### Crash between the journal and the stream

The window in step 4–5 is real: the command is durable and the events are not
published. Recovery closes it.

The engine persists a **published watermark** — the highest sequence confirmed
into the stream — to its data directory, fsynced on a cadence rather than per
event. On boot, after ADR-0028's recovery, it republishes every event from the
watermark forward by re-deriving them from the journal.

Republishing an event a consumer already saw is safe: settlement is idempotent by
construction ([ADR-0025 §7](./0025-clob-and-two-tier-clearing.md)). Skipping one
is not. That asymmetry is why the watermark may lag its true value and may never
lead it — an imprecise watermark costs duplicate delivery, which the system
already tolerates; a missing one costs a lost fill, which it does not.

### Position is tracked by engine sequence

Every published entry carries its engine sequence as a field, and every consumer
tracks position by that number rather than by a Redis stream id. A Redis id does
not survive the stream being recreated; an engine sequence survives anything the
journal survives.

The engine creates no consumer group. The settlement worker creates its own in
S4, and a group created by the producer is a group nobody owns.

### Re-emission

`GET /v1/events?after=<seq>` re-derives events by replaying the command journal
from the newest snapshot at or before `after`.

Events are not journaled; commands are. That is ADR-0028's decision and it is
what keeps events a _function_ of the journal rather than a second artefact that
can disagree with it. A bounded in-memory ring of recent events serves the common
case — a consumer a few thousand sequences behind — without touching disk, and a
request older than the ring falls back to replay. Slow, correct, and rare enough
to log at `warn`, because a consumer that routinely needs it is broken.

## Alternatives considered

**Acknowledge after matching; publish asynchronously.** Lower latency, and Redis
stops being in the request path. Rejected because it makes a 2xx mean "the book
changed" rather than "the event is durable downstream", and every caller will read
it as the latter. The gateway would then hold an order it believes is live whose
fill may never reach settlement, and the only way to find out is the reconciliation
this design exists to avoid needing.

**Publish under the runtime mutex.** The simplest possible ordering guarantee:
one lock, one order, no funnel. Rejected because it puts a network call inside the
critical section, so a Redis stall halts matching for every market participant —
converting a delivery problem into a trading outage.

**A bounded buffer that drops the oldest event under pressure.** Standard for
telemetry. Rejected outright here: there is no event in the buffer that is safe to
lose, and a dropped fill is unreconstructable.

**Redis Streams as the durable log, with no journal.** Already rejected in
ADR-0028 and re-examined here because blocking egress makes it tempting: if the
ack waits for `XADD` anyway, why keep two records? Because `appendfsync everysec`
still loses up to a second of acknowledged writes on a hard kill, and because the
journal is what lets recovery close the crash window at all.

**Journal the events as well as the commands.** Makes re-emission a file read.
Rejected because two append-only records of the same truth can disagree, and the
one that is a pure function of the other cannot.

**gRPC bidirectional streaming instead of REST plus a stream.** Named in
master-prompt rule 35 as the intended future option. Deferred, not refused:
revisit when ingress latency is measured and found wanting, which the S2 load
client exists to measure.

## Consequences

- **A 2xx from the engine means the event is in the stream.** Callers may rely on
  it, and S3's gateway is written assuming it.
- **Redis is load-bearing for order acceptance.** Its availability is now a
  trading-availability concern, and it needs a runbook.
- A 503 from the engine is genuinely ambiguous: the order may have been matched.
  The client resolves it with the lookup endpoint and never by retrying blind. S3
  must not treat 503 as "did not happen".
- Duplicate delivery is normal, not exceptional. Every consumer must be idempotent
  from its first line of code, which S4's partial unique index already provides.
- Latency now includes a Redis round trip on every command. The S2 load client
  measures it; S1's criterion benchmarks continue to measure the engine alone, and
  the two must never be quoted as one number.
- The published watermark is a new piece of on-disk state with its own recovery
  path, and a corrupted one must fail safe by republishing more rather than less.
