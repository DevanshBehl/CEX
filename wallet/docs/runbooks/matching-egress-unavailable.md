# Runbook: the matching engine cannot reach Redis

**Symptom:** order placement returns `503 egress_unconfirmed`. The engine logs
publish failures. `GET /v1/health` still responds and `last_seq` may still be
advancing.

## What this means

Egress is blocking ([ADR-0030](../adr/0030-engine-transport-and-backpressure.md)):
the engine does not acknowledge a request until its events are in the stream. A
503 means they are not.

**It does not mean the command did not happen.** The command was journaled and
fsynced, and the book mutated, before publication was attempted. The caller lost
certainty, not the order.

Redis being load-bearing for _accepting_ orders is a deliberate trade. The
alternative — acknowledging before publishing — would make a 2xx mean less than
every caller assumes it means.

## First: do not

- **Do not retry the order blind.** The first attempt may have matched. Resolve
  with `/v1/orders/lookup?clientOrderId=...` first.
- Do not restart the engine to "clear" it. The journal is intact and a restart
  republishes from the watermark; restarting adds risk and fixes nothing.
- Do not delete the stream to force a clean state. Recovery can rebuild it, but
  only after the cause is understood.
- Do not raise `MATCHING_WATERMARK_SYNC_EVERY` to reduce I/O during an incident.
  A laggier watermark means more duplicate delivery on recovery, which is safe,
  but it is not the problem.

## Establish the state

```bash
curl -s http://<engine>/v1/health          # last_seq vs published_watermark
redis-cli -u "$MATCHING_REDIS_URL" ping
redis-cli -u "$MATCHING_REDIS_URL" XLEN "orders:events:<market>"
```

| Reading                            | Meaning                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `last_seq` > `published_watermark` | events are journaled and unpublished — recovery will republish |
| Redis reachable, `XLEN` growing    | the outage has cleared; new commands should succeed            |
| Redis unreachable                  | the cause is below the engine; fix Redis                       |

## Resolving a caller's ambiguous 503

For each order the gateway has in `PENDING_ENGINE`:

```bash
curl -s "http://<engine>/v1/orders/lookup?clientOrderId=<id>"
```

- `seen` — the engine has it. **Do not re-place.** Its events will appear when
  publication recovers.
- `never_seen` — the engine never received it. The gateway may release the hold.
- `rebuilding` — **no answer yet.** Wait. Treating this as `never_seen` releases
  a hold against a live order.

## Restoring service

1. Fix Redis. The engine's `ConnectionManager` reconnects on its own.
2. Confirm `published_watermark` catches up to `last_seq` in `/v1/health`.
3. Confirm the settlement consumer's offset is advancing (S4).
4. Only then let the gateway resume placing orders.

If the stream was lost entirely, recovery republishes from the watermark on the
next boot — or a consumer can ask the engine directly:

```bash
curl -s "http://<engine>/v1/events?after=<last-settled-seq>&limit=1000"
```

## Afterwards

Record: how long the outage lasted, the gap between `last_seq` and
`published_watermark` at its peak, how many 503s the gateway saw, and whether
any order was re-placed blind. The last one is the only item that can have cost
money.

If re-emission required a journal replay rather than the in-memory ring,
`MATCHING_EVENT_RING_CAPACITY` is too small for the consumer's worst-case lag.
