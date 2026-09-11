# Runbook: reconciliation reports a residual

**Applies to:** Phase 2 · **Audience:** whoever is on call

```bash
pnpm --filter @wallet/api reconcile
```

Exit code 0 means reconciled, 1 means drift, 2 means the run itself failed.

## Read the sign first

`residual = observed on-chain − what the ledger says we hold`. The sign tells
you which of two very different situations you are in.

### Positive residual — the chain holds MORE than the books

**Usually benign.** Money has landed and has not been credited yet. Expected
causes, in order of likelihood:

1. Deposits detected but not yet finalized (ADR-0006). Re-run in a minute.
2. A transfer to an address the system owns but is not watching — check for
   addresses with `status = 'retired'`.
3. The indexer is stopped or failing. Check `indexer_cursors.last_polled_at`
   and the logs for `indexer.poll_failed`.

It becomes a real problem when it **persists across cycles** while the indexer
is healthy. That means transfers are landing that the pipeline never turns into
deposits.

### Negative residual — the books claim MORE than the chain holds

**Escalate.** Phase 2 cannot send funds: there is no signing path and no
withdrawal. So there is no legitimate way for the chain balance to fall below
what the ledger records.

Possible causes, all serious:

- A credit was posted for a transfer that was later reversed on a fork — which
  should be impossible under ADR-0006 and would mean the commitment policy is
  not being applied somewhere.
- Funds moved from a deposit address by something outside this system, which
  means a key is compromised.
- A ledger write that did not correspond to a real transfer.

Do this in order:

1. **Stop the indexer** (`INDEXER_ENABLED=false`, restart) so nothing further is
   credited while you investigate.
2. Identify which addresses disagree:
   ```sql
   SELECT a.address FROM addresses a WHERE a.chain = 'solana' AND a.status = 'active';
   ```
   and compare each against `solana balance <ADDRESS> --url <RPC_URL>`.
3. For any address whose chain balance is lower than expected, pull its
   transaction history from an explorer and look for an **outgoing** transfer.
   An outgoing transfer from a deposit address in Phase 2 means a compromised
   key.
4. Preserve evidence. The ledger is append-only, so nothing can be destroyed by
   investigating — but do not post adjustments until the cause is known.

## "Addresses could not be read"

When `addressesChecked` is less than the total, the observed figure is a lower
bound and the residual is not meaningful. This is an RPC problem, not an
accounting one. Fix the RPC and re-run.

## What reconciliation does not check

It compares the ledger's `chain_assets` against observed balances. It does not
verify that the split between `user_available` and `house_rent` is right, and it
cannot detect a deposit credited to the **wrong user** — both totals would still
match. Attribution correctness rests on the uniqueness of deposit addresses
(ADR-0004) and is covered by tests, not by this report.
