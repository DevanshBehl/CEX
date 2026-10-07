# Runbook: reconciliation reports a residual

**Applies to:** Phase 2 (the vault tier) · Phase S4 (the clearing tier, [below](#the-clearing-tier-phase-s4)) · **Audience:** whoever is on call

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

**Since Phase 3, this has a legitimate transient cause.** A withdrawal that has
been broadcast but has not yet settled has left the chain and has not yet been
debited from the ledger, so the chain balance is legitimately lower for a few
seconds.

Check that first:

```sql
SELECT id, amount, status, tx_signature FROM withdrawals
WHERE status IN ('BROADCAST', 'CONFIRMED');
```

If the shortfall is accounted for by those amounts, it is not drift. Re-run
after they settle.

**If it is not, escalate.** With no withdrawals in flight there is no
legitimate way for the chain balance to fall below what the ledger records.

Possible causes, all serious:

- A credit was posted for a transfer that was later reversed on a fork — which
  should be impossible under ADR-0006 and would mean the commitment policy is
  not being applied somewhere.
- Funds moved from a deposit address by something outside this system, which
  means a key is compromised.
- A ledger write that did not correspond to a real transfer.
- A withdrawal settled that never actually landed — which would mean settlement
  happened below finality, contradicting ADR-0006.

Do this in order:

1. **Stop the indexer and the withdrawal workers**
   (`INDEXER_ENABLED=false`, `WITHDRAWAL_WORKERS_ENABLED=false`, restart) so
   nothing further is credited or sent while you investigate.
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

Since Phase 3 it also does not observe nonce accounts or the treasury address,
so their balances are not part of the comparison. Extending it to cover every
platform-owned address is a Phase 4 task, alongside scheduling and alerting.

---

## The clearing tier (Phase S4)

With trading enabled, the same command and the same scheduled worker also run
the three checks of [ADR-0035](../adr/0035-clearing-tier-reconciliation.md) and
one alarm. An alert names the check and its subject — an asset or a market — and
nothing else. The numbers are in the report:

```bash
pnpm --filter @wallet/api reconcile      # prints a "Clearing tier" section
```

`reconciliation_check_result{check,subject}` holds each check's last reading:
`1` clean, `0` drift, `-1` inconclusive. An inconclusive reading — an unreadable
chain, a book read ahead of settlement — neither extends nor resets a streak.

No one check proves solvency. Each section below says what its check cannot see.

### `reconciliation.clearing_drift_persisted`, check `reserve`

The clearing address on-chain disagrees with the ledger's `clearing_assets` for
that asset, for `RECONCILIATION_ALERT_AFTER_CYCLES` readings in a row.

`residual = observed on-chain − ledger clearing_assets`. It should equal
`TRADING_CLEARING_RESERVE` for the native asset and zero for every other.

- **Positive, and it clears.** An allocation has landed on-chain and has not
  been credited yet. That is why this alerts on a streak.
- **Positive, and it persists.** Coins reached the clearing address that no
  allocation accounts for, or `TRADING_CLEARING_RESERVE` is set lower than what
  the house actually parks there.
- **Negative, with a deallocation in flight.** Broadcast and not yet settled,
  exactly as for a withdrawal above. Re-run after it settles.
- **Negative, with nothing in flight.** Escalate. The clearing key has signed
  something the ledger does not know about. Halt every market, stop the
  withdrawal workers, and treat it as a key compromise until shown otherwise.

This is the only check that compares the books with something outside them. It
cannot tell you **which** user is short.

### `reconciliation.clearing_drift_persisted`, check `equation`

`clearing_assets − Σ(user_trading_available + user_order_locked +
user_trading_locked)` is not equal to `house_trading_fees` for that asset.

This compares the ledger with itself, so the chain and timing are not involved:
**a posting is wrong.** The report's `unexplained` is by how much.

1. Stop settlement for every market in that quote asset
   (`TRADING_SETTLEMENT_ENABLED=false`, restart). Matching may continue; fills
   wait, with their holds held.
2. Find when it began. Every `trade_settle` has its `fills` row, with the rate
   and amount it charged:
   ```sql
   SELECT f.fill_id, f.notional, f.taker_fee, f.maker_fee, t.created_at
   FROM fills f JOIN ledger_transactions t ON t.id = f.ledger_transaction_id
   WHERE f.quote_asset = '<asset>' ORDER BY t.created_at DESC LIMIT 50;
   ```
3. Do not post an adjustment until the posting function that produced the
   difference is identified. The ledger is append-only; the evidence will keep.

It cannot see a fill that was never settled, or a fee charged to the wrong
party: neither changes the totals.

### `reconciliation.book_mismatch_persisted`, check `book`

For that market, resting orders in the database and price levels in the engine's
book disagree, compared at the same sequence. The report says how:

| Detail                 | Meaning                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `levelsOnlyInEngine`   | Something rests in the engine that no order in the database holds for. |
| `levelsOnlyInDatabase` | The database holds funds for an order the engine does not have.        |
| `levelsDiffering`      | Both have the level, with different quantities.                        |

Read the two sides yourself before acting:

```bash
curl -s http://<engine>/v1/book
```

```sql
SELECT side, price, SUM(qty - filled_qty) AS resting
FROM orders
WHERE market = '<market id>' AND kind = 'limit'
  AND status IN ('OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL')
GROUP BY side, price ORDER BY side, price;
```

- **Only in the engine.** Orders the gateway did not place: load-client traffic,
  or a second gateway pointed at this engine. Nothing is held for them, so a fill
  against one halts settlement ([settlement-halted](./settlement-halted.md)).
  Halt the market before that happens.
- **Only in the database.** A user's funds are locked for an order that cannot
  fill. Usually an engine restored from an older snapshot or a reset journal
  ([corrupt-matching-journal](./corrupt-matching-journal.md)). The order needs
  cancelling through the gateway so its hold is released by the normal path.
- **Persistently `inconclusive`** is not this alert, and is not healthy either:
  settlement is not reaching the book's sequence. Look at
  `settlement_offset_lag_sequences`.

It cannot see an order that rests correctly and settled an earlier fill at the
wrong price.

### `reconciliation.book_mismatch_persisted`, check `order_locks`

For some user and asset, `user_order_locked` is not the sum of the outstanding
holds of that user's holding orders. The subject is the cluster; the report gives
the number of mismatched accounts, never who.

This is the check that finds a hold with no order, which the book comparison
cannot. Find them:

```sql
SELECT a.owner_id, a.asset,
       SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END) AS locked
FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id
WHERE a.type = 'user_order_locked'
GROUP BY a.owner_id, a.asset
HAVING SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END) <> 0;
```

and compare each against that user's orders in `PENDING_ENGINE`, `OPEN`,
`PARTIALLY_FILLED` and `PENDING_CANCEL`. An order's outstanding hold is
`hold_amount − Σ consumed by its fills − Σ released`; it is never a column.

A terminal order that still holds funds, or a holding order that holds none, is a
settlement or gateway bug. Settlement asserts exactly this after every event it
applies, so reaching it here means a path that is not settlement wrote the hold.

### `reconciliation.negative_trading_balance`

**Alerts on the first reading. Do not wait for a second.**

A user's `user_trading_available`, `user_order_locked` or `user_trading_locked`
balance is below zero. Nothing legitimate produces that, and since S4 a deferred
constraint trigger refuses to commit it
([ADR-0034 §7](../adr/0034-settlement-pipeline.md)). So this is not drift. The
trigger was dropped, disabled, or bypassed by a role that should not be writing.

1. Halt every market and set `TRADING_SETTLEMENT_ENABLED=false`.
2. Confirm the trigger exists and is enabled:
   ```sql
   SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgrelid = 'ledger_entries'::regclass AND NOT tgisinternal;
   ```
3. Find the entries that took each account below zero, and which database role
   wrote them. `wallet_app` cannot disable a trigger.
4. Treat it as a security incident until the writer is identified.

A database that predates S4 can hold negative balances written before the
trigger existed. Those are found the first time this check runs, not later.

### What these checks do not do

They observe; they do not gate. A drifting check does not stop trading, and a
person decides whether to. They are also not published — proof-of-reserves is
Phase S6.
