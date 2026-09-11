# ADR-0010: The initial risk policy

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 3

## Context

master-prompt rules 146–151 require per-transaction limits, daily limits,
velocity checks, destination controls, and manual approval for high-risk
withdrawals. The rules say what kinds of limit must exist; the numbers are a
policy decision, and prompt_phase3.md rule 25 says they belong in a document
rather than in a constant somebody guessed at.

## Decision

Six rules, evaluated in a declared order, **all of them, every time** — no
short-circuit on the first denial, so a decision records everything that was
wrong rather than the first thing (prompt_phase3.md rules 92–93).

| Rule            | Denies when                             | Reason code                                   |
| --------------- | --------------------------------------- | --------------------------------------------- |
| Account state   | account is not `active`                 | `ACCOUNT_NOT_ACTIVE`                          |
| Destination     | malformed, off-curve, or platform-owned | `DESTINATION_INVALID`, `DESTINATION_INTERNAL` |
| Per-transaction | amount > single-transaction cap         | `PER_TRANSACTION_LIMIT`                       |
| Rolling daily   | amount + trailing-24h total > daily cap | `DAILY_LIMIT`                                 |
| Velocity        | count in trailing window ≥ cap          | `VELOCITY_LIMIT`                              |
| New destination | first time sending here                 | `NEW_DESTINATION` (review, not deny)          |

Plus a manual-review threshold: above a configured value, the decision is
`review` rather than `approve` (`MANUAL_REVIEW_THRESHOLD`).

### The baseline numbers

These are educational-project defaults, chosen to make every rule reachable in
testing rather than to model a real institution's appetite.

```
RISK_PER_TRANSACTION_LIMIT   =  100 SOL
RISK_DAILY_LIMIT             =  250 SOL
RISK_VELOCITY_WINDOW_MINUTES =   60
RISK_VELOCITY_MAX_COUNT      =   10
RISK_MANUAL_REVIEW_ABOVE     =   25 SOL
RISK_NEW_DESTINATION_REVIEW  = true
```

All are validated config, so a deployment tunes them without a code change —
which is what master-prompt rule 155 ("rules can evolve independently") means in
practice.

## Why the daily window rolls

A calendar-day reset is simpler and is wrong. It lets an attacker take a full
daily limit at 23:59 and another at 00:01 — two limits ninety seconds apart, for
no reason other than an arbitrary boundary. A trailing 24-hour window has no
such seam.

The cost is that the limit is a moving sum rather than a counter, so it must be
computed from history on each evaluation. At this scale that is one indexed
query; at a larger one it becomes a maintained aggregate, which is a Phase 4
concern.

## Why a new destination triggers review rather than denial

The riskiest withdrawal is the first one to an address the account has never
used, because that is what an account takeover looks like. But it is also what
every legitimate first withdrawal looks like, so denying it would deny everyone
their first withdrawal.

Review is the honest response: a human decides. Master-prompt rule 150's address
allowlist is the eventual mechanism that removes the friction for repeat
destinations, and this rule is shaped so that dropping an allowlist in front of
it changes nothing else.

## Why balance is not in this table

Sufficient funds is not a risk rule. The risk engine is pure and has no view of
a balance, and a balance can change between evaluation and locking. The **lock**
is what proves the funds exist, and it proves it atomically — see
prompt_phase3.md rules 94–95 and 113–114.

Putting it here would create a check-then-act race where two concurrent
withdrawals each pass and both proceed.

## Alternatives considered

**A scoring model — sum weighted signals, threshold the total.** More
expressive, and what a mature system converges on. Rejected for Phase 3 because
a score is much harder to explain: "denied, score 0.72" tells an operator
nothing, while "denied: DAILY_LIMIT, NEW_DESTINATION" tells them exactly what to
look at. Master-prompt rule 152 asks for reason codes, and codes are the
artifact of a rule-based engine.

**Denying rather than reviewing above the threshold.** Simpler, no operator
surface needed. Rejected because it makes the platform unusable for exactly the
withdrawals that matter most to a user, and it teaches them to split into
smaller ones — which defeats the limit.

## Consequences

- An operator surface is required, because `review` is reachable by design.
  Phase 3 builds the minimum: a queue, approve, deny, and a required note.
- Reason codes are part of the public contract. They are append-only and never
  repurposed once shipped.
- The **client is told a denial happened and a generic reason; it is never told
  which limit or by how much** (prompt_phase3.md rules 81–82). Returning the
  specific limit turns the endpoint into an oracle for probing thresholds.
- Full codes go to the persisted decision and to the operator.
- Every evaluation is persisted with its inputs, so a decision can be replayed
  years later and explain itself (master-prompt rule 153).
