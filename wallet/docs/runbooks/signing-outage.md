# Runbook: signing outage

**Symptom:** withdrawals accumulate in `FUNDS_LOCKED` or `SIGNING`. Logs show
`withdrawal.sign_failed`, or `/health/ready` reports `mpc: down`.

## First: nobody has lost money

Locked funds are locked, not spent. A signing outage is an availability
incident. The pressure to "just get it working" is what turns it into a
custody incident — do not disable the approval key check to unblock it.

## 1. Establish what is down

```bash
curl -s http://127.0.0.1:4000/health/ready | jq
curl -s http://127.0.0.1:7070/v1/health
```

| Reading                        | Meaning                                     |
| ------------------------------ | ------------------------------------------- |
| `mpc: down`, MPC health fails  | the service is not running or not reachable |
| `mpc: up`, signing still fails | authentication, authorisation, or key issue |
| `solana: down`                 | not a signing outage; see below             |

If `solana` is down, signing is fine and broadcast is not: withdrawals will sit
in `SIGNED`. Different problem, same calm.

## 2. If the service is not running

```bash
# What it said on the way out
tail -50 <log path>/mpc.log
```

Common causes, in the order they actually happen:

- **Config refused at boot.** The service names the variable and never prints
  its value. Fix the variable.
- **`MPC_KEK` changed.** The stored key cannot be decrypted. **Do not generate a
  new key** — that abandons the treasury. Restore the correct KEK.
- **TLS material missing or expired** when `MPC_TLS_CERT`/`MPC_TLS_KEY` are set.
- **The SQLite file is unreadable or on a full disk.**

Restart:

```bash
pnpm build:rust && ./services/mpc/target/release/wallet-mpc
```

## 3. If the service is running but refuses to sign

Read the rejection reason. It is deliberately a short constant, never a value.

| Reason                             | Cause                                                     |
| ---------------------------------- | --------------------------------------------------------- |
| `caller_signature_rejected`        | `MPC_CLIENT_PRIVATE_KEY` ≠ `MPC_CALLER_PUBLIC_KEY`        |
| `authorization_unsigned`           | service has an approval key; API has none configured      |
| `authorization_signature_rejected` | `MPC_APPROVAL_PRIVATE_KEY` ≠ `MPC_APPROVAL_PUBLIC_KEY`    |
| `tier_authority_missing`           | the proof lacks an authority the tier requires (ADR-0018) |
| `request_id_reused`                | same id, different bytes — see below                      |
| `timestamp_outside_window`         | clock skew between API and service                        |

### `request_id_reused` is not a bug to work around

It means something asked for a signature under an id that already signed
different bytes. That is the duplicate-spend guard doing its job. Find out why
the bytes changed — usually a withdrawal that expired and rebuilt on a fresh
nonce, which should have produced a new `requestId` of the form
`withdrawal:{id}:{nonce}`.

## 4. Let the backlog drain

The workers reclaim by state. Once signing works:

```bash
# Watch the queue drain rather than forcing anything
watch -n5 'psql ... -c "select status, count(*) from withdrawals group by status"'
```

Withdrawals that exhausted their budget during the outage are in `FAILED` with
funds **released back to the user** (ADR-0012). They are not resurrected — the
user submits a new request. Check the dead-letter queue for what gave up:

```
GET /operator/dead-letters?queue=withdrawal_sign
```

## 5. What NOT to do

- **Do not set `SIGNER_KIND=mock`.** It produces signatures that verify against
  nothing. Config refuses this in production; do not defeat it.
- **Do not clear `MPC_APPROVAL_PUBLIC_KEY`** to get past an authorisation
  failure. That turns the service into one that signs whatever it is asked.
- **Do not delete rows from `withdrawal_transitions`.** It is append-only, and
  the attempt will be refused.
- **Do not regenerate the signing key** unless you intend to abandon the
  treasury address and move funds to a new one.

## Afterwards

Record the outage duration, how many withdrawals failed their budget, and
whether the budgets in ADR-0012 were the right size for this failure.
