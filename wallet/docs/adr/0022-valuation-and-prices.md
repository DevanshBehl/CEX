# ADR-0022: Portfolio valuation, and where a price comes from

**Status:** accepted · **Supersedes:** nothing · **Relates to:** ADR-0016, ADR-0021

## Context

Until now this system had no price feed, and the dashboard said so: balances,
no dollars, no chart. That was the honest position — "a fabricated number in a
wallet is worse than no number at all" — and it is also, eventually, a wallet
nobody can read. A holding of `249349760` is not an amount most people can
value at a glance.

Adding a dollar figure means adding the first number on the interface that does
**not** come from the ledger. Every other figure is a projection of entries this
system wrote and can replay. A price is someone else's assertion, fetched over
HTTP, and the portfolio total is that assertion multiplied by ours.

## Decision

### 1. Prices are stored, not fetched on read

`asset_price_ticks` is append-only, with the same `REVOKE` + trigger treatment
as `ledger_entries`. A valuation is reproducible from two stored inputs: the
entries, and the tick that was current at the instant being valued.

Valuing on read — calling the feed when someone opens the page — would make the
same page show different history on two loads, and make "what was this worth on
Tuesday" unanswerable. It would also put a third party's rate limit on the path
of every request.

### 2. A historical point uses the price AS IT WAS THEN

The tick used for time _T_ is the most recent one at or **before** _T_. Never
the closest in either direction: a tick from after _T_ is lookahead, and it
makes a chart move where nothing happened.

The most recent price also **carries forward** until a newer one exists. This
sounds obvious and was got wrong first: a walk that reported only newly-seen
ticks returned nothing for every bucket after the last observation, so the line
fell to zero at the right-hand edge — which is the part someone looks at.

### 3. No interpolation, ever

A cycle that fails writes nothing. A gap in the ticks is a gap in the chart,
drawn as a break and said in words, and a holding nothing can price reads
"No price" rather than `$0.00`.

Filling a gap with the previous value manufactures evidence that the price held
steady, which is a different claim from "we do not know". Showing an unpriced
holding as zero is worse still: it displays a fall in someone's net worth that
did not happen, and they will believe it.

### 4. Devnet is priced at mainnet rates, and this is a fiction

A devnet USDC mint is a mock with no market. It is valued from the real USDC
market, because the **symbol** is what carries across clusters — a mint address
is per cluster and no feed indexes one.

That is a deliberate fiction and worth naming. It is the only way a test cluster
teaches anything about a portfolio, and the interface says `DEVNET — test funds
only` beside it (ADR-0021). Ticks are still stored per `(cluster, asset)`, so a
mainnet valuation can never read a devnet row.

### 5. Integers all the way to the pixel

Prices are `NUMERIC(18,6)`, parsed to micro-dollars as **strings**, and every
product is a `bigint`. `Number('1.005') * 1e6` is `1004999.9999999999`, and the
place that error would surface is the number a user reads most often.

Pyth returns a mantissa and an exponent rather than a decimal; the string is
reassembled by moving the point, never by `10 ** expo`.

### 6. The source is swappable, and `pyth` is not the default

| Source      | Credentials  | Notes                                                                                                                               |
| ----------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `coingecko` | none         | The default. Covers SOL, USDC, USDT in one request.                                                                                 |
| `pyth`      | **required** | `hermes.pyth.network/v2/updates/price/latest` returns **401**; the metadata endpoint does not. Needs a key or a self-hosted Hermes. |
| `static`    | none         | Fixed prices, for development with no internet and for tests that need an exact figure.                                             |
| `none`      | —            | No valuation. Balances render, dollars do not.                                                                                      |

Pyth was the stated preference and an oracle a deployment runs itself is a
better trust story than an aggregator's REST API. It is implemented, its feed
ids were read from Hermes' own metadata endpoint rather than remembered, and it
is not the default because the public endpoint no longer answers anonymously.

`static` is explicitly **not** a fallback for a failing feed. A
stale-but-plausible number presented as a live price is worse than no price:
the interface can say "no price yet", and it cannot say "this one is made up".

## Consequences

- The dashboard has a dollar figure, a 24h delta and a chart, and every one of
  them is derivable from `ledger_entries` + `asset_price_ticks`.
- A percentage change is `null` — not `0` — when there is nothing to compare
  against. A portfolio that went from nothing to something has not risen by any
  percentage.
- `asset_price_ticks` grows by one row per asset per cluster per cycle. At a
  five-minute interval and three assets on two clusters that is ~1.7k rows a
  day, which is nothing; a one-second interval would be a different
  conversation and the interval is configuration for that reason.
- A valuation reads every `user_available` entry before the window, because a
  balance at _T_ is the sum of everything before _T_. That is capped, and an
  account beyond the cap is told its history is truncated rather than being
  shown a chart that silently starts halfway.
