# ADR-0004: One derived deposit address per user per asset

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 2

## Context

A deposit has to be attributed to exactly one user. Solana has no reliable
memo-based deposit convention — the network supports a memo instruction, but
users send from exchanges and wallets that omit it, mangle it, or refuse to
attach one. Attribution therefore has to come from the destination address
itself, or from something equally unavoidable.

prompt_phase2.md rules 12, 17 make this the first decision because it determines
the indexer's shape, the eventual sweep economics, and the number of keys the
MPC service will have to hold in Phase 4.

## Decision

**One deterministically derived deposit address per user per asset.**

Addresses are derived from a single master seed plus a per-user index. The
derivation path is stored alongside the address so the set is reconstructible
from the seed alone, without the database.

## Alternatives considered

**Omnibus account plus a payment reference (memo).** One address, no derivation,
no per-address watching, and no sweep — genuinely the cheapest option
operationally. Rejected because attribution depends on the sender doing
something optional. A deposit that arrives without a memo is unattributable
except by hand, and the volume of those is not a rounding error: it is normal.
An unattributable deposit in a custody system is a support incident with a real
person's money in the middle of it.

**Omnibus plus per-user sub-accounts via PDAs.** Attribution is structural and
there is no seed to manage. Rejected for Phase 2 because a PDA cannot sign, so
moving funds out requires a program, and writing an on-chain program is a
different project with a different threat model (master-prompt rule 106 by
analogy — do not invent the security-critical part).

**A fresh address per deposit rather than per user.** Better privacy between a
user's own deposits. Rejected because the watch set grows without bound, the
user has to fetch a new address every time, and users reuse the old one anyway —
which then has to stay watched forever, so nothing is actually saved.

## Consequences

- The indexer watches N addresses, not one. This is the main cost, and it is
  what ADR-0007 has to accommodate.
- Funds accumulate across many addresses and must eventually be swept into an
  omnibus hot wallet. Sweeping needs signing, so it is Phase 4 — Phase 2 leaves
  funds where they land.
- Each funded address carries a rent-exempt minimum that is real, ours, and not
  user-withdrawable. It is accounted to `house_rent` (prompt_phase2.md rules
  113, 157).
- Deposit addresses need keys, and there will be many of them. ADR-0005 exists
  because the answer to "how are those keys held" cannot be "the same way the
  treasury is".
- Address reuse across a user's deposits is accepted. This is a custodial
  system; the platform already knows the linkage.
