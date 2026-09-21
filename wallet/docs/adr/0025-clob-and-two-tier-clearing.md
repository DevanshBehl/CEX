# ADR-0025: A central limit order book, and two tiers of custody

**Status:** accepted · **Date:** 2026-09-20 · **Phase:** S1–S4
**Amends:** ADR-0020 (segregated custody) · **Extends:** ADR-0017 (sweep policy), ADR-0021 (cluster dimension), ADR-0024 (value-based review)

## Context

Under [ADR-0020](./0020-segregated-custody.md) every user's deposit address is
their own 3-of-5 FROST group key. Funds are not commingled, there is no master
seed, and the ledger reconciles per owner: what a user is owed is checked against
what sits at _their_ address.

A central limit order book breaks that, immediately and by construction. When
Alice sells 1 SOL to Bob for 150 USDC, ownership changes the instant the orders
cross. On-chain nothing moves: the SOL is still at Alice's address and the USDC is
still at Bob's. So when Bob later withdraws the SOL he now owns:

- the transfer has to be funded from Alice's segregated address;
- Alice's 3-of-5 key is the only thing that can authorise that, and it must not —
  the entire point of segregation is that her key moves her funds and nobody
  else's;
- and per-user reconciliation has already failed one block after the trade, because
  Alice's liability and Alice's on-chain balance no longer correspond.

This is not an implementation problem with a clever fix. Trading pools claims by
definition, and a custody model that refuses pooling cannot also offer trading.
The question is not whether to pool, but **where the pooling boundary is drawn and
whether the user crosses it knowingly**.

A second problem arrives with the first. The matching engine decides who trades
with whom, in microseconds, in memory. The ledger decides who owns what, in
PostgreSQL. If the engine can match an order whose funds were never reserved,
settlement posts a transaction that drives a user balance negative — and **nothing
refuses it.** The database's deferred trigger enforces that a transaction balances
per asset, not that a balance stays non-negative; `NON_NEGATIVE_ACCOUNT_TYPES` is
asserted by tests and reconciliation, never on write. The trade settles, the books
balance, and a user owes the platform money they never had.

_Corrected 2026-09-22: an earlier revision said the non-negative check would
reject such a settlement at COMMIT. No such constraint exists. The sufficient-funds
check is the SERIALIZABLE read-then-post in the service that takes the hold, as
`lockFunds` is for withdrawals, which makes hold-first the only defence rather
than the earlier of two._

## Decision

**Custody is two tiers, and the boundary between them is an on-chain transfer.**
**The matching engine owns price and priority; the ledger owns money; and a hold
exists in PostgreSQL before the engine is allowed to see an order.**

### 1. Two tiers

| Tier              | Address                                         | Accounts                                                         | Withdrawal signs with       |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| **Custody vault** | the user's own 3-of-5 FROST address             | `user_custody_available`, `user_custody_locked`                  | the user's key, two rounds  |
| **Clearing pool** | one `house_clearing` address, its own DKG'd key | `user_trading_available`, `user_order_locked`, `clearing_assets` | the clearing key, one round |

Moving vault → clearing is an **allocation**: a real on-chain transfer, roughly
thirty seconds to finality. Moving back is a **deallocation**. Nothing is credited
to the trading tier that has not arrived in the clearing pool.

The vault tier keeps every property ADR-0020 claimed. The clearing tier explicitly
does not: it is omnibus, pooled across all traders, under one key. A user enters it
deliberately, by allocating, and the interface says so.

### 2. The clearing address is not the treasury

`house_clearing` is a distinct address with a distinct DKG'd key. The treasury pays
network fees and is the durable-nonce authority; its balance moves constantly and
for reasons that have nothing to do with customer funds. Sharing one address would
make the clearing reserve check unable to distinguish customer money from fee
float, so every fee paid would read as a reserve shortfall.

### 3. Reconciliation, by tier

```
vault, per user per asset:
    onchain(user_frost_address, asset) - rent
        >=  user_custody_available + user_custody_locked

clearing, aggregate per asset:
    onchain(house_clearing, asset) - rent
        >=  SUM over users ( user_trading_available + user_order_locked )
```

The clearing inequality runs with slack equal to the accumulated
`house_trading_fees` not yet withdrawn.

**There is no in-flight term, deliberately.** While an allocation is in flight the
coins are still at the user's address — counted by the vault's on-chain balance —
and the liability is still in `user_custody_locked`. The vault equation holds
unchanged and clearing is simply not yet credited. An in-transit addend on the
reserve side would make the inequality _easier_ to satisfy, which is the wrong
direction for a reserve check: it would let a genuine shortfall be explained away
as money in motion.

### 4. An allocation is a withdrawal

[ADR-0017](./0017-sweep-policy.md) already holds that a sweep is a withdrawal whose
destination lives inside the signing boundary. An allocation is exactly that, with
`house_clearing` as the destination. It therefore reuses the existing lifecycle
wholesale — all fifteen states, the retry and expiry budgets, durable nonces, the
dead-letter queue, the operator retry surface — and `user_custody_locked` covers
the in-flight window with no new ledger account and no second state machine.

### 5. The hold precedes the engine

One `SERIALIZABLE` transaction writes the order row in `PENDING_ENGINE` and posts
the hold (`debit user_trading_available` / `credit user_order_locked`). Only then is
the order sent to the engine. Checking and reserving are a single act, exactly as
`postWithdrawalLock` already is for withdrawals — which is what makes it impossible
for two concurrent orders to both pass a check and both proceed.

What is held follows the side, not the quote asset:

| Order       | Held                                                     |
| ----------- | -------------------------------------------------------- |
| Limit buy   | quote: `price × qty` + worst-case taker fee              |
| Limit sell  | base: `qty`; the fee comes out of the proceeds           |
| Market buy  | quote: `upper collar band × qty`, refunded at settlement |
| Market sell | base: `qty`                                              |

If the gateway dies between the commit and the engine's acknowledgement, a sweeper
claims orders left in `PENDING_ENGINE` and asks the engine whether it has them.
**The sweeper queries the journal, not the book.** An order that was accepted and
immediately filled in full is gone from the book but present in the write-ahead
log; consulting the book would conclude it never arrived and reverse a hold against
a fill that really happened.

### 6. Durability: the journal is the truth, Redis is the wire

```
command  ->  assign monotonic u64 sequence
         ->  append + fsync to the engine's journal
         ->  match in memory
         ->  XADD orders:events
```

`infra/docker-compose.yml` runs Redis with `--appendonly yes`, justified in its own
comment by the observation that losing a WebAuthn challenge is harmless. Execution
reports are not harmless, and default `appendfsync everysec` loses up to a second of
them on a hard kill. The engine needs an fsync'd journal regardless, for replay
determinism — so the settlement worker tracks its position by **engine sequence
number**, not Redis ID, and a wiped stream is replayed rather than lost.

### 7. Settlement is idempotent by constraint

`XREADGROUP` redelivers on timeout, restart and rebalance. A redelivered fill must
be a no-op decided by the database, not by a read-then-write check:

```sql
CREATE UNIQUE INDEX ledger_transactions_trade_fill_uniq
  ON ledger_transactions (reference_id) WHERE kind = 'trade_settle';
```

**The index must be partial.** A global `UNIQUE (reference_type, reference_id)`
fails on existing data: `postWithdrawalLock`, `postWithdrawalRelease` and
`postWithdrawalSettlement` all write `referenceType: 'withdrawal'` with the same
withdrawal id (`packages/ledger/src/postings.ts:127`, `:148`, `:233`), so a single
withdrawal already produces two or three rows sharing that pair. `reference_id` is
the **fill** id, not the order id — a partial fill settles several times against one
order, and both sides of one fill settle in a single transaction.

### 8. Terminology

The vault tier is described as **cryptographically segregated and per-user
reconcilable**. The term _bankruptcy-remote_ is not used anywhere in this project:
it is a legal claim, and nothing here establishes it.

## Alternatives considered

**Ledger-only transfers, no chain movement.** The obvious reading of "internal
transfer": credit the trading tier instantly, move nothing on-chain, and let
trading balances be a claim on the aggregate of every user's address. It fails on
the problem in the Context. A post-trade withdrawal must be paid from whichever
addresses happen to hold the asset, so the withdrawal worker needs coin selection
across other users' addresses, and each of those transfers needs that user's FROST
key to sign a disbursement they have no interest in. Per-user reconciliation stops
holding for anyone who has ever traded, which is the property most worth keeping.

**Instant credit with an asynchronous sweep.** Credit the trading tier immediately —
both addresses are platform-controlled, so value never leaves the system — and move
the chain funds afterwards. The best experience of the three, and genuinely
defensible. Rejected because it is the only option that requires an in-flight
position on the reserve side of the clearing inequality, and a reserve check with a
term that can absorb a shortfall is worth less than one without. If allocation
latency turns out to be the thing users complain about, this is the change to make,
and the accounting to add is understood.

**A purpose-built `transfers` state machine for allocations.** Conceptually cleaner:
an allocation is not a withdrawal, and it never leaves the platform. Rejected
because it would rebuild the retry budgets, nonce leasing, dead-letter wiring and
operator tooling that the withdrawal lifecycle already has and has tested — and
prompt_phase4.md rule 248 already refused exactly this reasoning for sweeps.

**Matching inside the API, in TypeScript.** No second service, no transport, no
sequencing problem. Rejected because a deterministic, replayable engine is the
whole point of the phase, and determinism under a garbage collector shared with a
web framework is something to be argued about rather than asserted. The process
boundary is also what keeps "the engine cannot write to the ledger" a structural
fact instead of a convention.

**gRPC bidirectional streaming between gateway and engine.** Lower latency and a
real streaming contract, and master-prompt rule 35 names gRPC as the intended future
option. Rejected for now because it adds `tonic`, proto codegen on the TypeScript
side and `protoc` in CI, and introduces a second RPC convention alongside the
signed-REST one `services/mpc` established. Revisit when ingress latency is measured
and found wanting, not before.

## Consequences

**What this makes true:**

- Trading is possible at all, which it is not under strict segregation.
- Both tiers reconcile, by different rules, and both rules are conservative.
- Proof-of-reserves becomes _more_ demonstrable, not less: a per-user attestation
  over vault addresses plus one aggregate attestation over the clearing address,
  both checkable against the chain by someone who does not trust the operator.
- A compromised matching engine can produce wrong prices, a crossed book, or fills
  that should not have happened. It cannot create money.

**What this costs:**

- **"No commingling" now holds for the vault tier only.** The README and the
  landing copy at `apps/web/app/page.tsx:158` must say so; a property quietly
  weakened is worse than one openly scoped.
- Allocation takes about thirty seconds and costs a network fee. The interface
  shows the on-chain step rather than pretending it is instant.
- The clearing key is a new concentration of risk: one key, all traded funds. It
  is a 3-of-5 FROST key like the others, and it is the largest single balance in
  the system.
- Redis becomes load-bearing for trade events. The journal is what makes that
  recoverable rather than fatal, so the journal is not optional.

**What has to be revisited if an assumption changes:**

- If allocation latency proves unacceptable, move to instant-credit-plus-sweep and
  add the in-flight accounting deliberately.
- If the clearing pool grows past what one key should hold, it needs the custody
  tiering of [ADR-0018](./0018-custody-tiers.md) — a hot clearing balance sized to
  trading activity, with the remainder in a colder tier.
- If a second market's quote asset is added, the reserve inequality is per asset
  and already generalises; the fee schedule and collar bands do not, and are
  per-market by construction.
