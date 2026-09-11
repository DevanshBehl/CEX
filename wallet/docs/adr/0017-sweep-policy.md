# ADR-0017: A sweep is a withdrawal, and the destination lives in the signing boundary

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 4

## Context

ADR-0004 gave every user their own deposit address. Money therefore arrives
spread across as many addresses as there are users, and has to be consolidated
into the hot wallet before it can fund anything.

ADR-0005 made a commitment that Phase 4 now has to honour: a deposit key's only
authority is to **sweep to one hardcoded destination**. That was the entire
justification for holding deposit keys under weaker protection than treasury
keys. If Phase 4 implements sweeps with a caller-supplied destination, the
justification evaporates retroactively and ADR-0005 becomes a story we told
ourselves.

Two decisions follow: what a sweep _is_, and where the destination _lives_.

## Decision

### 1. A sweep is a withdrawal, on the same lifecycle

A sweep signs, broadcasts, confirms, settles, can expire, can fail to broadcast,
and can land ambiguously. That is the withdrawal state machine's entire subject
matter. It reuses it — the same 15 states, the same 24 transitions, the same
durable nonce, the same retry and expiry budgets (ADR-0012), the same
ambiguous-broadcast resolution (ADR-0009).

A parallel sweep implementation would be a second set of the same bugs, found
later and under worse conditions. The lifecycle is the asset; reusing it is the
point of having built it generically.

**What differs is the accounting, not the mechanics.**

### 2. A sweep changes no user liability, and posts only its fee

A withdrawal moves value from a user to the outside world:

```
debit  user_locked      credit chain_assets      (settlement)
```

A sweep moves value between two addresses the platform already controls — and
the honest consequence is that **it posts no transfer at all**.

The chart of accounts has exactly one `chain_assets` account per asset
(`ownerId` is null for it); there is no per-tier dimension. So the ledger's
answer to "how much does the platform control" is identical before and after a
sweep, and a transfer entry would have to debit and credit the same account,
which is not an entry. Where the money sits is an **operational** fact,
recorded on the address and withdrawal rows. It is not an accounting fact.

> **Corrected during implementation.** This ADR originally specified
> `debit chain_assets:deposit / credit chain_assets:hot`. Those accounts do not
> exist, and writing them would have required adding a tier dimension to
> `chain_assets` to record something the ledger does not need to know. The
> correction is recorded rather than quietly edited, because the original is
> the intuitive answer and the next person will reach for it too.

What a sweep genuinely does change is that it burns a network fee, which really
does leave the platform:

```
debit  house_fees       credit chain_assets      (postSweepFee)
```

Drawn from the prepaid house balance, never from the pooled assets backing user
balances — the Phase 3 lesson, applied to a new caller (rules 121, 132).

This also explains why reconciliation works the way it does: it sums **every**
platform address and compares against **one** aggregate (rule 141), and that
comparison is correct precisely because the total does not depend on the tier
split. Per-tier balances are answered by asking the chain per address, not by
asking the ledger.

The invariant to test: **total user liabilities are bit-identical across a
sweep.** A sweep that changes a user balance is not a sweep with a bug, it is a
different operation wearing the name.

### 3. The destination is compiled into the signing boundary

The deposit-key signer accepts a request to sweep. It does **not** accept a
destination.

```
   sweep(deposit_address, asset, amount)        <- what the caller may ask for
   destination = SWEEP_DESTINATION              <- what the signer decides
```

A destination passed in by a caller is a destination an attacker who owns the
caller can choose. That returns exactly the authority ADR-0005 removed, and it
does so in the one place where the weaker protection of deposit keys was
justified by its absence. The API is the coordinator; ADR-0015 already
establishes that a compromised coordinator must be a liveness problem, not a
safety one. A configurable sweep destination would make it a safety one.

So the destination is configuration **of the signing service**, read at boot,
and changing it is a deployment of that service with an audit trail — not a
field in a JSON body.

### 4. Never sweep the rent-exempt minimum

A swept-to-zero account ceases to exist, and the next deposit to it pays to
recreate it. Worse, an SPL token account that is closed loses its association
and the next transfer can fail outright.

The sweepable amount is `balance - rent_exempt_minimum`, and for tokens also
`- fee_reserve`. This is arithmetic, not policy, but it is the arithmetic most
likely to be written as `balance` by someone in a hurry.

### 5. Tokens are fee-funded first, in a separate transaction

An SPL transfer cannot pay its own fee (ADR-0016). The deposit address is
therefore funded with SOL **before** the token sweep is built, as its own
transaction with its own confirmation.

Combining funding and transfer into one transaction is tempting and wrong: the
fee payer for the combined transaction would have to be the hot wallet, which
means the hot wallet signs a transaction that also moves a deposit address's
tokens — putting two key classes in one signature and dissolving the boundary
between them.

## What this does NOT protect against

- **A compromised signing service.** The hardcoded destination binds the API,
  not the service that holds it. Whoever owns that service owns the destination.
  That is the trust boundary working as designed, not a gap in it.
- **Sweeping to a hot wallet that is itself compromised.** Consolidation
  concentrates value by construction. This is what custody tiers (ADR-0018) and
  the hot-wallet ceiling exist to bound.
- **A user depositing to an address after we retire it.** Addresses are never
  retired in this design. If they ever are, the sweep path must outlive the
  address's assignment or the funds are stranded.

## Alternatives considered

**Sweep on a schedule regardless of balance.** Rejected: sweeping dust costs
more in fees than it consolidates. A sweep triggers on a per-asset threshold,
and the threshold is configuration.

**Sweep immediately on every deposit.** Rejected for the same reason, plus it
makes deposit latency depend on sweep latency and gives an attacker a way to
make us pay fees on demand by sending dust.

**Omnibus deposit address — one address for everyone, no sweeps at all.**
Rejected in ADR-0004 for attribution reasons, and the reasoning stands. It would
eliminate this ADR entirely, which is a real argument in its favour, but it
attributes deposits by memo and memos get lost.

**A separate `sweeps` table and lifecycle.** Rejected as above. The
discriminator is a column on the existing withdrawal record, not a new table.

## Consequences

- The withdrawal state machine acquires a sweep discriminator, and the ledger
  posting for settlement branches on it. Everything else about the lifecycle is
  shared, including the workers.
- `postSweepFee` posts the fee and nothing else, and is tested with the
  property that total user liabilities do not move.
- Deposit-key signing gains an operation that takes no destination. This is the
  concrete honouring of ADR-0005, and the boundary test for it is: _can a caller
  make a deposit key pay an arbitrary address?_ The answer must be no, proven by
  a test, not by reading the code.
- Sweeps are visible as an operational status (prompt_phase4.md rule 155), and a
  stuck sweep gets a runbook.
- Sweep fees are a house expense, funded through `postHouseFunding`. A sweep
  that pays its fee out of pooled customer funds is the Phase 3 bug recurring in
  a new place.
