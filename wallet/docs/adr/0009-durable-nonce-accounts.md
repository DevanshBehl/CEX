# ADR-0009: Durable nonce accounts, not recent blockhashes

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 3

## Context

Every Solana transaction carries a value proving recency. The default is a
**recent blockhash**, which expires after ~150 slots — roughly 60–90 seconds.
Past that, the transaction is permanently invalid and must be rebuilt and
re-signed.

A withdrawal in this system passes through risk evaluation, possibly a human
approval queue, a signing round, and a broadcast. In Phase 4 that signing round
becomes threshold MPC across several participants: a coordination protocol with
network hops between machines. It will not reliably complete inside 90 seconds,
and a manual review will not complete inside 90 seconds at all.

## The failure this avoids

A blockhash that expires mid-flight produces the **ambiguous broadcast**: a
signed transaction was submitted, and nobody can say whether it landed.

Both available responses are wrong:

- **Re-sign and re-broadcast.** If the original did land, the account is debited
  twice. That is a double-spend, and it is the most expensive bug this system
  can have.
- **Do nothing.** If the original did not land, the user's funds stay locked
  indefinitely with no path to release that does not risk the first case.

There is no third option that is safe _in general_, because the question "did it
land?" cannot be answered from a dead blockhash. The transaction may be sitting
in a validator's queue about to be included.

## Decision

**Use durable nonce accounts.** A transaction built on a durable nonce stays
valid indefinitely until that nonce advances.

Nonce accounts are modelled as first-class custody records, leased from a pool,
one in-flight withdrawal at a time.

## What this buys

1. **Re-broadcasting identical signed bytes is always safe.** The same
   signature is either already on-chain — in which case the network
   deduplicates it — or still valid.
2. **The nonce advancing exactly once is proof the transaction landed exactly
   once.** The ambiguity in "did it land?" disappears: check the nonce.
3. **Signing latency stops being a correctness concern.** An MPC round or a
   human approval can take as long as it takes.

Point 2 is the one that matters. It converts the highest-consequence failure in
the system from "unanswerable" into "read one account".

## Alternatives considered

**Recent blockhash with a short signing deadline.** Keep blockhashes and require
signing to finish within the window. Rejected because the deadline cannot be
honoured: manual review is unbounded by design, and Phase 4's MPC round is a
distributed protocol whose latency is not ours to promise. Building on a
guarantee we cannot keep means the ambiguous case happens in production rather
than never.

**Recent blockhash plus a confirmation-tracking recovery path.** Detect
expiry, then search transaction history to determine whether the transaction
landed before deciding to re-sign. Rejected because the search has a race: a
transaction can be in a validator's queue and not yet visible, so "not found"
does not mean "did not land". The window is small and the consequence is a
double-spend, which is exactly the trade not to take.

**Recent blockhash, and accept the risk at Phase 3's scale.** Tempting, because
`MockSigner` returns instantly and the window never closes in testing.
Rejected: the whole point of Phase 3 is to build the lifecycle correctly while
the signer is controllable. Deferring this means Phase 4 discovers it with real
cryptography in the way, which is the exact ordering `report.md` was written to
avoid.

## Consequences

- A nonce account is an on-chain account with a rent-exempt minimum, which is
  real, ours, and not user-withdrawable. It is accounted to `house_rent`,
  exactly as deposit-address minimums are (prompt_phase2.md rule 157).
- The pool is a finite resource. A nonce account may serve one in-flight
  withdrawal at a time, so pool size bounds withdrawal concurrency. Phase 3
  provisions a small fixed pool; growing it on demand is Phase 4's problem.
- Leasing needs its own concurrency control. Two withdrawals on one nonce
  produce two transactions where only one can succeed, and the loser's failure
  looks like an expiry.
- Advancing the nonce is part of the transaction, so a nonce account's state is
  evidence. Persist which nonce a withdrawal used and the value it was built on
  (prompt_phase3.md rule 145).
- `EXPIRED` remains a state in the machine. With durable nonces it means the
  nonce advanced without our transaction landing — someone else advanced it, or
  a competing transaction on the same nonce won. That is recoverable by
  re-signing against a fresh nonce, and it is _provably_ recoverable, which is
  the difference from the blockhash case.
