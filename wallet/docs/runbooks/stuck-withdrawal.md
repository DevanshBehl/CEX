# Runbook: a withdrawal is stuck

**Applies to:** Phase 3 · **Audience:** whoever is on call

## First, read the history

A withdrawal's current state is one column; how it got there is the whole story.

```sql
SELECT status, sign_attempts, broadcast_attempts, expiry_attempts,
       tx_signature, nonce_account_id, failure_reason, created_at
FROM withdrawals WHERE id = '<ID>';

SELECT from_status, to_status, reason, actor_user_id, created_at
FROM withdrawal_transitions WHERE withdrawal_id = '<ID>' ORDER BY created_at;
```

`withdrawal_transitions` is append-only, so it has not been edited and cannot
be. Whatever it says is what happened.

## By state

### `MANUAL_REVIEW` — waiting for a person

Working as designed. Someone has to decide. The reason codes say why it was
referred:

```sql
SELECT verdict, codes, evaluated_rules FROM risk_decisions WHERE withdrawal_id = '<ID>';
```

`NEW_DESTINATION` and `MANUAL_REVIEW_THRESHOLD` are the common ones and are
routine. Resolve it in the operator queue, with a note.

### `FUNDS_LOCKED` — not picked up by the signer

The funds are reserved and the withdrawal is queued. Check the signer is
running, then check the nonce pool:

```sql
SELECT status, count(*) FROM nonce_accounts GROUP BY status;
```

`available = 0` means the pool is dry: every account is leased to an in-flight
withdrawal. This is an operational condition, not data loss — withdrawals wait.
Provision more accounts, or find leases that should have been released:

```sql
SELECT n.id, n.leased_by, w.status
FROM nonce_accounts n LEFT JOIN withdrawals w ON w.id = n.leased_by
WHERE n.status = 'leased';
```

A lease held by a withdrawal in a terminal state is a bug; release it.

### `SIGN_FAILED` / `BROADCAST_FAILED` / `EXPIRED` — retrying

Each retries on its own budget (ADR-0012). Check the attempt count against the
budget in config. `failure_reason` on the withdrawal, and `reason` on the
transition, say what went wrong.

These states are **not** stuck; they are between attempts. They become stuck
only if the worker is not running.

### `BROADCAST` — submitted, not yet confirmed

Expected for roughly 13 seconds. Beyond a minute, the question is whether the
transaction landed — and with durable nonces that has an answer.

```sql
SELECT w.nonce_value, n.address, n.current_nonce
FROM withdrawals w JOIN nonce_accounts n ON n.id = w.nonce_account_id
WHERE w.id = '<ID>';
```

```bash
solana nonce-account <ADDRESS> --url <RPC_URL>
```

- **Nonce still equals `nonce_value`** → the transaction has not landed and the
  signed bytes are still valid. The confirmation worker re-broadcasts them
  automatically. **Do not re-sign.**
- **Nonce has advanced** → either our transaction landed (check the signature)
  or a competing one won. Either way the worker moves it to `EXPIRED` and
  retries on a fresh nonce, which is safe _because_ the nonce advanced.

### `FAILED` — gave up, funds returned

A retry budget was exhausted. The lock has been released, so the user has their
money back. Confirm:

```sql
SELECT kind, created_at FROM ledger_transactions
WHERE reference_id = '<ID>' ORDER BY created_at;
```

Expect `withdrawal_lock` followed by `withdrawal_release`. If the release is
missing, that is the serious case — see below.

### `SETTLED` — done

The money left. `settle_ledger_transaction_id` points at the entries.

## The one thing never to do

**Never re-sign a withdrawal manually.** Not from psql, not from a script.

A second signature over different bytes can land alongside the first, and the
account is debited twice. The only safe response to "did it land?" is to read
the nonce — which the confirmation worker already does, automatically, every
cycle.

Re-broadcasting the _existing_ bytes is always safe, and the worker does that
too.

## If a lock is missing its release

A withdrawal in `FAILED` or `REJECTED` with a `withdrawal_lock` and no
`withdrawal_release` means a user's funds are reserved against a withdrawal
that will never happen.

Do not insert entries by hand: the ledger is append-only and the balance
constraint is enforced at commit, so a manual `INSERT` that does not balance
will be refused, and one that does balance bypasses every check the pipeline
performs.

The correct action is a reversing adjustment posted through the ledger
repository. Phase 3 has no operator tooling for that, which is itself the
finding.
