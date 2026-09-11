# ADR-0008: SOL only in Phase 2

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 2

## Context

master-prompt rule 124 asks for SOL and supported SPL-token deposits. Adding
tokens is not simply "one more asset": it introduces Associated Token Accounts,
per-mint decimals, a second rent obligation per user per mint, and the fact that
an SPL transfer cannot pay its own fee — the receiving account needs SOL before
it can do anything.

## Decision

**Phase 2 supports SOL and nothing else.** Assets are an allowlist in
configuration, validated at boot, with SOL its only member. SPL tokens arrive in
Phase 4 (prompt_phase2.md rules 16, 34).

The ledger, the account model, and the `TransferEvent` type are all
asset-parametric from the start, so adding a mint is a configuration entry plus
an adapter change — not a schema migration.

## Alternatives considered

**SOL plus USDC now.** USDC is what a real user would want first, and the token
path is the one with the interesting problems. Rejected because those problems —
ATA creation and its rent, fee funding, decimals as a per-mint value — are
mostly _sweep and withdrawal_ problems, and Phase 2 has neither. Building the
token path here means building it without the machinery that makes it
meaningful, and rebuilding it in Phase 4 anyway.

**Design for tokens, implement only SOL.** Adopted for the data model, rejected
for the code. The `(owner, asset, type)` account key and the base-unit amount
type are already asset-generic; speculative ATA-handling code with no caller is
the "empty package rots" trap from Phase 1 in another form.

## Consequences

- `assets` is a config-validated allowlist, and an unknown asset is rejected at
  the boundary rather than flowing into the ledger.
- Decimals are per-asset metadata used only for display. They never participate
  in arithmetic (prompt_phase2.md rule 64).
- Users must be told, unambiguously and on the deposit screen, that only SOL on
  the configured network is supported. Sending a token to a SOL-only address is
  the most common way users lose funds, and a vague label is a contributing
  cause (prompt_phase2.md rule 172).
- Phase 4 adds: ATA derivation and creation, per-mint rent to `house_rent`, fee
  funding before a sweep, and a mint allowlist with decimals.
