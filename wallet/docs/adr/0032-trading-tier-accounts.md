# ADR-0032: The trading tier in the chart of accounts

**Status:** accepted · **Date:** 2026-09-21 · **Phase:** S3
**Extends:** ADR-0025 (CLOB and two-tier clearing) · **Amends:** ADR-0020 (segregated custody)

## Context

[ADR-0025](./0025-clob-and-two-tier-clearing.md) splits custody into a
segregated vault tier and an omnibus clearing tier. The ledger has no vocabulary
for the second one: `packages/ledger/src/accounts.ts` knows `user_available`,
`user_locked`, `chain_assets`, `house_fees`, `house_rent` and `external`, and
every one of them describes the wallet.

Adding accounts to this ledger is not a one-line change. An account type is
written out by hand in **four** places — `ACCOUNT_TYPES`, a TypeScript union in
`packages/db/src/repositories/ledger.repository.ts`, the Prisma enum, and an
`ALTER TYPE ... ADD VALUE` migration — and there are **eight** `CASE WHEN a.type
= ...` arms in that repository's raw SQL, spread across `getUserBalances`,
`getAssetTotals` and `getSegregatedPositions`.

A new liability type that is added to the enum and missed in a `CASE` arm is not
a compile error. It is a balance that exists in the ledger and does not appear in
the query a user's balance is read from.

There is a second problem, and it is the kind that is cheap now and expensive
later. The vault tier's accounts are called `user_available` and `user_locked`.
The trading tier's will be called `user_trading_available` and
`user_order_locked`. `user_available` sitting next to `user_trading_available`,
in the most-read table in the system, invites the wrong one to be picked.

## Decision

**Four new account types, the vault tier renamed to name itself, and the
duplicated enums generated from one source.**

### The accounts

| Account                  | Class     | Tier     | Holds                                      |
| ------------------------ | --------- | -------- | ------------------------------------------ |
| `user_trading_available` | liability | clearing | spendable on the book                      |
| `user_order_locked`      | liability | clearing | reserved against a live order              |
| `clearing_assets`        | asset     | clearing | what the `house_clearing` address controls |
| `house_trading_fees`     | equity    | —        | maker/taker fees earned (populated in S4)  |

Both user accounts join `USER_LIABILITY_ACCOUNT_TYPES`. That single membership
is what keeps `checkLiabilitiesCovered` correct, because it derives the liability
set from `isUserAccount` rather than from a list someone has to remember to
extend. A trading balance is owed to a user exactly as a wallet balance is, and
the coverage invariant must see it.

All four join `NON_NEGATIVE_ACCOUNT_TYPES`. A negative `user_trading_available`
is an order that was funded by nothing.

`TRANSACTION_KINDS` gains `allocation`, `deallocation`, `order_hold` and
`order_release`. It does **not** gain `trade_settle`: S4 adds that alongside the
posting that uses it, so a kind never exists without a function that produces it.

### The rename

`user_available` → `user_custody_available`, `user_locked` →
`user_custody_locked`, by `ALTER TYPE ... RENAME VALUE`, which is atomic.

It is done **completely or not at all**. Half a rename leaves two names for one
account in one codebase, which is strictly worse than either name alone.

Wire DTOs keep `available` and `locked`. `projectUserBalance` returns
`{ available, locked, total }` and the API contract is unchanged — this is an
internal vocabulary change, and pushing it to clients would buy nothing.

### One source for the enum

The TypeScript union in `ledger.repository.ts` and the Prisma enum are
**generated** from `ACCOUNT_TYPES`, and CI fails when they drift.

This is the part that is easy to skip and should not be. S3 adds four values to a
four-copy problem; doing it by hand is how one of the eight `CASE` arms gets
missed, and the symptom of that is a user's balance that is quietly wrong rather
than an error anybody sees.

## Alternatives considered

**Add the accounts, skip the rename.** Least churn, no migration on live data.
Rejected because the ambiguity it leaves is permanent and sits in the file every
future posting function is written against. The rename is mechanical, the
migration is atomic, and the moment to pay for it is while the second tier is
being introduced rather than after code has been written against both names.

**Rename in the wire contract too, for consistency.** Rejected: `available` and
`locked` are what a user's balance is called, in an API the web app already
consumes, and "custody available" is internal vocabulary that would leak the
platform's tiering into a field name for no benefit.

**Model the tier as a column on `ledger_accounts` rather than as distinct
types.** One account type, a `tier` discriminator, and no new enum values.
Rejected because every invariant in `packages/ledger` pattern-matches on the
account type — `NON_NEGATIVE_ACCOUNT_TYPES`, `USER_LIABILITY_ACCOUNT_TYPES`,
`ACCOUNT_CLASS` — and a discriminator would move those decisions from an
exhaustive match the compiler checks into a runtime condition it does not.

**One `user_locked` shared by withdrawals and orders.** Tempting: both are
reservations of the same shape. Rejected because the two tiers reconcile against
different on-chain balances. A single locked account could not be attributed to
the vault or the clearing pool, and neither reconciliation equation would be
expressible.

**Generate the enums later, as a follow-up.** Rejected for the reason in the
Context: the follow-up would be scheduled after the phase that adds four values
by hand, which is the phase where the mistake happens.

## Consequences

- Adding an account type stops being a four-place edit. The generator makes
  `ACCOUNT_TYPES` the source, and drift becomes a failing build rather than a
  wrong balance.
- The eight `CASE WHEN a.type` arms still need a human to decide which tier a new
  type belongs in. The generator removes the copying, not the thinking, and a
  balance test is what proves the thinking was done.
- The rename touches posting functions, repository SQL, fixtures and tests.
  Everything that refers to the old names by string is a place the compiler
  cannot help, so the migration ships with a test that queries both tiers.
- `house_trading_fees` exists with no writer until S4. That is intended and its
  balance is zero; a reconciliation that expects otherwise is wrong.
- Trading balances are covered by the aggregate clearing equation, not by the
  per-user vault equation. `checkLiabilitiesCovered` sees both tiers as
  liabilities, so the two reconciliation reports must be read together — neither
  alone proves solvency.
