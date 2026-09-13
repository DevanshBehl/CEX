# ADR-0021: The cluster belongs in the ledger asset key

- **Status:** accepted
- **Date:** 2026-09-12
- **Phase:** 5
- **Relates to:** ADR-0019 (second-chain seams), ADR-0006 (network verification)

## Context

The product must let a user switch between `devnet`, `testnet` and
`mainnet-beta` and see only that cluster's holdings. Today the network is a
boot-time constant: one API process serves one cluster, verified against the
endpoint's genesis hash at startup.

The ledger has **no network dimension at all**. `ledger_accounts` is keyed
`(owner_id, asset, type)`, and `ledger_entries` and `ledger_transactions` carry
nothing either. Devnet SOL and mainnet SOL are both `asset = 'SOL'`, same owner,
same type — **the same account**.

So a naive cluster switch adds worthless testnet balances to real ones, and
every double-entry invariant still passes, because nothing is inconsistent. It
is simply wrong.

This is the case ADR-0019 did not cover. That ADR concluded the ledger needs no
changes to support a second CHAIN, because ETH and SOL are naturally distinct
asset keys. Two clusters of the same chain share asset keys exactly. **The
property that made multichain cheap is the property that makes multi-cluster
expensive.**

## Decision

**The cluster goes into the ledger asset key**, not into a new column:

```
devnet:SOL
mainnet-beta:SOL
devnet:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
mainnet-beta:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

Constructed through a typed helper, never by string concatenation at call sites.

## Why the key and not a column

A column is the obvious answer and it is the wrong one, for the same reason
`user_locked` is an account rather than a column on `user_available`.

With a `cluster` column, every balance query must remember `WHERE cluster = ?`.
**Forgetting it silently sums clusters** — the query returns a number, the
number is wrong, and nothing anywhere reports an error. There is no test that
catches a missing filter in a query nobody wrote yet.

With the cluster inside the key there is no query that merges clusters by
omission. Asking for `devnet:SOL` gets devnet SOL; there is no way to
accidentally ask for both. The mistake becomes unrepresentable rather than
merely discouraged.

It is also far less migration surface: the existing
`UNIQUE (owner_id, asset, type)` constraint already separates clusters once the
cluster is in `asset`, and every projection, every invariant check and every
index keeps working untouched.

## The cost, stated honestly

- **Asset keys become opaque strings** that must be parsed for display. Mitigated
  by making them a branded type with a constructor and a parser, so a bare
  string cannot be passed where a key is expected.
- **They get long.** `mainnet-beta:` plus a 44-character mint is 57 characters,
  so the wire schema's asset bound rises accordingly.
- **Existing rows must be backfilled** to the cluster they were actually
  recorded on. There is exactly one such cluster per deployment and it is
  known, so the backfill is a constant.
- **`asset` now means two things** — the cluster and the asset — which is the
  usual objection to composite keys. Accepted because the alternative fails
  silently and this one fails loudly.

## The cluster is untrusted input

The client selects a cluster and sends it as `X-Solana-Cluster`. That header is
**data, not authority**:

- It is validated against the configured cluster registry, never used raw.
- It scopes what a user may READ of their own holdings.
- It never decides what may be spent. A withdrawal's cluster comes from the
  stored withdrawal record, not from the header on the request that approves it
  — otherwise a devnet-funded balance could be used to authorise a mainnet
  transfer.

## What was built

### Two database guarantees, not one

The per-asset balance check already makes a cross-cluster _transfer_
impossible: debit `devnet:SOL`, credit `mainnet-beta:SOL` leaves two groups,
each with a residual. It does **not** catch a transaction that is balanced in
two clusters at once — nothing crosses, nothing is unbalanced, and yet one
financial event claims to have happened on two chains, which makes settling it
undoable on one of them.

So the migration adds both:

- a `CHECK` refusing any asset key without a known cluster prefix, on
  `ledger_accounts`, `ledger_entries`, `deposits` and `withdrawals`, and a
  matching one refusing an unqualified `chain` on the operational tables;
- a deferred constraint trigger, `ledger_entries_single_cluster`, refusing a
  transaction whose entries span clusters.

`buildTransaction` enforces the same two rules in the application, which is
where the comprehensible error comes from. The database is the guarantee — it
holds for raw SQL, for a migration, and for any future code path that forgets
the builder.

### The backfill temporarily disables an append-only trigger

`ledger_entries` refuses `UPDATE` from everyone, deliberately, so that nobody
can quietly correct a balance. Qualifying a namespace is not correcting a
balance: no amount, direction, account or transaction membership changes. The
trigger is disabled for exactly those statements and restored immediately, and
the migration then **proves** it moved no money — per-asset, per-direction row
counts and totals must match the pre-image exactly or the migration aborts.

That check is what makes disabling the trigger defensible. It is not "we were
careful"; it is "the totals are identical or nothing is committed".

The cluster the existing rows belong to cannot be derived from the data, so it
is read from `wallet.backfill_cluster`, defaulting to `localnet` — the reading
that treats existing balances as play money. Labelling devnet dust as mainnet
is the expensive error; the reverse is not.

### One object graph per cluster

The API builds a `ClusterRuntime` per served cluster: its own RPC connection,
adapter, nonce pool, indexer, allowlist and risk limits. Nothing is shared
except the database, the signer and the process.

Threading a `cluster` argument through every call would have worked only for as
long as every call site remembered to pass it, and the failure when one did not
would be a devnet balance rendered as mainnet money. Separate object graphs make
that unrepresentable: code holding the devnet runtime has no reference through
which mainnet can be reached.

### `@wallet/solana` is where the cluster enters the key

The adapter stamps `chain` and qualifies every asset it emits, because it is the
only package that knows what a Solana cluster is. Everything above it treats the
key as opaque, which is what keeps the ledger chain-independent (ADR-0019).

### An unknown header is refused, an absent one is not

An absent `X-Solana-Cluster` means the client has no opinion, and the server
answers with its default. A malformed one — `mainnet` rather than
`mainnet-beta` — is **refused**, because defaulting there would answer a client
that thought it was asking about mainnet with devnet balances. A real cluster
this deployment does not serve is refused with a different reason: the fix is
configuration, not a corrected request.

### The header is a CORS problem before it is anything else

`X-Solana-Cluster` is a custom header, which makes every browser request a
**preflighted** one. A header missing from the API's `allowedHeaders` fails the
preflight and the browser blocks the request entirely — and nothing server-side
notices, because every integration test injects into Fastify directly and never
crosses an origin.

That is exactly what happened: 445 unit tests and 207 integration tests stayed
green while the web application could not make a single call. The E2E suite is
what caught it, which is the argument for having one.

### Workers must claim by chain, not only by status

Found on a live devnet run: `claimNext` and `listByStatus` filtered on STATUS
alone. A devnet worker claimed a localnet withdrawal, leased a devnet nonce for
it, and asked a devnet RPC about a localnet signature — a chain error in a loop.

The second-order failure is worse and silent: a withdrawal claimed by the wrong
cluster's worker is moved into a state that only that worker will act on, and
no worker that _can_ act on it will ever see it again. Both queries take a
`chain` now, and it is required rather than optional.

## Consequences

- One API process can serve every cluster, with one RPC connection per
  configured cluster and the genesis check (ADR-0006) applied per connection at
  boot.
- Indexer cursors, nonce pools and reconciliation all become per cluster. The
  `chain` column on the operational tables carries `solana:devnet` rather than
  `solana`.
- Token allowlists are per cluster: devnet USDC and mainnet USDC are different
  mints and must not be interchangeable.
- Risk limits are per cluster as well as per asset. A devnet daily limit is
  meaningless, and applying a mainnet limit to devnet would block testing.
- A deployment may still restrict itself to one cluster, and the safest
  production posture is still one deployment per cluster. This ADR makes the
  multi-cluster shape _possible_, not mandatory.
