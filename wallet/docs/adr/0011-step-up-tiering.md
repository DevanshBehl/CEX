# ADR-0011: Step-up freshness by withdrawal value

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 3

## Context

`requireStepUp(maxAgeSeconds)` has existed since Phase 1, gating credential and
2FA changes. It was built then, deliberately, against operations where a bug
costs an inconvenience rather than money (prompt_phase1.md rules 138–139).
Phase 3 is what it was actually for.

The question is not _whether_ withdrawals require a step-up — master-prompt
rules 132 and 162 settle that — but how fresh the assertion must be.

## Decision

Freshness scales with value, in three tiers.

| Withdrawal value                      | Max step-up age    | Rationale                      |
| ------------------------------------- | ------------------ | ------------------------------ |
| below `RISK_MANUAL_REVIEW_ABOVE`      | 300s (the default) | ordinary use                   |
| at or above it                        | 60s                | a deliberate act, re-confirmed |
| any amount from an unseen destination | 60s                | the account-takeover shape     |

The default 300s already applies to credential management, so the same session
that just added a passkey can make a small withdrawal without a second prompt.

## Why freshness is the right currency

A step-up asserts _who is at the keyboard right now_. Its value decays: an
assertion from four minutes ago is weaker evidence than one from four seconds
ago, because the window in which a device could have been taken over is larger.

Tiering by value is therefore not "more security for more money" in a vague
sense — it is a shorter window of trust for a larger loss. The friction and the
exposure move together.

## Why not require a step-up on every withdrawal regardless

A prompt the user sees every time is a prompt the user learns to dismiss.
Habituated confirmation is worse than no confirmation, because it produces the
same click with none of the attention. Reserving the short window for
consequential withdrawals keeps it meaningful.

## Alternatives considered

**A single fixed freshness for all withdrawals.** Simplest. Rejected because
any single number is wrong at one end: strict enough for a large withdrawal is
hostile for a small one, and relaxed enough for a small one is careless for a
large one.

**A second factor (TOTP) instead of a fresh passkey assertion.** Rejected
because the passkey is the stronger factor and is already present. Asking for
the weaker one is a downgrade dressed as extra security.

**Per-destination confirmation with an email loop.** The strongest option, and
genuinely what a production system should do for a new destination. Rejected for
Phase 3 because there is no mail transport (prompt_phase1.md rule 24), and a
recorded gap beats a half-built one.

## Consequences

- The client must handle `STEP_UP_REQUIRED` on withdrawal submission and retry
  after a fresh assertion. `useStepUpAction` already does exactly this for
  credential management and needs no change.
- `StepUpRequiredError` already carries `stepUpMaxAgeSeconds`, so the client
  learns the required freshness from the error rather than hardcoding a tier
  table it would then have to keep in sync.
- The tier boundary reuses `RISK_MANUAL_REVIEW_ABOVE`, so there is one number
  meaning "this is a large withdrawal" rather than two that can drift apart.
- Phase 3 has no operator role model, so the operator queue is gated behind
  configuration plus a step-up. A real role model is Phase 4.
