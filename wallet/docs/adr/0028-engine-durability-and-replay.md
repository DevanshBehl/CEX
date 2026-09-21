# ADR-0028: Engine durability and replay

**Status:** proposed · **Date:** 2026-09-21 · **Phase:** S1
**Required by:** ADR-0025 · **Relates to:** ADR-0012 (retry and expiry budgets)

## Context

The matching engine holds the order book in memory. That is what makes it fast
and what makes it deterministic, and it is also what makes a process restart a
total loss unless something on disk says what happened.

Redis is not that something. `infra/docker-compose.yml` runs it with
`--appendonly yes`, and the comment there justifies the setting on the grounds
that losing an in-flight WebAuthn challenge is harmless and losing rate-limit
state briefly is not. Execution reports are neither, and the default
`appendfsync everysec` loses up to a second of them on a hard kill.

Separately, [ADR-0025](./0025-clob-and-two-tier-clearing.md) makes settlement a
consumer that tracks its position by engine sequence. For that to be recoverable,
the engine must be able to re-emit a range of sequences it has already produced —
which is only possible if the inputs that produced them are on disk.

## Decision

**Sequence, append, fsync, then match. The journal is the source of truth; Redis
is transport. A replay is permitted to differ in nothing.**

### Ordering

```
1. assign a monotonic u64 sequence
2. append the command record to the journal
3. fsync
4. match in memory
5. emit events
```

The fsync is at step 3 and never at step 5, and it is never batched across
commands. A fill that exists in memory but not on disk is a fill that can be lost
and cannot be replayed, and batching the sync is exactly the optimisation that
creates a window of them.

### Record format

```
file header   magic "ATLASMCH" (8 bytes) || format_version u16 (little-endian)
record        length u32 || crc32 u32 || payload
payload       bincode-encoded JournalRecord { seq, timestamp, command }
```

The timestamp is in the record because the engine does not own a clock: it
arrives on the command, is journaled with it, and is therefore reproduced exactly
by a replay. An engine that read `SystemTime::now()` when emitting a fill would
produce a different event stream on every replay, and every property in this
phase would be untestable.

The CRC covers the payload only. Length and CRC are read first, so a truncated
record is detected without decoding it.

### Snapshots

Every `SNAPSHOT_EVERY_N` sequences — default 10,000, configurable — the engine
writes the full book state and the sequence it is current as of.

A snapshot is written to a temporary file in the same directory and **renamed**
into place. A half-written snapshot that recovery might read is worse than no
snapshot at all, and rename is the only step in this that is atomic.

A snapshot carries its own CRC. One that fails it is ignored, not repaired.

### Recovery

1. Load the newest snapshot that passes its CRC. If none does, start empty.
2. Replay journal records after that snapshot's sequence.
3. Resume assigning sequences from the last journaled sequence plus one.

Sequences never repeat across a restart. Restarting at zero would make the
settlement worker's offset meaningless, and a duplicate sequence is a duplicate
`reference_id` on a settlement — which the unique index would reject, turning a
recoverable restart into a stuck queue.

### Damage: two cases, two different answers

| Damage                                                                           | Answer                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Torn tail** — the last record is short or fails its CRC, nothing after it      | Truncate to the last valid record, log the sequence loudly, continue |
| **Mid-journal corruption** — a record fails its CRC with intact records after it | **Refuse to start.** Do not skip it                                  |

A torn tail is the expected result of a power loss during an append and there is
exactly one correct interpretation of it: the command was never durable, so it
never happened.

Corruption in the middle is not that. Skipping the record produces a book that
never existed, and every event after it is wrong in a way no test will catch,
because the engine will be internally consistent about a history that did not
happen. A refusal to start is recoverable by a human with the runbook. A silently
wrong book is not recoverable at all, because nobody will know to look.

### What a replay may differ in

Nothing.

Not the event stream, not the fill ids, not the ordering, not the timestamps, not
the final book. Two independently constructed engines fed the same journal emit
byte-identical events. This is asserted by a test that exists before the book does
— not at the end of the phase, when determinism lost weeks earlier has a month of
commits to bisect.

## Alternatives considered

**Redis Streams as the durable log, no engine journal.** One fewer moving part,
and Redis persists. Rejected on the numbers: `appendfsync everysec` is a one-second
window of lost executions on a hard kill, and `appendfsync always` costs a network
round trip on the hot path to get a guarantee a local append already gives. It also
inverts the dependency — the engine could not recover without Redis, so an
infrastructure component becomes load-bearing for correctness rather than for
delivery.

**Journal the output events rather than the input commands.** Smaller in the
common case and directly replayable to consumers. Rejected because it makes the
book unrecoverable from the journal alone: events describe what happened, not what
was asked, so a rejected order leaves no trace and the engine cannot reconstruct
the state that rejected it. Journaling inputs means the events are a _function_ of
the journal, which is the property replay testing needs.

**Write to PostgreSQL instead of a file.** Transactional with settlement, and
already operated. Rejected because it puts a network round trip and a shared
database inside the matching path, and because the engine having a database handle
is the beginning of the engine having a write path to money — which ADR-0025 makes
structurally impossible on purpose.

**No snapshots; always replay from the beginning.** Simplest, and correct. Rejected
only for recovery time: a market that has run for a week replays for minutes, and a
kill switch that takes minutes to recover is not a kill switch. Snapshots are an
optimisation over a correct baseline, which is why the baseline is still tested
(snapshot-plus-tail must equal full replay).

## Consequences

- One fsync per command bounds ingress throughput to what the disk sustains. That
  is the intended trade and the benchmarks measure it honestly rather than around
  it.
- The journal grows without bound in S1. Retention and compaction are deferred;
  the snapshot makes them possible later without changing the format.
- Mid-journal corruption is an outage requiring a human. It needs a runbook, and
  that runbook is part of S1's definition of done.
- The settlement worker can recover from a wiped Redis stream by asking the engine
  to re-emit from a sequence. S2 exposes that; S1 makes it possible.
- Because timestamps are inputs, the gateway becomes responsible for supplying a
  sane one. A gateway that sends a wildly wrong timestamp corrupts candles, not
  balances — but it does corrupt candles, and S3 should validate it.
