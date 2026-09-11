# ADR-0016: SPL tokens are an explicit per-mint allowlist, and an unknown mint is recorded, not discarded

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 4

## Context

ADR-0008 supported SOL and deferred SPL tokens to Phase 4, naming the four
problems that made the deferral worth it: Associated Token Account derivation,
a second rent obligation per user per mint, per-mint decimals, and the fact that
**an SPL transfer cannot pay its own fee**.

That last one is the reason tokens are a _sweep and withdrawal_ problem rather
than a deposit problem (prompt_phase4.md rules 119–120). A token arriving needs
nothing from us. A token leaving needs the account holding it to have SOL first.

Three questions have to be answered before any code:

1. What identifies an asset now that "SOL" is no longer sufficient?
2. What happens when a mint we do not recognise arrives?
3. Who pays for the ATA, and what account does that expense land in?

## Decision

### 1. A mint allowlist, keyed by mint address, in validated configuration

An asset is identified by its **mint address**, not its symbol. Symbols are not
unique, not authoritative, and trivially spoofed: anyone can mint a token
calling itself `USDC`. The allowlist is therefore a set of mint addresses with
their metadata, validated at boot exactly as `SUPPORTED_ASSETS` has been since
Phase 2.

```
TOKEN_MINTS=USDC:EPjF...Dt1v:6,USDT:Es9v...wNYB:6
            ^     ^              ^
            |     |              decimals — display only
            |     mint address — the identity
            symbol — a label for humans
```

Decimals are carried **only so the interface can render an amount**. They never
participate in arithmetic. This is not a new rule; it is master-prompt rule 115
and prompt_phase2.md rule 64, and tokens are where it becomes tempting to break
it. A `NUMERIC(38,0)` of base units is the amount. A float of "USDC" is a bug.

### 2. An unrecognised mint is recorded as `ignored`, with a reason

Not credited. Not discarded.

Unrecognised tokens arriving at a custody address is **routine**, not
exceptional — airdrops, dust, and spam mints reach any address that has ever
appeared on chain. Two failure modes bracket the correct behaviour:

| Behaviour                | Failure                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| Credit it                | the platform now owes a liability in an asset it cannot value or sell    |
| Silently drop it         | a user asks "where is my token" and there is no record to answer with    |
| **Record it as ignored** | **chosen** — the deposit exists, is attributable, and is not a liability |

The third is the only one that survives contact with a support ticket. The row
carries the mint, the amount, the transaction signature, and
`ignored_reason = 'mint_not_allowlisted'`.

An ignored deposit produces **no ledger entries**. It is an observation about
the chain, not an accounting event.

### 3. ATA rent is a house expense, credited to `house_rent`

An Associated Token Account has its own rent-exempt minimum, per user per mint.
It is real lamports, spent by us, held by an account we control, and **not
withdrawable by the user** — which is precisely the description of a deposit
address's own rent-exempt minimum, already resolved in Phase 2.

So it gets the same treatment: `debit chain_assets / credit house_rent`.

Crediting it to the user would create a SOL liability the user never deposited
and cannot withdraw. Leaving it unposted would make it reconciliation drift
forever.

### 4. Fee funding precedes any token movement, and is a house expense

Before a token can leave a deposit address, that address needs SOL for the fee.
The funding transfer is `debit chain_assets / credit house_fees` — the same path
`postHouseFunding` established in Phase 3 when network fees stopped being paid
out of pooled customer funds.

The ordering is not an optimisation. A token sweep that has not been fee-funded
does not fail gracefully; it fails at broadcast, after signing, having consumed
a nonce.

## What this does NOT protect against

- **A malicious mint with a freeze authority.** An allowlisted mint whose
  authority freezes our token account leaves the balance credited to a user and
  unwithdrawable. Allowlisting is a judgement about the issuer; it is not a
  technical guarantee, and adding a mint is therefore an operator decision with
  a review, not a configuration convenience.
- **A mint that changes its supply or decimals after allowlisting.** Decimals
  are cached at allowlist time for display. A mint that alters them makes our
  rendering wrong. Nothing in the accounting breaks, because decimals are not
  used in arithmetic — which is most of the argument for that rule.
- **Token-2022 extensions.** Transfer hooks, transfer fees and confidential
  transfers change what a transfer means. The allowlist covers the original SPL
  Token program only; a Token-2022 mint is not allowlistable until that is
  designed.

## Alternatives considered

**Allow any mint and let risk decide.** Rejected. Risk evaluates withdrawals of
assets the platform holds; it is the wrong layer to decide whether an asset
should ever have become a liability. It also inverts the default: an allowlist
fails closed, a blocklist fails open, and failing open on custody is not a
trade-off worth making.

**Identify assets by symbol.** Rejected as above — symbols are attacker-chosen.
This would be the single most likely way to credit a user with a worthless
token that shares a name with a valuable one.

**Credit unknown mints to a suspense account.** Considered seriously, because it
keeps the ledger a complete record of everything that arrived. Rejected because
a suspense balance in an unvalued asset is a liability nobody can discharge, and
because the `ignored` deposit row already answers the question a suspense
account exists to answer.

**Store decimals-adjusted decimal amounts for tokens.** Rejected in Phase 2 for
SOL and rejected again here for the same reason. Two representations of one
amount is one representation too many.

## Consequences

- `assets` becomes a richer allowlist: SOL plus a set of mints. The `(owner,
asset, type)` ledger account key is unchanged, because it was asset-parametric
  from Phase 2 — the point of having designed it that way.
- The uniqueness key for a deposit stays `(chain, tx_signature,
instruction_index)`. One transaction moving SOL and a token to the same
  address is **two deposits**, and the key already expresses that.
- The risk engine's limits become **per-asset**. A daily limit denominated in
  SOL must not silently apply to USDC; applying a SOL-shaped number to a
  6-decimal token is off by three orders of magnitude in the dangerous direction.
- The withdrawal state machine is unchanged. If a token withdrawal cannot reuse
  it, the state machine was chain-specific and that is the defect
  (prompt_phase4.md rule 126).
- `house_rent` grows with users × allowlisted mints. That is a real cost of
  offering a token and should be visible in the reconciliation report.
- Adding a mint is an operator action with an audit entry, not a config edit
  someone does quietly.
