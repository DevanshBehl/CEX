# ADR-0031: Engine authentication, and the replay window

**Status:** accepted · **Date:** 2026-09-21 · **Phase:** S2
**Extends:** ADR-0013 (the MPC trust boundary) · **Relates to:** ADR-0025, ADR-0030

## Context

S2 gives the matching engine a network surface. Its only legitimate caller is the
order gateway; an end user never reaches it. Anything else that can reach it can
trade without a hold, which is the one thing S2 exists not to allow.

`services/mpc` already solved the authentication half of this, and the engine
should copy it rather than invent a second scheme: an Ed25519 signature over a
canonical string, with the service holding only the caller's **public** key, so
compromising the service does not yield the ability to impersonate the caller.
TLS protects the channel and the signature proves who is on the other end of it —
not alternatives, because the transport can be terminated by a proxy and then the
signature is the only thing that still says who called.

**The replay half does not carry over, and copying it unchanged is a
vulnerability.**

`CallerVerifier::verify` checks a timestamp tolerance and the signature. It holds
no record of request ids it has already seen, so a captured request can be
replayed for as long as its timestamp remains inside the window. In the MPC
service that is harmless by construction: `/v1/sign` is idempotent on
`requestId`, so a replay returns the same signature and changes nothing.

Placing an order is not idempotent. S1's `Engine::place` rejects a duplicate
order id only while that id is **still resting** — it checks `book.contains`. An
order that filled completely is gone from the book, so a replayed placement
inside the tolerance window creates a _second_ order, which matches again. The
gap is narrow, it requires a captured request, and it mints trades.

## Decision

**Copy the MPC signature scheme verbatim, and add a TTL replay cache whose
lifetime is exactly the timestamp tolerance window.**

### The signature

Unchanged from `services/mpc`, field for field:

```
canonical = method \n path \n request_id \n hex(sha256(payload)) \n timestamp
```

Field-separated by a character that cannot appear in any field, so `("ab","c")`
and `("a","bc")` cannot produce the same string — without that the scheme has a
splicing weakness that is easy to miss and hard to notice. The payload is covered
by its **hash** rather than its bytes, so the canonical string stays bounded and
nothing tempts a maintainer to log it.

Headers are `x-atlas-signature`, `x-atlas-timestamp` and `x-atlas-request-id`.
Not `x-mpc-*`: a header that names the wrong service is a copy-paste that
outlives its excuse.

The timestamp is checked **before** the signature, so a replay of a genuinely
signed old request is refused on the cheap check and the reason recorded is the
accurate one.

### The replay cache

A bounded set of request ids seen inside the tolerance window. A repeat is
refused with **409**, distinct from the 401 a bad signature earns, so an operator
can tell a client retrying from an attacker replaying.

**The TTL is the tolerance window, and that is not a coincidence — it is the
whole argument for the cache being bounded.** Once a request's timestamp falls
outside tolerance, `CallerVerifier` rejects it on the clock check regardless of
what the cache remembers. So an entry older than the window can never change an
outcome, and evicting it is free. Memory is therefore bounded by the request rate
times the window, not by uptime.

Tolerance is **300 seconds**. Wider costs proportionally more memory and a longer
replay window; narrower starts refusing legitimate requests on ordinary clock
skew between two hosts.

Implementation is a `HashSet` of request ids plus a `VecDeque` of
`(timestamp, request_id)` in insertion order. Eviction pops the front while it is
older than the window — O(1) amortised, no background task, and deterministic
enough to test by advancing a clock that is passed in rather than read.

Exhaustion of the bound **refuses** rather than forgets. Forgetting is the
failure mode that silently reopens the vulnerability this cache exists to close,
and refusing is visible.

### The cache is in memory, and that is sufficient

It does not survive a restart, and it does not need to. A request signed before
the restart is outside its 300-second tolerance by the time the process is
serving again, so the clock check refuses it without the cache's help.

That reasoning is the only thing making in-memory state acceptable here, so it is
stated rather than implied, and a test asserts the property it depends on: the
tolerance window must exceed nothing — it must simply be shorter than any restart
the deployment can complete faster than. If the engine ever restarts in under 300
seconds _and_ an attacker holds a captured request, the window reopens. Accepted:
the attacker must already have a signed request, and the gateway is the only
signer.

### What the cache is not

It is not durable idempotency. The engine must not remember every order id
forever — that is unbounded state in the one component that has to fit in memory,
and it would grow without limit for a market that never closes.

The durable idempotency boundary is the gateway's `UNIQUE(user_id,
client_order_id)` in PostgreSQL, built in S3, which is where a client's retry is
resolved into exactly one order. The replay cache defends the transport; the
constraint defends the money.

## Alternatives considered

**No replay cache; rely on the timestamp window alone.** What `services/mpc`
does, and correct there. Rejected here for the reason in the Context: the engine's
mutating endpoints are not idempotent once an order leaves the book.

**Make the engine's placement idempotent instead, by remembering every order id.**
Removes the need for a cache and closes the window permanently. Rejected because
the state is unbounded, it lives in the process that must stay in memory, and it
duplicates a uniqueness guarantee PostgreSQL will provide anyway with durability
the engine cannot match.

**A monotonic per-caller nonce instead of a TTL cache.** Smaller state — one
integer per caller — and no window at all. Rejected because it forces strict
ordering on the gateway: a request that is retried out of order, or that races
another in a multi-process gateway, is refused although it is legitimate. The S3
gateway is explicitly allowed to be more than one process.

**`moka` or another TTL cache crate.** Battle-tested, and the obvious reach.
Rejected for a dependency whose concurrency model and background eviction would
have to be reasoned about in a service whose defining property is that its
behaviour is reproducible. Forty lines of `HashSet` plus `VecDeque`, with the
clock passed in, is testable by advancing a number.

**A longer tolerance, say an hour, to tolerate bad clocks.** Rejected: it widens
the replay window twelvefold and grows the cache with it, to fix a clock-skew
problem that NTP already solves.

## Consequences

- The engine holds one public key and no private key. It cannot impersonate its
  caller, and compromising it yields no ability to sign.
- A 409 is a meaningful, actionable signal: a request id was reused inside the
  window. It is not a generic client error and should not be logged as one.
- The gateway must generate a unique request id per attempt, including on retry.
  A gateway that reuses an id when retrying will be refused, which is correct —
  the retry of a mutating call needs a new id and the _same_ `clientOrderId`.
- Memory is bounded by rate × 300s. An order-rate increase raises the cache's
  ceiling, so the bound is configuration and its exhaustion is a metric.
- Restarting faster than the tolerance window reopens a narrow replay window for
  an attacker who already holds a signed request. Recorded here rather than
  defended, because defending it means durable state the engine should not have.
- The tolerance is now load-bearing in two places — clock skew and replay — so
  changing it is a security decision and not a tuning knob.
