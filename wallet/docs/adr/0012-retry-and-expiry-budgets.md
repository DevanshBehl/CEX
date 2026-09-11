# ADR-0012: Retry and expiry budgets

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 3

## Context

Three edges in the withdrawal state machine retry: `SIGN_FAILED`,
`BROADCAST_FAILED`, and `EXPIRED`, each returning to `FUNDS_LOCKED`.

"Retry forever" and "give up immediately" are both wrong. Forever means a
withdrawal that can never succeed consumes a worker and holds a user's funds
locked indefinitely, with nothing surfacing to a human. Immediately means a
transient RPC hiccup becomes a failed withdrawal and a support ticket.

prompt_phase3.md rule 25 asks for the number in between to be a decision rather
than a guess.

## Decision

Each failure edge gets its own budget, because the failures are not alike.

| Edge               | Attempts | Backoff                | Why                                                               |
| ------------------ | -------- | ---------------------- | ----------------------------------------------------------------- |
| `SIGN_FAILED`      | 3        | 2s, 8s, 32s            | the signer is ours; repeated failure is a real fault, not weather |
| `BROADCAST_FAILED` | 5        | 1s, 4s, 16s, 64s, 256s | the RPC is a network dependency and transient rejection is normal |
| `EXPIRED`          | 3        | immediate              | a fresh nonce is needed, not a pause                              |

All backoff is exponential with full jitter, so concurrent retries do not
re-collide in lockstep — the same pattern `withTransaction` already uses.

A withdrawal that exhausts any budget moves to a terminal failed state,
**releases its lock**, and surfaces to an operator.

## Why the budgets differ

`SIGN_FAILED` is an internal fault. In Phase 3 the signer is a mock, and in
Phase 4 it is a threshold protocol we operate. If it fails three times with
backoff, something is wrong that retrying will not fix, and a human should see
it sooner rather than later.

`BROADCAST_FAILED` is an external dependency. A rejected submission is
routinely a rate limit, a node behind on slots, or a blip. Five attempts over
roughly five minutes rides out the normal ones without holding funds for hours.

`EXPIRED` under durable nonces (ADR-0009) means the nonce advanced without our
transaction landing — a competing transaction won the nonce. There is nothing
to wait for: lease a fresh nonce and rebuild. Backoff would only delay the fix.
The budget exists to stop a pathological loop where every lease immediately
loses.

## Why an exhausted budget releases the lock

The alternative is leaving the funds locked and letting an operator decide.
Rejected: a lock the user cannot see through and cannot act on is worse than a
visible failure. Releasing puts the funds back in the user's control and leaves
the withdrawal in a terminal state with its full history intact, which is what
`withdrawal_transitions` is for.

The release is itself a balanced ledger transaction, so nothing is lost — the
money moves `user_locked → user_available`, visible in the entry history like
every other movement.

## The one thing that must never be retried

**Re-signing is not a retry.** `SIGN_FAILED` returns to `FUNDS_LOCKED` and signs
again only because no transaction was ever produced. Once bytes exist and have
been broadcast, the response to uncertainty is to **re-broadcast the identical
bytes**, never to sign new ones (prompt_phase3.md rules 140–143).

A re-sign without proof the previous attempt is dead is a double-spend. Under
durable nonces that proof is available — check whether the nonce advanced — and
it must be obtained before any re-sign, not assumed from a timeout.

## Alternatives considered

**One shared budget for all three edges.** Simpler to implement and to explain.
Rejected because it forces the same tolerance onto an internal fault and an
external blip, and whichever number is chosen is wrong for one of them.

**Unbounded retry with alerting.** Appealing because no withdrawal is ever
abandoned. Rejected because "alerting" without a terminal state means the
withdrawal stays live, the lock stays held, and the worker keeps trying — the
alert fires into a system that has not stopped, so nothing about it forces a
resolution.

**A time budget rather than an attempt count.** Arguably better: "keep trying
for 10 minutes" is closer to what is actually meant. Rejected for Phase 3
because an attempt count is trivially testable and a wall-clock budget needs a
controllable clock everywhere it is checked. Worth revisiting in Phase 4, where
the observability to reason about it will exist.

## Consequences

- Every retry increments a persisted attempt count on the withdrawal, so the
  budget survives a worker restart. An in-memory counter would reset and retry
  forever.
- The attempt count is per-edge, not global: a withdrawal that fails to
  broadcast twice and then expires has not used up its signing budget.
- Terminal failure needs an operator path, which the manual-review queue already
  provides a surface for. Phase 3 shows such withdrawals there; acting on them
  beyond releasing the lock is Phase 4.
- The backoff schedules are configuration, validated at boot, so a deployment
  can tune them without a code change.
