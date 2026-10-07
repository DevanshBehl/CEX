# ADR-0038: The demo market maker

**Status:** accepted · **Date:** 2026-10-07 · **Phase:** S5
**Extends:** ADR-0025 (two-tier clearing), ADR-0033 (pre-trade risk), ADR-0035 (reconciling the clearing tier)

## Context

An empty book is a dead demo. S5 needs something resting on both sides so a
trading screen has a market to show.

The danger is in how it is built. A quoter with its own path into the book, its
own way of being funded, or its own exemptions is a second, untested exchange
running beside the first — and the demo then demonstrates that one.

## Decision

### 1. It is a user

It has a row in `users`, a trading balance in the ledger, and holds taken by the
ordinary path. It places and cancels through the same `OrderService` methods the
HTTP controllers call: pre-trade risk, the hold, guarded transitions, the
sweeper.

It never calls the engine client. It never writes a ledger entry or an order
row. If a method on `OrderService` is not enough for it, the method is not
enough for users either, and that is the thing to fix.

### 2. It has no exemption

There is no `isMarketMaker` anywhere in the gateway, the risk engine or
settlement. It lives within the per-user order-rate and open-order limits. If it
needs more room, it gets it the way any user would — by those limits being
configured higher — and its own cadence is configured to fit.

Self-trade prevention is `cancel_taker` for every gateway order, so a quote that
would cross its own resting quote is rejected. It cancels before it places
anything that would cross, and treats a self-trade rejection as an ordinary
outcome.

### 3. It is funded by a real allocation

A person with a passkey deposits to that user and allocates to trading, exactly
as any user does. **No script, seed or migration credits it.** A ledger credit
with no coins behind it is precisely what reconciliation check 1 exists to
catch, and a market maker funded that way would make every deployment drift
from the first moment.

The consequence, accepted: on a fresh deployment the maker cannot quote until
someone has funded it. With nothing to quote a side with, it does not quote that
side, and says so.

### 4. It refuses to start where it should not

Off by default. It refuses to start without a configured user id that exists,
and configuration validation refuses it on `mainnet-beta`: this is a
demonstration device, and synthetic liquidity quoting an invented price has no
business near a real market.

### 5. Strategy is a pure function; a reconciler applies it

Reference price, inventory and configuration in; desired quotes out. No clock,
no network, no randomness it was not handed.

Quotes are clamped inside the engine's collar band, rounded to tick and lot, and
dropped when they fall below the minimum notional. A quote the engine rejects
took a hold and released it for nothing.

A reconciler compares desired quotes with the maker's open orders and issues the
difference. Client order ids are deterministic from market, generation, side and
level, so a restart that re-issues a generation submits the same orders and the
gateway's idempotency makes that harmless. An ambiguous placement is left to the
sweeper, like anyone's.

### 6. It never quotes a price it cannot see

When its reference is older than a configured bound, it cancels its quotes
rather than leaving them resting. It does not fall back from a real reference to
an invented one: a book that silently switched would be a different market
wearing the same name.

It also stops quoting a market whose settlement is delayed or halted. Its view
of its own inventory is behind.

### 7. The reference price is an interface

A market symbol in; a scaled price and an observation time out. The default is a
deterministic seeded random walk — the same seed and the same steps give the same
prices on any machine — so CI and offline development never touch the network.
An exchange's public market data is an opt-in implementation, tested against
recorded responses.

This is a new interface, not `PriceSource`. That one answers "what is this asset
worth in dollars" for valuation; this one answers "where should this market be
quoted", in the market's own quote asset, as a scaled integer.

### 8. Its liquidity is labelled

The capabilities endpoint says whether liquidity includes a synthetic market
maker, and the trading screen says so wherever that liquidity is shown. Its
fills are real fills: real fees and real balance changes, for it and for whoever
traded with it.

## Alternatives considered

**Seed the book directly through the engine.** The simplest thing, and orders
with no hold: the first fill against one halts settlement (ADR-0034 §8).

**Credit the maker in the ledger at boot.** Works everywhere immediately, and
makes the clearing reserve check wrong by exactly that amount, forever.

**A higher rate limit for the maker's user id, in code.** An exemption with a
user id in it is a privilege somebody else can ask for.

**Fall back to the random walk when the real feed fails.** Keeps the book full,
and replaces the market with a different one without saying so.

## Consequences

- A demo deployment has a two-sided book once someone funds the maker.
- Every price on the screen was put there by a program quoting around a number
  it was given — by default, one it made up. The interface says so.
- Surveillance, when it arrives, will mostly detect the market maker (S6).
- The maker exercises the gateway continuously, which makes it a standing
  integration test of the order path.
