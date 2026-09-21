# ADR-0029: Maker/taker fees, and the asset they are charged in

**Status:** accepted · **Date:** 2026-09-21 · **Phase:** S1 (contract) · S4 (charged)
**Required by:** ADR-0025 · **Relates to:** ADR-0026 (fixed-point arithmetic)

## Context

No fee is charged until S4. This ADR is nevertheless blocking for S1, for a
reason worth stating plainly: the fill event must carry the fields settlement
will need, and those fields cannot be added later without invalidating every
journal written and every golden test vector checked in before them.

A fee decision also reaches backwards into the hold. A taker fee that is charged
in an asset the order did not reserve is a fee that cannot be collected, and the
hold is computed in S1 (`packages/orders`) even though nothing applies it until
S3.

## Decision

**Fees are charged in the quote asset, for both sides, as basis points of the
notional, tiered by trailing 30-day quote volume.**

### The asset

Both the maker's and the taker's fee are denominated in the market's **quote**
asset.

This follows from the hold, not from preference. A buyer reserves quote
(`price × qty` plus the worst-case taker fee) and receives base; a seller reserves
base and receives quote. Charging the buyer in quote takes the fee from something
already reserved. Charging the seller in quote takes it from the proceeds, which
is why the seller's hold is bare quantity with no fee component
(`prompt_phase_s1.md` rules 63–64).

The alternative — each side pays in the asset it receives — means the buyer's fee
comes out of the base they are acquiring, so a fill of exactly `qty` delivers less
than `qty`. That is arithmetically fine and operationally miserable: every fill
then moves value in both assets on both legs, and the per-asset balance check in
`buildTransaction` has to be satisfied by four legs instead of the three
ADR-0025 §2.4 describes.

### The schedule

Basis points of the truncated notional (ADR-0026), tiered by the user's trailing
30-day quote volume across all markets:

| Tier | 30-day quote volume | Maker | Taker |
| ---- | ------------------- | ----- | ----- |
| 0    | —                   | 10 bp | 20 bp |
| 1    | ≥ 100,000           | 8 bp  | 18 bp |
| 2    | ≥ 1,000,000         | 5 bp  | 15 bp |
| 3    | ≥ 10,000,000        | 2 bp  | 10 bp |

Maker below taker at every tier, and no negative maker fee. A rebate is a real
mechanism for attracting liquidity and it is also a way to pay out money the
exchange has not collected, which needs an accounting treatment this project does
not have. If the demo market maker needs an incentive, it is a funded account, not
a rebate.

`fee = floor(notional * bps / 10_000)`, computed in the wider integer of ADR-0026
and truncated toward zero — the same direction, once, so a fee is never larger
than the schedule says.

### What S1 does

S1 carries the fields and computes nothing:

- `Fill` carries **taker side**, so settlement knows which participant pays which
  rate. It is not derivable from anything else in the event, and omitting it is
  the exact failure `prompt_phase_s1.md` rule 15 describes.
- `Fill` carries the fee fields, unpopulated.
- `computeHold` includes the **worst-case** taker fee for a buy — tier 0, the
  most expensive rate — because the hold is taken before the tier is known and a
  hold that is too small is an unfillable order.

The over-hold is refunded at settlement in S4, the same mechanism that refunds a
market buy's collar over-hold.

### Where the fee goes

`house_trading_fees`, an equity account, credited in the same balanced
transaction that releases both holds. It is the slack in the clearing reserve
inequality of ADR-0025 §3 — which is why that inequality is `>=` and not `==`.

## Alternatives considered

**Each side pays in the asset it receives.** The common convention on centralised
spot exchanges. Rejected for the settlement shape described above: it adds a fee
leg in the base asset, so both assets move on both legs, and the resulting
transaction is harder to read and harder to assert. Quote-only fees keep base
movement pure — `qty` out of the seller, `qty` into the buyer, exactly.

**A flat fee per fill.** Trivial to compute and to hold for. Rejected because it
makes small fills uneconomic and large fills free, which distorts exactly the
behaviour an order book is supposed to price.

**Maker rebates — a negative maker fee.** The standard way to attract liquidity.
Rejected for now because paying out requires funding the payment from somewhere,
and "somewhere" is either accumulated taker fees (which may not cover it) or house
equity (which is the platform paying for volume). Either is a deliberate policy
with an accounting treatment, and neither belongs in a first fee schedule.

**Tiering by trailing 30-day _base_ volume, per market.** Rejected because tiers
would then not be comparable across markets, and a user's tier would depend on
which pair they happened to trade.

**Deferring this ADR to S4, when fees are actually charged.** The obvious choice,
and wrong. The fill event shape is frozen by S1's journal format and golden
vectors. Adding `takerSide` in S4 means every journal and every vector written
before it is invalid.

## Consequences

- The fill event carries fields nothing populates until S4. That is intended, and
  S1's definition of done asserts their presence rather than their values.
- A buy's hold is larger than its notional by the worst-case taker fee, so a user
  at tier 3 briefly reserves more than they will pay. S4 refunds it.
- Fee revenue accrues only in quote assets, so `house_trading_fees` has a balance
  per quote asset and not per market.
- Volume tiers need trailing 30-day volume per user, which is a query S4 must
  build and S1 does not. The engine never sees a tier — it emits the fill, and
  the rate is applied at settlement, where the volume is known.
- A market whose quote asset is not the asset the platform wants fees in would
  break the single-asset-fee property. Every market planned here quotes in USDC.
