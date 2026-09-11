# ADR-0007: RPC polling behind an interface

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 2

## Context

ADR-0004 gives the indexer N addresses to watch. Something has to notice a
transfer to one of them and hand it to the deposit pipeline.

## Decision

**Poll `getSignaturesForAddress` per watched address, with a persisted cursor**,
behind a `TransferSource` interface that the deposit pipeline depends on instead
of depending on polling.

## Alternatives considered

**Geyser / Yellowstone gRPC.** A push stream straight from a validator: lower
latency, no polling amplification, and the right answer at scale. Rejected for
Phase 2 because it requires either running a validator or paying for a provider,
and it replaces a failure mode that is easy to reason about (a poll returned
nothing) with one that is not (a stream silently stopped delivering). The
project is educational and the volume is zero; buying scale here costs
correctness clarity.

**Webhook provider (Helius and similar).** Least infrastructure. Rejected
because it puts deposit detection behind a third party and an inbound HTTP
endpoint, which is a larger security surface than the whole rest of Phase 2, and
because a missed webhook is invisible — the system cannot tell "nothing
happened" from "we were not told".

**Polling `getBlock` and filtering.** Chain-wide, so it scales independently of
the watch set and is what a real exchange does. Rejected for now because it
requires handling every block whether or not it concerns us, plus its own
skipped-slot and gap logic. Worth revisiting when the watch set is large enough
that per-address polling stops making sense.

## Why the interface matters more than the choice

Every rejected option above becomes reasonable at a scale this project may reach
later. The `TransferSource` seam means switching is a new implementation, not a
rewrite of the deposit pipeline — the same argument as the `Signer` interface in
Phase 3, and the reason prompt_phase2.md rule 15 asks for the decision to be
recorded rather than assumed.

## Consequences

- Request volume is O(watched addresses), which sets a practical ceiling. When
  it is reached, the answer is `getBlock` or Geyser behind the same interface.
- The cursor is the correctness-critical piece: it is persisted only after the
  batch it describes has committed (prompt_phase2.md rules 146–147), so a
  restart re-processes rather than skips, and re-processing is a no-op by the
  uniqueness constraint.
- Pagination boundaries need explicit tests. `getSignaturesForAddress` returns a
  bounded page, and the boundary is where cursor bugs live.
- Detection latency is one poll interval on top of finality. Acceptable given
  ADR-0006 already sets the floor at ~13 seconds.
