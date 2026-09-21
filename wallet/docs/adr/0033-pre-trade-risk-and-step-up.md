# ADR-0033: Pre-trade risk, and what a trader must prove

**Status:** accepted · **Date:** 2026-09-21 · **Phase:** S3
**Extends:** ADR-0010 (risk policy baseline), ADR-0011 (step-up tiering), ADR-0024 (value-based review)

## Context

Two questions have to be answered before an order can reach the matching engine,
and they are easy to conflate.

The first is **what to check**. The wallet's risk engine evaluates a withdrawal
against limits, velocity and destination. An order is a different animal: it does
not leave the platform, it can be cancelled, and a trader may place many per
minute. Reusing the withdrawal rules unchanged would refuse ordinary trading;
inventing a second engine would duplicate the one property that makes the
existing one valuable — it is pure, so a decision can be replayed years later and
explain itself.

The second is **what a trader must prove**, and this is where a sensible-looking
default is wrong.

[ADR-0011](./0011-step-up-tiering.md) requires a fresh passkey assertion before a
withdrawal, with freshness scaled to value. Applied consistently, that rule says
an order should demand one too — an order moves money, after all. But a trader
placing fifty orders a minute cannot re-assert a passkey for each, and a system
that demands it is one nobody can use.

The tempting resolution is to weaken step-up everywhere until trading is
comfortable. That would quietly remove the control that protects withdrawals.

## Decision

**Session authentication for orders. Step-up for allocation and deallocation.
The boundary is value _leaving the platform_, not value _moving_.**

### What each action must prove

| Action                        | Requires                            | Why                                                           |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Place / cancel / amend        | session + CSRF + rate limit         | funds stay on the platform and stay the user's                |
| Allocate (vault → clearing)   | **step-up**, at the withdrawal tier | an on-chain transfer out of the user's own segregated address |
| Deallocate (clearing → vault) | **step-up**                         | an on-chain transfer, and a destination worth confirming      |
| Withdraw (either tier)        | **step-up**, unchanged              | value leaves the platform                                     |

A stolen session can place and cancel orders. It cannot allocate, deallocate or
withdraw, so it cannot extract value — it can only churn the victim's balance
between assets at market prices, which is bounded loss, visible in the activity
feed, and recoverable in a way a withdrawal is not.

That is the trade, stated rather than implied: **orders are the one money-moving
action in this system that a session alone can authorise**, and it is justified
by the fact that the money does not go anywhere a step-up would have protected.

### What is checked before the engine

Pre-trade risk extends `packages/risk` rather than forking it, and keeps every
property that package already guarantees: pure, no clock, no database, no
configuration read, every rule evaluated on every input, a persisted decision
that replays.

| Rule                | Refuses                                                 |
| ------------------- | ------------------------------------------------------- |
| Market status       | an order into a market that is not accepting placements |
| Maximum order size  | a single order above the per-market cap                 |
| Maximum open orders | more than N live orders per user per market             |
| Order rate          | more than N placements per user per window              |
| Notional exposure   | total open notional per user above a cap                |

Structural validation — tick, lot, minimum notional, collar — is **not** here. It
lives in `packages/orders`, it is already written and tested, and duplicating it
would create two answers to the same question.

**The sufficient-funds check is not here either.** It is the hold, posted in the
same transaction that creates the order. A balance check in the risk engine would
be a read that something else then acts on, and the gap between them is where two
concurrent orders both pass.

Reason codes are append-only, exactly as `REASON_CODES` already is. The client is
told a generic reason, because a precise one is an oracle for probing limits —
the same reasoning that already governs the withdrawal endpoint.

### Rate limiting is not risk

Per-route rate limits stay where they are, in `@fastify/rate-limit` backed by
Redis. The order-rate _rule_ in the risk engine is a different control with a
different purpose: the limiter protects the service from load, the rule protects
the book from a single account's behaviour, and the second one is persisted and
replayable while the first is not.

## Alternatives considered

**Step-up on every order.** Consistent with ADR-0011 and unusable. A trader
cannot re-assert a passkey fifty times a minute, and the protection it would buy
is small: the funds stay on the platform either way.

**Step-up on the first order of a session, then a grace window.** A real pattern,
and it nearly works. Rejected because the window becomes the actual security
boundary and nobody can say what it should be — long enough to trade is long
enough for a stolen session to trade, so it costs usability without moving the
line.

**Step-up above a notional threshold, mirroring ADR-0024's value-based review.**
Coherent, and it was close. Rejected because an order is not a disbursement: a
large order can be cancelled, may never fill, and fills at prices the book sets
rather than ones the attacker chooses. The threshold would fire on exactly the
legitimate large trades that most need to be fast.

**One risk engine shared with withdrawals, one rule set.** Rejected: the rules do
not transfer. A withdrawal's destination checks and rolling 24-hour limits are
meaningless for an order, and an order's open-order count is meaningless for a
withdrawal. Shared _machinery_, separate rule sets.

**Put the funds check in risk so every refusal has one shape.** Rejected for the
reason above — check and reservation must be one atomic act, and `postOrderHold`
is where that happens.

## Consequences

- A stolen session can trade. That is an accepted, bounded exposure, and it must
  be stated in the threat model rather than discovered there.
- Allocation is slower and more deliberate than trading, by design. The UI should
  present it as moving money rather than as a toggle.
- Risk decisions are persisted per order, which is a row per placement. The
  volume is higher than withdrawals by orders of magnitude, so the decision table
  needs a retention policy — recorded here as a known gap, not solved.
- The order-rate rule and the HTTP rate limiter can disagree, and that is fine:
  one returns a 429 from the edge, the other a persisted risk decision. An
  operator reading only one of them sees half the picture.
- Every limit here is configuration. Changing one is a policy decision that
  should move `POLICY_VERSION` only when a rule's _meaning_ changes, per the
  convention `packages/risk` already follows.
