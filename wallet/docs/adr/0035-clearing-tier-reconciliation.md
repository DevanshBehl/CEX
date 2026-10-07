# ADR-0035: Reconciling the clearing tier

**Status:** accepted · **Date:** 2026-10-01 · **Phase:** S4
**Extends:** ADR-0025 (two-tier clearing), ADR-0032 (trading-tier accounts), ADR-0034 (settlement pipeline)

## Context

The vault tier has been reconciled against the chain since Phase 2: per asset,
per user, on a schedule, alerting on a drift that persists. The clearing tier has
never been reconciled at all. S3 deferred its drift report, and before S4 the
only thing moving clearing balances was allocation, which runs through the
already-reconciled withdrawal lifecycle.

S4 changes that. Every fill moves value between users inside the clearing tier,
and charges fees. As ADR-0034 says, the failures that matter here are the ones
that balance. Reconciliation is how they become visible.

The temptation is to find one check that "proves solvency". There isn't one. Each
check below compares two things, and each is blind to whatever does not change
either of them. The argument is the three together, and this ADR states what each
cannot see, so that nobody later reads a green dashboard as more than it is.

## Decision

Three checks join the existing reconciliation worker, plus one immediate alarm.
Each reports per asset or per market, records its last result as a metric, and
alerts on a **streak** of consecutive drifting readings, exactly as the vault
reconciliation does — with the one exception below.

### Check 1 — the clearing reserve, against the chain

Per asset: the ledger's `clearing_assets` balance against what the configured
clearing address actually holds, read through the same `ChainReader.getBalance`
as vault reconciliation.

The expected residual (`observed − ledger`) is zero, except for an explicitly
configured reserve the house parks at the clearing address for the native asset
(rent and dust). Network fees for clearing transfers are paid by the treasury,
not the clearing address (`feePayer: treasuryAddress`), so they never touch this
balance.

Residuals are transient while value moves. An allocation lands at the clearing
address before its ledger posting, which is made at finality. A deallocation
leaves it before its posting. Hence the streak.

This is the **independent** check. `getClearingTotals` compares two ledger
numbers that double-entry makes agree by construction; only the chain can
disagree with the ledger.

**Cannot detect:** _which_ user's funds are missing. It cannot see a
mis-attribution between users (a fill credited to the wrong buyer), a fee charged
at the wrong rate, or a fill never settled: none of those moves the total.

### Check 2 — the clearing equation, internally

Per asset:

```
clearing_assets − Σ(user_trading_available + user_order_locked + user_trading_locked)
    == house_trading_fees
```

All three user liability types count, including `user_trading_locked` (funds
reserved against an in-flight deallocation, ADR-0032 addendum). The slack is
exactly the accrued fee equity; it is why the solvency inequality is `>=` rather
than `=`. A difference that is not the fee total is a posting bug.

**Cannot detect:** a fill that was never settled. An unsettled fill moves nothing,
so the equation holds while a buyer is missing what they bought. It also cannot
see a fee charged to the wrong party, which still lands in `house_trading_fees`.

### Check 3 — holds against the book

Per market, two comparisons:

1. **Book.** The remaining quantity of every gateway order in a resting state
   (`OPEN`, `PARTIALLY_FILLED`, `PENDING_CANCEL`), aggregated by side and price,
   against the engine's `GET /v1/book` levels. A level the engine has and the
   database does not is an order with no hold. The reverse is a hold for an order
   that does not rest. `PENDING_ENGINE` orders and market orders are excluded:
   neither is expected to rest.
2. **Ledger.** Per user and asset, `user_order_locked` equals the sum of
   outstanding holds over that user's holding orders. This finds a hold with no
   order, which the book comparison cannot.

Comparison 1 is meaningful only when the database and the book describe the same
moment. `GET /v1/book` reports the `seq` it reflects. A reading is compared only
when the market's settled offset has reached that `seq`; otherwise it is recorded
as inconclusive, which neither extends nor resets a streak. A book read ahead of
settlement shows fills the database has not applied yet, and that is lag, not
drift.

**Cannot detect:** an order that is correctly held and rests at the correct
level, but settled an earlier fill at the wrong price. It also cannot see
anything about fees.

### The immediate alarm — a negative trading balance

Any user `user_trading_available`, `user_order_locked` or `user_trading_locked`
balance below zero alerts on the **first** reading.

It cannot be a timing artefact: no legitimate sequence of postings produces one.
ADR-0034 §7 makes the database refuse to commit one, so this alarm firing means
that trigger was bypassed, dropped or wrong. That is a different and worse
incident than drift.

### What the three together argue

| Failure                                    | 1   | 2   | 3                                                       |
| ------------------------------------------ | --- | --- | ------------------------------------------------------- |
| Clearing coins missing or extra on-chain   | ✅  |     |                                                         |
| Posting that creates or destroys value     |     | ✅  |                                                         |
| Fee not credited to `house_trading_fees`   |     | ✅  |                                                         |
| Order resting with no hold, or the reverse |     |     | ✅                                                      |
| Hold left after its order is terminal      |     |     | ✅                                                      |
| Fill never settled                         |     |     | ✅ (eventually, as a hold that does not match the book) |
| Fill settled at the wrong price            |     |     |                                                         |
| Fee charged at the wrong tier              |     |     |                                                         |

The last two rows are blank on purpose. They are caught by tests and by the
recorded rate and amount on every `fills` row (ADR-0034 §9), which make each
settlement auditable on its own, and not by any balance comparison.

## Alternatives considered

**Alert on every drifting reading.** The vault tier rejected this in Phase 4 and
the reason carries over: in-flight allocations make a single non-zero reading
normal, and an alert that always fires is one nobody reads.

**Compare `getClearingTotals` and call it check 1.** It is two ledger numbers.
Double-entry makes them agree whatever has happened on-chain.

**Make check 3 part of settlement itself.** Settlement would then depend on the
engine's book endpoint being reachable, and a reconciliation failure would halt
trading. Reconciliation observes; it does not gate.

## Consequences

- A clearing-tier problem is visible within a few reconciliation cycles instead
  of never.
- Each alert needs a runbook entry (`docs/runbooks/reconciliation-drift.md`).
- These checks run and alert; they are not published. Publishing them is
  proof-of-reserves, which is S6.
