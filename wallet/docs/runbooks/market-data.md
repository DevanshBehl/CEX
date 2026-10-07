# Runbook: market data, the socket and the demo market maker

**Applies to:** Phase S5 · **Audience:** whoever is on call

Market data is not money. Nothing on this page can lose a balance, and nothing
here should be fixed by touching settlement, the ledger or a user's orders.

Where each consumer stands, for a signed-in operator:

```
GET /operator/trading/pipeline
```

It returns, per market, the settlement worker's and the trade tape's last
applied event key, their lag in engine sequences, and — if halted — the key and
the reason.

## The book is stale or resynchronising

**Symptom:** the trading screen marks the book "Resynchronising — stale", or
`GET /markets/<symbol>/book` answers 503. `market_data_book_resyncs_total` is
climbing; `market_data.book_resynced` events name a cause.

### What this means

Each API instance mirrors the book from one engine snapshot plus the level
changes on the stream ([ADR-0036 §3](../adr/0036-market-data-pipeline.md)). On
any doubt it stops vouching for its mirror, tells subscribers, and takes a new
snapshot. **An occasional resync is the design working.** A book that is
permanently resynchronising is not.

| Cause in the event  | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `sequence_gap`      | A sequence was missing from the stream.                        |
| `event_gap`         | Part of a sequence was missing.                                |
| `undecodable_entry` | An entry, or its `levels`, was not a shape this API knows.     |
| `behind_engine`     | The stream went quiet while the engine's sequence kept moving. |
| `reader_failed`     | The read itself failed: Redis.                                 |

### Do not

- Do not restart the engine. Its book is the authority and is not the problem.
- Do not delete the stream. Settlement and the tape recover from that, but it
  fixes nothing here.

### Establish the state

```bash
curl -s http://<engine>/v1/health                         # last_seq, published_watermark
redis-cli -u "$REDIS_URL" XREVRANGE "orders:events:<market id>" + - COUNT 3
```

- **The newest entries have no `levels` field.** The engine is older than the
  API. Level changes were added in S5; deploy the engine first.
- **`published_watermark` is behind `last_seq`.** The engine cannot publish:
  see [matching-egress-unavailable](./matching-egress-unavailable.md).
- **Redis is unreachable from the API.** Fix Redis; the reader resumes.
- **The engine is unreachable from the API.** No snapshot can be taken, so the
  mirror stays invalid and the book stays 503. Settlement and the tape will be
  lagging for the same reason.

`market_data_fanout_lag_sequences{market}` returning to zero and staying there
is the signal that it is over.

## The trade tape has halted

**Symptom:** a `market_data.halted` security event with a market, an event key
and a reason; `market_data_halts_total{market}` increased;
`market_data_offset_lag_sequences{market}` is climbing. The chart and the trade
history for that market stop advancing. **The live book and the live tape on the
socket keep working**, and so does settlement.

### What this means

The persisted tape met an event it could not record and stopped at it
([ADR-0036 §5](../adr/0036-market-data-pipeline.md)). It did not skip it: a
candle silently missing a trade is wrong with nothing to say so.

| Reason                                                        | Usual cause                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `undecodable_event`, `malformed_stream_entry`, `key_mismatch` | The engine was upgraded ahead of the API, or something else wrote to the stream. Settlement will have halted at the same key. |
| `fill_id_mismatch`                                            | A fill whose id is not `seq:k` for its own sequence. An engine bug.                                                           |
| `reemission_gap`, `unrecoverable_gap`                         | The journal is damaged: see [corrupt-matching-journal](./corrupt-matching-journal.md).                                        |
| `constraint_*`                                                | The database refused the row. A bug in this consumer.                                                                         |

### Resolve it

Fix the cause, deploy, restart the API. The consumer reads its offset and
retries the same key. Nothing needs replaying by hand.

If the candles are suspected wrong after a fix, rebuild them from the tape,
which is the record and is not touched:

```bash
pnpm --filter @wallet/api rebuild-candles -- --market=<cluster>:<SYMBOL>
```

It drops and recomputes that market's candles in one transaction. A rebuild of a
correct table reproduces it exactly, and a test holds it to that.

There is deliberately no way to skip an event here either. The stakes are lower
than settlement's and the rule is the same.

## The market maker will not start

**Symptom:** a `market_maker.start_refused` event at boot. The API is otherwise
up. `/capabilities` reports `trading.syntheticLiquidity: false`.

| Reason             | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `no_such_user`     | `TRADING_MARKET_MAKER_USER_ID` is not a user in this database.         |
| `nothing_to_quote` | `TRADING_MARKET_MAKER_LEVEL_QTY` names no market in `TRADING_MARKETS`. |

Configuration validation refuses it outright — the API does not boot — when it
is enabled on `mainnet-beta`, without market data, or without a user id.

**It is never created or funded for you** ([ADR-0038 §3](../adr/0038-demo-market-maker.md)).
Register an account, note its user id, deposit to it and allocate to trading
with its passkey, exactly as any user does, then set the variable. Do not credit
it in the ledger: reconciliation check 1 will report exactly that amount missing
from the clearing address, correctly.

## The market maker is running and not quoting

**Symptom:** an empty or one-sided book; `market_maker.quotes_pulled` events.

| Reason                                    | Meaning                                                                       | What to do                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `reference_stale`                         | Its reference price is older than `TRADING_MARKET_MAKER_STALE_MS`, or absent. | With `binance`: the feed is down or the ticker name is wrong. It does **not** fall back to the random walk. |
| `settlement_halted`, `settlement_delayed` | Fills in that market are not reaching the ledger.                             | Resolve settlement: [settlement-halted](./settlement-halted.md).                                            |
| `market_not_open`                         | The engine reports the market as not open, or cannot be reached.              | Check the engine's market status.                                                                           |

No event, and still one-sided: it has run out of that asset. It logs "cannot
fund every quote" once and quotes what it can. Its balance is an ordinary
trading balance; fund it as above.

Quotes rejected every cycle (`market_maker_quotes_total{outcome="rejected"}`
climbing): the book's last trade is far from the maker's reference, so its
quotes fall outside the engine's collar. It only quotes inside the band it can
see, so this means the band moved between its read and its order.

`outcome="skipped"` climbing: the gateway is refusing before any hold is taken —
the per-user order-rate limit or open-order limit. The maker has no exemption.
Raise `TRADING_MARKET_MAKER_INTERVAL_MS`, lower `TRADING_MARKET_MAKER_LEVELS`,
or raise the limits for everyone.

## Sockets

`ws_sockets_closed_total{reason}` and `ws_upgrades_refused_total{reason}` say
why connections end.

- **`origin` refusals** from a browser mean `WEB_ORIGIN` does not match where
  the web application is actually served. From anything else, they are the
  check working.
- **`slow_consumer`** in bulk means clients cannot keep up: a busy book and
  slow links. It sheds connections, never messages; clients reconnect and take
  a snapshot.
- **`session_ended`** is a socket closed because its session was. It follows a
  sign-out or an expiry by at most `WS_SESSION_RECHECK_SECONDS`.

A user reporting "my fill did not appear": the private channel is a hint, not a
record ([ADR-0037 §7](../adr/0037-websocket-transport.md)). Reloading the page
fetches orders, fills and balances over REST. If the fill is not there either,
it has not settled — check the pipeline endpoint for that market.
