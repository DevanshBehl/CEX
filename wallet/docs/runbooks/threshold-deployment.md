# Runbook: running the 3-of-5 deployment

**Applies to:** Phase 4b · **ADR:** 0015, 0020 · **See also:** [key ceremony](./key-ceremony.md)

Five participants and one coordinator, locally.

```bash
cargo build --release --manifest-path services/mpc/Cargo.toml
./scripts/mpc-cluster.sh start      # writes scripts/.mpc-cluster.env
. ./scripts/.mpc-cluster.env        # points the API at the coordinator
```

> **This is not a threshold deployment; it is a rehearsal of one.** Five
> processes on one machine share one disk, one operator, one kernel and one
> blast radius — the security ADR-0015 describes comes from five _failure
> domains_, and this has one. Use it to exercise the path, never to hold
> anything.

## What `start` does

1. Generates a KEK per participant, an API caller key, an approval key, and the
   **coordinator's** caller key. The coordinator's public half becomes every
   participant's `MPC_CALLER_PUBLIC_KEY` — a participant's only legitimate
   caller is the coordinator.
2. Starts five participants on 7071–7075 with FROST identifiers 1–5.
3. Starts the coordinator on 7070, which **provisions the house key on first
   boot** by trusted dealer and prints the address.
4. Writes `scripts/.mpc-cluster.env` with `TREASURY_ADDRESS` set to that
   address, `SEGREGATED_CUSTODY=true` and `SIGNER_KIND=real`.

The script refuses to start if any of those six ports is taken. That is not
tidiness: a coordinator that provisions a house key and then fails to bind
leaves _something else_ answering on 7070, and every later request
authenticates against the wrong service's caller key. The symptom is
`UNAUTHENTICATED` with nothing pointing at the cause.

## After a ceremony: the nonce pool is stale

A durable nonce can only be advanced by its **authority**, which is the house
key. A new house key makes every existing nonce account inert — and they look
perfectly healthy: on chain, funded, `available` in the database.

```bash
pnpm --filter @wallet/api run provision-nonces -- --cluster=devnet
```

The script reads each account's on-chain authority, **retires** any that the
configured treasury cannot advance, and provisions replacements. Without that
check a withdrawal leases one, is signed by two threshold rounds, is
broadcast, and is rejected by the runtime — after the nonce round is spent.

## Verifying the threshold actually ran

```bash
# Exactly three participants should have consumed a nonce per round.
for i in 1 2 3 4 5; do
  echo -n "participant $i: "
  sqlite3 /tmp/atlas-mpc-cluster/participant-$i.sqlite 'select count(*) from frost_nonces'
done
```

Three non-zero and two zero is correct: the coordinator stops asking once it
reaches the threshold. Five non-zero means it asked everyone, which is not
wrong but is worth understanding. Fewer than three and no signature was
produced.

The API records one signing request **per key** on a segregated withdrawal:

```sql
SELECT request_id, key_ref, signer_kind, outcome
  FROM signing_requests WHERE withdrawal_id = '...';
```

Two rows — the house key and `user:{id}` — with distinct request ids. One row
means the deployment is not segregated; a shared request id would mean the
service returned the house's signature for the user's key, because it is
idempotent on that id.

## What the interface says

`/capabilities` is **probed** from the service's `/v1/health`, which reports its
role. `SIGNER_KIND=real` is true of a single-key service and a coordinator
alike, so configuration cannot answer it — and the dashboard told users their
custody was a single key while it was running 3-of-5. An unreachable service
leaves the weaker claim standing, which is the right direction to fail.

| `signing.mode`   | Shown as                                  |
| ---------------- | ----------------------------------------- |
| `mock`           | "Signing is not real yet"                 |
| `single-key-mpc` | "Signing is real, and it is a single key" |
| `threshold-mpc`  | "Signing is 3-of-5 threshold"             |

## Stopping

```bash
./scripts/mpc-cluster.sh stop
```

Participant stores under `/tmp/atlas-mpc-cluster` are wiped on the next start:
each participant seals its share under a KEK generated per run, so a store from
a previous run cannot be decrypted anyway. **Every key is discarded on restart.**
Anything funded to the old treasury or to a user's old address is unreachable —
which is the correct behaviour for a rehearsal and the reason not to fund one.
