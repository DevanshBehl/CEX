# ADR-0005: Deposit keys are a separate, lower-privilege key class

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 2

## Context

ADR-0004 gives every user their own deposit address, so the system will hold as
many deposit keys as it has users. master-prompt rules 95 and 99–100 say signing
material lives outside the ordinary application database, is never reconstructed
for convenience, and never reaches the frontend. Phase 4 puts treasury keys
behind threshold MPC.

Applying that same treatment to every deposit key would make the Phase 4 key
ceremony cost scale with user count — a distributed key generation round per
signup. That is not workable, and pretending otherwise would push the problem
into the phase least able to absorb it.

## Decision

Two key classes, with different protections, justified by what each can do.

| Class        | Holds                    | Protection                       | Can send to                                    |
| ------------ | ------------------------ | -------------------------------- | ---------------------------------------------- |
| **Deposit**  | one key per user address | encrypted at rest, single-signer | the omnibus hot wallet, and nowhere else       |
| **Treasury** | hot / warm / cold        | threshold MPC (Phase 4)          | any validated destination, after risk approval |

A deposit key's only authority is to sweep to one hardcoded destination. It
cannot pay an arbitrary address, so compromising one yields the balance of a
single user's deposit address between sweeps, and cannot redirect it anywhere
the platform does not already control.

## Alternatives considered

**One key class, everything under MPC.** Uniform and simple to reason about.
Rejected on cost: a DKG round per user is not a thing that scales, and the
protection bought is small because a deposit key's authority is already narrow.

**No keys for deposit addresses at all — PDAs.** See ADR-0004: requires an
on-chain program.

**Deriving deposit keys on demand from the master seed, storing none.** Fewer
secrets at rest, which is genuinely attractive. Rejected because it makes the
master seed hot: it must be available to the sweep process continuously, which
concentrates the entire risk into one value rather than distributing it.

## Consequences

- The blast radius of a deposit key is one user's un-swept balance. The blast
  radius of the master seed is all of them, so the seed's handling is the real
  control and must be treated as such in Phase 4.
- Sweep frequency becomes a security parameter, not just an efficiency one: the
  longer between sweeps, the more sits behind a single-signer key.
- **Phase 2 stores no deposit key material at all.** It derives addresses,
  records public data, and never needs to sign. The key class described here is
  a commitment about Phase 4, made now because ADR-0004 depends on it being
  true.
- The sweep destination must be hardcoded in the signing boundary, not passed in
  by a caller. A configurable destination gives back exactly the authority this
  decision removes.
