# Runbook: a user says their deposit is missing

**Applies to:** Phase 2 · **Audience:** whoever is on call

## Before anything else

Get the **transaction signature** from the user, not the amount and not the
time. The signature is the only identifier that ties their claim to something
checkable; everything else is a search.

## The five places a deposit can be

Work down the list. Each step tells you whether to stop or continue.

### 1. It never landed on-chain

```bash
solana confirm -v <SIGNATURE> --url <RPC_URL>
```

If this fails, or reports an error, the transfer did not succeed and there is
nothing to credit. The user's funds never left, or were returned. Stop.

### 2. It landed, but at the wrong address

```sql
SELECT a.address, a.wallet_id, w.user_id
FROM addresses a JOIN wallets w ON w.id = a.wallet_id
WHERE a.address = '<DESTINATION FROM THE EXPLORER>';
```

Empty means the funds went to an address this system does not own. Nothing can
be credited, and nothing can be recovered by us — this is the case that hurts,
and it is why the deposit page states the asset and network so emphatically.

### 3. It landed but has not reached finality

Only `finalized` transfers are credited (ADR-0006), which takes roughly 13
seconds. If the user is asking within a minute of sending, this is the answer:
it is in progress and will credit itself. Confirm with:

```sql
SELECT status, created_at, credited_at FROM deposits WHERE tx_signature = '<SIG>';
```

`confirming` means seen and waiting. Stop.

### 4. It landed, is final, and the indexer has not seen it

```sql
SELECT a.address, c.last_signature, c.last_polled_at
FROM addresses a LEFT JOIN indexer_cursors c ON c.address_id = a.id
WHERE a.address = '<ADDRESS>';
```

`last_polled_at` more than a few poll intervals old means the indexer is not
running or is failing on this address. Check the logs for
`indexer.poll_failed` with this `targetId`.

The cursor is only advanced after a batch commits (rules 146–147), so a stuck
indexer **delays** deposits, it does not lose them. Restarting the API resumes
from the last committed position and re-reads anything in between; re-reading is
a no-op because of the deposit uniqueness constraint.

### 5. It was credited and the user is looking in the wrong place

```sql
SELECT d.id, d.amount, d.rent_reserved, d.status, d.credited_at
FROM deposits d WHERE d.tx_signature = '<SIG>';
```

If `status = 'credited'`, the money is in the ledger. Two common confusions:

- **The credited amount is smaller than what they sent.** The first deposit to
  an address holds back the network's rent-exempt minimum — real, ours, and not
  withdrawable (rules 157–158). `rent_reserved` is that amount, and the Activity
  page shows it explicitly. Only the first deposit to an address pays it.
- **They are looking at a different account.** Confirm `user_id` matches.

## If it is genuinely lost

Do **not** insert a ledger entry by hand. It will be refused: the ledger is
append-only and the balance constraint is enforced at commit, so a manual
`INSERT` that does not balance will fail, and one that does balance bypasses
every check the pipeline performs.

The correct action is a reversing **adjustment transaction** posted through the
ledger repository, with the reason recorded. Phase 2 has no operator tooling for
this, which is itself the finding: if you need it, it belongs in Phase 4's
operational controls.

## Escalate immediately if

`reconciliation` reports the ledger claiming **more** than the chain holds.
Phase 2 cannot send funds, so that residual means a credit was posted for money
that never arrived. See [reconciliation-drift.md](./reconciliation-drift.md).
