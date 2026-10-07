# Runbook: a settlement worker has halted

**Applies to:** Phase S4 · **Audience:** whoever is on call

**Symptom:** a `settlement.halted` security event and an `error` log naming a
market and an event key; `settlement_halts_total{market}` increased;
`settlement_offset_lag_sequences{market}` is climbing while the API is up. Orders
in that market still match, and their fills no longer move money.

## What this means

Settlement met an engine event it could not apply and **stopped at it**
([ADR-0034 §8](../adr/0034-settlement-pipeline.md)). The offset for that market
did not move past the event. Nothing was skipped and nothing was parked.

That is the designed failure. Skipping would settle every later fill for the same
users against a ledger missing one, and the error would compound without any
balance ever failing to add up.

Only that market is stopped. Every other market has its own stream, offset and
worker.

The log line carries the market, the key as `seq:idx`, and a reason code. It
carries no user, order, amount or price, on purpose.

## First: do not

- **Do not move the offset to get past it.** That is the skip the worker refused
  to make.
- Do not delete the Redis stream or the consumer group. Position is in
  PostgreSQL (`engine_offsets`), not in Redis; deleting the stream changes
  nothing about the halt and costs a recovery through re-emission.
- Do not restart the API in a loop. A restart retries the same key and halts
  again for the same reason, which is correct and tells you nothing new.
- Do not edit `fills`, `fee_tier_snapshots` or the ledger. They are append-only,
  and the database will refuse.
- Do not re-place or cancel users' orders by hand to "clear" the book.

## Establish the state

```sql
-- Where each market's settlement stands. The halted key is the one AFTER this.
SELECT market, seq, idx, updated_at FROM engine_offsets WHERE consumer = 'settlement';
```

```bash
curl -s http://<engine>/v1/health                                  # last_seq
curl -s "http://<engine>/v1/events?after=<halted seq - 1>&limit=1" # the whole halted sequence
```

`/v1/events` cuts pages only at sequence boundaries, so `limit=1` returns every
event of the halted sequence. The event at position `idx` is the one that halted.

## Read the reason

| Reason                                                                                                                   | What it means                                                                                                   | Usual cause                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `unknown_order`                                                                                                          | The event names an order that is not in `orders`.                                                               | The journal carries S2 load-client traffic, or settlement was started on the wrong engine or stream.                 |
| `order_market_mismatch`, `hold_asset_mismatch`, `side_mismatch`                                                          | The order exists and does not belong to this fill.                                                              | A market's stream or engine URL is configured against another market's.                                              |
| `over_consumption`                                                                                                       | The fill would consume more than the order's outstanding hold.                                                  | A bug in hold computation or fee arithmetic, or `FEE_TIERS` and `WORST_CASE_TAKER_BPS` have diverged.                |
| `overfill`, `fill_for_terminal_order`, `remaining_mismatch`, `accepted_unfilled`, `rejected_after_fill`                  | The engine's account of the order and the database's disagree about how much is filled.                         | An event was applied out of order, or the offset was moved by hand, or the journal was replaced under a live market. |
| `<status>_from_<status>` (for example `expired_from_filled`)                                                             | The event cannot legally follow the order's current status.                                                     | As above. Also a gateway path that finalised an order it could not prove was unfilled.                               |
| `holding_order_holds_nothing`, `terminal_order_holds_funds`, `outstanding_negative`, `released_as_unfilled_but_consumed` | After applying the event, the order's status and the ledger disagree.                                           | A settlement bug. Nothing was committed.                                                                             |
| `undecodable_event`, `malformed_stream_entry`, `key_mismatch`                                                            | The event, or its stream entry, is not a shape settlement knows.                                                | The engine was upgraded ahead of the API, or something other than the engine wrote to the stream.                    |
| `reemission_gap`, `unrecoverable_gap`                                                                                    | A sequence is missing from the stream **and** from `GET /v1/events`.                                            | The journal is damaged or was truncated. See [corrupt-matching-journal](./corrupt-matching-journal.md).              |
| `constraint_23514`, `constraint_23505`, `constraint_23503`                                                               | The database refused the commit: a negative trading balance, an unbalanced posting, a duplicate, a missing row. | A settlement bug that an application check should have caught first. Treat it as the most serious row in this table. |
| `order_contended`                                                                                                        | A guarded transition lost to another writer four times running.                                                 | Almost always transient. A restart retries it.                                                                       |

## Resolve it

Recovery always **resumes from the same key**. There are three ways to get there.

**1. The cause is outside the event — fix the cause, restart the API.**
Wrong stream, wrong engine URL, an API older than the engine, `order_contended`.
On boot the worker reads its offset and retries the halted key.

**2. The cause is a bug — fix the bug, deploy, restart.**
The halted event is still there and is applied by the fixed code. Until then the
market's fills wait; their holds stay held, so no user can spend what a waiting
fill will consume.

**3. The event can never be settled.**
An S2 load-client fill has no order and no hold; no code change makes it
settleable. [ADR-0034 §5](../adr/0034-settlement-pipeline.md) says such a journal
is reset **before** settlement is enabled on the market, so reaching this means
that step was missed.

There is deliberately no command that skips an event. If two people agree an
event must be passed over, that is a decision they record, not a default:

1. Halt the market in the engine, so the gap does not grow.
2. Write down the halted key, the full event from `/v1/events`, and why it cannot
   be settled.
3. If the event moved value that the ledger must reflect, post a reviewed
   correcting transaction for it first.
4. As the schema owner, and with the API stopped, set that market's row in
   `engine_offsets` to the halted key. That states "this event is accounted for".
5. Start the API, confirm the offset advances, and run reconciliation. Check 3
   ([ADR-0035](../adr/0035-clearing-tier-reconciliation.md)) is the one that
   shows whether a hold was left behind.

## Confirm it is over

- `settlement_offset_lag_sequences{market}` returns to zero and stays there.
- `settlement_events_total{market,outcome="applied"}` is increasing.
- The next reconciliation run reports `book` and `order_locks` clean for the
  market, and no negative trading balance.

## Afterwards

Record: the market, the key, the reason, how long settlement was stopped, how
many sequences it fell behind, and which of the three resolutions was used. If it
was the third, record who agreed to it.

A halt with a `constraint_*` reason means an application check missed something
the database caught. Find the missing check before closing the incident.
