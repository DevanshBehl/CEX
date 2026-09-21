# Runbook: a corrupt matching journal

**Symptom:** `services/matching` refuses to start, logging
`journal corruption at sequence N: a record at offset X failed its checksum with
intact records after it. Refusing to start.`

## What this means

The engine found a journal record that fails its checksum, with intact records
after it. That is **not** a torn tail — a torn tail is the last record only, and
is truncated automatically without an operator ever seeing it.

This is corruption in the middle of the history. The engine refuses to start
rather than skipping the record, because skipping produces a book that never
existed and every event after it would be wrong in a way no test catches: the
engine would be internally consistent about a history that did not happen
([ADR-0028](../adr/0028-engine-durability-and-replay.md)).

**The refusal is the system working.** Do not try to make it start.

## First: do not

- Do not delete the journal to "get it running again". The journal is the only
  record of what was matched, and S4's settlement may not have consumed all of
  it yet.
- Do not hand-edit the file to fix a checksum.
- Do not start a second engine on a copy of the directory while the first is
  being investigated — two engines assigning sequences from the same history
  produce duplicate sequence numbers, and a duplicate sequence is a duplicate
  settlement `reference_id`.

## Establish the damage

```bash
cd services/matching
export MATCHING_DATA_DIR=/path/to/data
# plus MATCHING_MARKET_ID, TICK_SIZE, LOT_SIZE, MIN_NOTIONAL, COLLAR_BPS
cargo run --release -- stats
```

`stats` reports how many records read cleanly and the last sequence reached. The
error itself names the offset and the sequence the reader had reached.

Take a copy before doing anything else:

```bash
cp -a "$MATCHING_DATA_DIR" "$MATCHING_DATA_DIR.incident-$(date +%s)"
```

## Decide how much history is still needed

| Question                                         | Where to look                            |
| ------------------------------------------------ | ---------------------------------------- |
| Which sequences has settlement already consumed? | `engine_offsets` in PostgreSQL (from S4) |
| Is the damaged sequence at or below that offset? | compare with the sequence in the error   |
| Are there unsettled fills after the damage?      | the Redis stream, if it still holds them |

**If the damage is entirely below the settlement offset**, everything after it
has already been settled into the ledger, and the journal's remaining job is
replay for a cold start. A snapshot taken after the damaged sequence can carry
the book forward without the damaged record being read at all — confirm with
`stats` that a snapshot exists at a later sequence, and if so recovery can be
resumed from it by removing journal records up to that point. Do this by
truncating the _front_ of the journal only after copying it.

**If the damage is above the settlement offset**, fills may exist that the
ledger has never seen. Do not start the engine. Escalate: the reconciliation
this needs is between the Redis stream, the ledger's `user_order_locked`
balances and the surviving journal, and it is not a single command.

## Restoring service

The market stays halted until the book is known to be right.

1. Confirm the settlement offset and the last trustworthy sequence.
2. Recover the book from the newest snapshot at or before that sequence.
3. Run `verify`, which replays independently and asserts snapshot-plus-tail
   equals a full replay.
4. Bring the market up in `post_only` first, so liquidity can be rebuilt
   without a trade printing against a book nobody has checked.
5. Only then set `open`.

## Afterwards

Record, in the incident notes:

- The offset and sequence of the damage, and the settlement offset at the time.
- Whether any fill was found that the ledger had not settled.
- What the storage was doing — this is a disk or filesystem fault until proven
  otherwise, and the engine's checksum is what caught it rather than caused it.
- Whether the snapshot cadence was frequent enough to be useful. If recovery
  needed a replay of hours, `MATCHING_SNAPSHOT_EVERY_N` is too high.
