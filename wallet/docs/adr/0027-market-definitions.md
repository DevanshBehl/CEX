# ADR-0027: Market definitions, ticks and collars

**Status:** accepted · **Date:** 2026-09-21 · **Phase:** S1
**Extends:** ADR-0021 (cluster dimension), ADR-0026 (fixed-point price) · **Required by:** ADR-0025

## Context

A market is the unit of configuration an order is validated against and the unit
the matching engine is instantiated per. Everything an order can be rejected for
that is not about the order itself — the tick it is priced on, the lot it is
sized in, the minimum it must be worth, how far from the market it may reach — is
a property of the market.

The alternative is that these arrive on the request, which makes them a client
parameter. A client-supplied collar is not a safety band; it is a field an
attacker sets to the value that removes the band.

## Decision

**A market is a static, cluster-qualified definition loaded at boot, and every
structural constraint on an order lives on it.**

### Identity

```
market id      devnet:SOL-USDC          cluster-qualified, as every asset key is
symbol         SOL-USDC                 BASE-QUOTE, uppercase, hyphen-separated
base asset     devnet:SOL               a LedgerAssetKey
quote asset    devnet:USDC              a LedgerAssetKey
```

Both asset keys carry the cluster, and a market whose base and quote are in
different clusters is **rejected at construction**, not at use — the same reason
`buildTransaction` refuses a cross-cluster ledger transaction rather than
discovering it later ([ADR-0021](./0021-cluster-dimension.md)). A market whose
base and quote are the same asset is rejected for the same reason.

### Constraints

| Field         | Unit                   | Meaning                                              |
| ------------- | ---------------------- | ---------------------------------------------------- |
| `tickSize`    | `price_int` (ADR-0026) | every limit price must be an exact multiple          |
| `lotSize`     | base base-units        | every quantity must be an exact multiple             |
| `minNotional` | quote base-units       | a floor on `price × qty`, evaluated after truncation |
| `collarBps`   | basis points           | how far from the reference price an order may reach  |

All four are strictly positive. `minNotional` is checked against the **truncated**
notional of ADR-0026, not a recomputed one, so an order can never pass validation
at a value it will not settle at.

### The collar

The collar bounds how far a single order may move the price, and it is the reason
a market order cannot walk a thin book into an absurd fill.

The reference price is, in order: the **last trade price**; failing that, the
**mid** of the best bid and ask; failing that, **nothing** — and a market order
against a book with no trades and no two-sided quote is **rejected**, not filled.

Rule of the last clause: an empty book has no opinion about what anything is
worth, and a market order is a request to trade at whatever the market says. When
the market says nothing, the honest answer is a rejection.

A limit order outside the collar is rejected. A market order fills only while
inside it, and whatever remains when the band is reached is cancelled — never
rested, because a market order that becomes a resting limit order at the collar
edge is an order the client did not place.

### Status

```
pre_open     accepts nothing; the market exists and is not yet trading
open         accepts everything
post_only    accepts only post-only orders; used to build a book before opening
halted       accepts nothing; cancels are still accepted
```

`halted` accepting cancels is deliberate. A halt that traps resting orders gives a
trader no way out of a position they can no longer manage, and the point of a halt
is to stop price formation, not to take away the exit.

### Where a market lives

Static configuration, validated at boot into a frozen structure, in the same
fail-fast style `packages/config` already uses. A market is not editable at
runtime in S1; changing a tick size is a deploy, because it changes the meaning of
every resting order's price.

The one exception is `status`, which S6 must be able to change at runtime — that
is what a kill switch is. S1 models status as data so S6 has somewhere to write.

## Alternatives considered

**Markets in the database, editable by an operator.** Flexible, and what a mature
exchange does. Rejected for S1 because a tick size that can change while orders
rest at prices the old tick permitted is a class of bug with no good recovery, and
an operator UI for it is an S6 concern. Static configuration makes the invariant
trivially true.

**A percentage collar instead of basis points.** Identical in effect. Basis points
chosen because every other threshold in this project is an integer in its
smallest meaningful unit, and a percentage invites a float.

**A collar referenced to an external index price.** What a real exchange uses, and
strictly better protection. Rejected here because an index introduces an oracle
and a staleness policy — a whole failure domain — into the one component this
phase is keeping dependency-free. Revisit when the demo market maker gives the
book a continuous two-sided quote, which removes most of the motivation.

**No collar; rely on the order book's own depth.** Rejected outright. A thin book
is exactly the condition under which a market order does damage.

## Consequences

- Tick, lot, minimum notional and collar are never client-supplied, so they cannot
  be argued away by a request.
- A market order can be rejected for a reason that is about the _book_ rather than
  the order — an empty book with no trade history — and the reject reason set has
  to be able to say so.
- `halted` must be checked on placement and **not** on cancellation, which is a
  case that is easy to get wrong by checking status once at the top of a handler.
- Markets being static means adding one is a deploy. For an educational exchange
  serving one or two pairs, that is the correct trade.
- S6's kill switch writes `status`, and every code path that reads it must already
  tolerate it changing between two orders.
