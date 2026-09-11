# ADR-0006: Credit only at `finalized`

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 2

## Context

Solana exposes three commitment levels. The difference between them is not
latency — it is whether the transaction can still be undone.

| Commitment  | Meaning                                | Can be rolled back           |
| ----------- | -------------------------------------- | ---------------------------- |
| `processed` | a validator has seen it                | yes, routinely               |
| `confirmed` | a supermajority has voted on its block | yes, on a fork               |
| `finalized` | ≥31 confirmed blocks built on top      | no, absent a network failure |

master-prompt rule 125 requires a configured confirmation policy before a
deposit is attributed. rule 130 says never credit the same transfer twice — and
the mirror of that, crediting a transfer that later ceases to exist, is the same
class of error with the sign flipped.

## Decision

**Credit at `finalized`, and nowhere else.** The commitment is a single
validated configuration value read at boot, so it cannot be weakened in one code
path while remaining strict in another.

## Alternatives considered

**Credit at `confirmed` (~1–2s) instead of `finalized` (~13s).** The tempting
option, and a difference users can feel. Rejected because a `confirmed`
transaction on a minority fork can be dropped. The failure mode is not a delayed
balance; it is a credited balance for money the platform never received, and the
correction is a debit against a user who has already been told the funds
arrived. Twelve seconds is a cheap price for that not being possible.

**Credit at `confirmed` and reverse on fork detection.** Requires reliable fork
detection, a compensating-entry path, and a user-facing story for a balance
going down. Every part of that is harder than waiting, and each part can fail
independently.

**Show `confirmed` in the UI as "confirming", credit at `finalized`.** Adopted —
this is not really an alternative. The user sees progress; the ledger does not
move until finality. See prompt_phase2.md rule 173.

## Consequences

- A deposit takes roughly 13 seconds from landing to being spendable, and the UI
  must make that legible rather than looking stalled.
- The indexer must track a transfer across commitment transitions without
  crediting at any intermediate one.
- Reconciliation must exclude sub-finalized transfers from internal liabilities,
  or it will report a residual that is not real.
- This value governs Phase 3 as well: a withdrawal is not settled until its
  transaction is `finalized`, for exactly the same reason.
