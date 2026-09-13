# Runbook: serving another Solana cluster

**Applies to:** Phase 4 · **Audience:** whoever deploys · **ADR:** 0021

A deployment serves one cluster by default. Adding a second is configuration
plus one decision about the token allowlist — there is no migration, because
the ledger already carries the cluster inside its asset keys and the
operational tables already carry it in `chain`.

> **The safest production posture is still one deployment per cluster.**
> Multi-cluster exists so a devnet console and a mainnet console can be the
> same build, not because sharing a process is desirable for real funds.

## 1. Configure it

```bash
SOLANA_CLUSTERS=mainnet-beta,devnet      # must include SOLANA_NETWORK
SOLANA_NETWORK=mainnet-beta              # the DEFAULT: what a request with no header gets
SOLANA_RPC_URL=https://…                 # the default cluster's endpoint
SOLANA_RPC_URL_DEVNET=https://api.devnet.solana.com
```

The API refuses to start if a served cluster has no endpoint, or if
`SOLANA_CLUSTERS` omits `SOLANA_NETWORK`. Both are boot-time failures on
purpose: the alternative is a cluster that accepts requests and then cannot
read a balance, which reads as an outage rather than as a missing line.

## 2. Decide the allowlist deliberately

Mints do **not** inherit across clusters:

```bash
TOKEN_MINTS=USDC:EPjFWdd…Dt1v:6            # the default cluster's
TOKEN_MINTS_DEVNET=USDC:Gh9ZwEmd…tKJr:6    # a DIFFERENT mint address
RISK_ASSET_LIMITS_DEVNET=Gh9ZwEmd…tKJr:1000000000:5000000000:250000000
```

A mint address is not portable. Inheriting `TOKEN_MINTS` would allowlist
whatever token happens to occupy the mainnet USDC address on devnet and credit
users for it. A cluster that configures no mints supports SOL only, which is
the safe reading of a gap.

## 3. Start it and check the boot log

```
chain network verified  targetId=mainnet-beta
chain network verified  targetId=devnet
```

One line per cluster. The check compares the endpoint's **genesis hash**
against the cluster it is configured as, so a URL that does not serve what it
claims fails at boot rather than after someone deposits. `localnet` is exempt —
a fresh validator generates a new genesis on every reset.

`/health/ready` then reports one dependency per cluster (`solana:devnet`,
`solana:mainnet-beta`). One combined probe would report the more optimistic of
the two and an operator would never learn devnet was down.

## 4. Provision a nonce pool per cluster

Durable nonces are **not** shared. A devnet transaction must never consume a
mainnet nonce.

```bash
pnpm --filter @wallet/api provision-nonces -- --cluster=devnet
pnpm --filter @wallet/api reconcile        -- --cluster=devnet
```

Both default to `SOLANA_NETWORK`. Reconciliation compares one cluster's ledger
totals against one cluster's addresses; running it without thinking about which
is how a devnet residual gets treated as a mainnet incident.

## What you do NOT have to do

- **No migration.** `20260912120000_cluster_namespace` already qualified every
  asset key and `chain` value. Nothing further is needed per cluster.
- **No new addresses for existing users.** A user gets an address per
  `(user, chain)` on first request, so their devnet address is created the
  first time they open the deposit page with devnet selected.
- **No ledger changes.** `devnet:SOL` and `mainnet-beta:SOL` are already
  separate accounts, and the database refuses a transaction touching both.

## If something goes wrong

| Symptom                                                | Cause                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot fails: `the RPC endpoint for X does not serve it` | The URL points at a different cluster than its variable name claims.                                                                                                   |
| Boot fails: `SOLANA_RPC_URL_… is required`             | `SOLANA_CLUSTERS` names a cluster with no endpoint.                                                                                                                    |
| Every request 400s with `cluster_not_served`           | A browser holds a stored preference for a cluster you stopped serving. It is discarded on next load; `localStorage.removeItem('atlas.cluster')` clears it immediately. |
| `400 unknown_cluster`                                  | A client is sending `mainnet` rather than `mainnet-beta`. Refused rather than defaulted, deliberately — see ADR-0021.                                                  |
| Balances read zero after enabling a cluster            | Correct. Funds are per cluster; a user's mainnet balance does not appear on devnet.                                                                                    |
| `ledger transaction … spans clusters`                  | A posting built asset keys from two clusters. This is a bug in the caller, and the database refused it before anything was written.                                    |

## Removing a cluster

Drop it from `SOLANA_CLUSTERS` and restart. Nothing is deleted: its ledger
accounts, addresses and history stay, invisible to every cluster-scoped query,
and reappear if the cluster is served again. Balances on a removed cluster are
**not** withdrawable while it is unserved — which is the honest consequence of
turning off the only thing that can sign for them.
