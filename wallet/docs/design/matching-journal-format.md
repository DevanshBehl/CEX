# The matching engine's journal, snapshots and recovery

Reference for `services/matching`. The decisions are in
[ADR-0028](../adr/0028-engine-durability-and-replay.md); this is the format and
the procedure.

## Why there is a journal at all

The book lives in memory. That is what makes it fast and what makes it
deterministic, and it is also what makes a restart a total loss unless something
on disk says what happened.

Redis is not that something. `infra/docker-compose.yml` runs it with
`--appendonly yes`, justified in its own comment by the observation that losing
an in-flight WebAuthn challenge is harmless. Execution reports are not harmless,
and the default `appendfsync everysec` loses up to a second of them on a hard
kill.

So: the journal is the source of truth for sequencing, and Redis — from S2 — is
transport.

## Write ordering

```
1. assign a monotonic u64 sequence
2. append the command record to the journal
3. fsync
4. match in memory
5. emit events
```

The fsync is at step 3, never at step 5, and never batched across commands. A
fill that exists in memory but not on disk is a fill that can be lost and cannot
be replayed.

`Runtime::submit` is the only place this ordering is enforced, which is why it
is the only way to submit a command.

## Journal layout

```
file header   "ATLASMCH" (8 bytes) || format_version u16 little-endian
record        length u32 LE || crc32 u32 LE || payload
payload       bincode-encoded SequencedCommand { seq, timestamp_ms, command }
```

The CRC covers the payload only. Length and CRC are read first, so a truncated
record is detected without decoding it. A record is capped at 8 MiB so a corrupt
length field cannot request an allocation the size of the address space.

**The timestamp is in the record** because the engine does not own a clock. It
arrives on the command, is journaled with it, and is therefore reproduced
exactly by a replay. An engine that read the wall clock when emitting a fill
would produce a different event stream every replay, and every property in the
crate would be untestable.

## Snapshots

Written every `MATCHING_SNAPSHOT_EVERY_N` sequences.

```
"ATLASSNP" (8 bytes) || crc32 u32 LE || bincode-encoded Snapshot { last_seq, book }
```

Written to `book.snapshot.tmp` and **renamed** into place. A half-written
snapshot that recovery might read is worse than no snapshot, and the rename is
the only step here that is atomic.

A snapshot that fails its CRC is **ignored**, never repaired. Recovery falls
back to replaying from the beginning, which is always correct.

## Recovery

1. Load the newest snapshot that passes its CRC. If none does, start empty.
2. Replay journal records after that snapshot's sequence.
3. Resume assigning sequences from the last journaled sequence plus one.

Sequences never restart at zero. Restarting would make the settlement worker's
offset meaningless, and a duplicate sequence is a duplicate `reference_id` on a
settlement — which the unique index would reject, turning a recoverable restart
into a stuck queue.

## Two kinds of damage, two different answers

| Damage                                                                              | Answer                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Torn tail** — the last record short or failing its CRC, nothing readable after it | Truncate to the last valid record, log the sequence, continue |
| **Mid-journal corruption** — a record fails its CRC with intact records after it    | **Refuse to start.** Never skip it                            |

A torn tail is the expected result of a power loss during an append, and there is
one correct interpretation of it: the command was never durable, so it never
happened.

Corruption in the middle is not that. Skipping the record produces a book that
never existed, and every event after it is wrong in a way no test will catch,
because the engine will be internally consistent about a history that did not
happen. A refusal to start is recoverable by a human with the
[runbook](../runbooks/corrupt-matching-journal.md). A silently wrong book is not
recoverable at all, because nobody will know to look.

The two cases are distinguished by scanning forward from the damaged offset for
any record that decodes and passes its CRC. Finding one means the damage is not
at the tail.

## A note on cancellation and tombstones

A cancel is O(1). It removes the order from the index and decrements its price
level's live total, without scanning the level's queue to splice the id out. The
id remains in the queue as a **tombstone** until matching prunes it from the
front, or until the level's live quantity reaches zero and the whole level is
dropped.

Two consequences worth knowing when reading a snapshot by hand:

- A level's queue length is not its order count. `total_qty` counts live orders
  only, and the book's invariant check recomputes over live entries.
- A level present in a ladder always has live quantity, which is what keeps
  `best_price` honest — it can never name a price nothing can trade at.

The scanning alternative measured 1.95 microseconds to cancel from a
thousand-deep level, against 186 nanoseconds for this one, and `cargo bench`
carries both shapes (`cancel_depth_*` walks many levels, `cancel_from_level_of_*`
walks one deep level).

## Verifying a data directory

```bash
cd services/matching
MATCHING_DATA_DIR=... MATCHING_MARKET_ID=devnet:SOL-USDC \
MATCHING_TICK_SIZE=1000000 MATCHING_LOT_SIZE=1000000 \
MATCHING_MIN_NOTIONAL=1000000 MATCHING_COLLAR_BPS=1000 \
  cargo run --release -- verify
```

`verify` recovers normally, replays the journal from scratch independently, and
asserts the two produce the same book — the property that makes a snapshot only
ever an optimisation. `stats` prints journal and snapshot positions; `replay`
rebuilds from the journal alone.
