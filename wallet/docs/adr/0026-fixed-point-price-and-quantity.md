# ADR-0026: Fixed-point price and quantity

**Status:** proposed · **Date:** 2026-09-21 · **Phase:** S1
**Extends:** ADR-0021 (cluster dimension) · **Required by:** ADR-0025

## Context

The ledger already refuses floating point. `packages/types/src/money.ts` says why:
2^53 lamports is about nine million SOL, and IEEE-754 cannot represent every
integer above that, so money is an integer count of an asset's smallest
indivisible unit carried as a decimal string.

A price is not money. It is a ratio between two assets, and a ratio does not have
a smallest indivisible unit handed to it by the chain — it needs one chosen. Get
that choice wrong and the errors are the kind that do not announce themselves: a
price that cannot be represented exactly rounds differently on two code paths,
and a buyer and a seller settle for different amounts against the same fill.

The engine is Rust with fixed-width integers; the contracts are TypeScript. Both
must compute the same notional from the same price and quantity, including at the
boundary where a rounding decision is unavoidable.

## Decision

**Quantity is the base asset's base unit. Price is an integer at a fixed scale of
10^9. Notional is computed in a wider integer and truncated toward zero, once.**

### Quantity

A quantity is an integer count of the **base** asset's base units — lamports for
SOL, 10^-6 for USDC. This is the unit the ledger already uses, so a fill's
quantity needs no conversion to become a ledger entry, and no conversion is a
place a conversion bug can live.

### Price

`PRICE_SCALE_EXP = 9`, `PRICE_SCALE = 1_000_000_000`.

A price is an integer representing **quote base units per one base base-unit,
multiplied by `PRICE_SCALE`**:

```
price_int = (quote_base_units / base_base_units) * PRICE_SCALE
```

Worked, for SOL/USDC at 150 USDC per SOL — SOL has 9 decimals, USDC has 6:

```
1 SOL            = 1_000_000_000 lamports
150 USDC         =   150_000_000 USDC base units
per lamport      = 150_000_000 / 1_000_000_000 = 0.15
price_int        = 0.15 * 10^9 = 150_000_000
```

Nine digits of scale is chosen because it survives the worst pairing this project
will plausibly serve — a 9-decimal base against a 6-decimal quote, which is the
SOL/USDC case above and already costs three digits — while leaving the whole
range inside `u64` with room that is not close.

### Notional

```
notional_quote_base_units = floor( price_int * qty_base_units / PRICE_SCALE )
```

The multiplication **must** be performed in a wider type. With `price_int` near
10^8 and a quantity of 10^15 base units, the product is about 10^23, and `u64`
tops out near 1.8 × 10^19. Rust computes it in `u128` and returns a checked
`u64`; TypeScript computes it in `bigint`. An overflow is an error, never a wrap.

### Rounding

Truncation toward zero — `floor`, since every value here is non-negative.

It is applied **once per fill**, and both legs of that fill use the identical
resulting integer: the buyer pays exactly it, the seller receives exactly it. The
residual is at most one quote base unit and it is simply not charged, which is
the property that matters — a residual that went somewhere would have to be
accounted for, and a residual accounted for on only one leg is an unbalanced
ledger transaction.

### At the boundary

Over the wire and in the database, price and quantity are branded decimal
strings, exactly as `BaseUnits` already is. They are integers inside the engine
and inside the ledger, and strings in between. No decimal library, on either
side.

## Alternatives considered

**A decimal library — `decimal.js`, `rust_decimal`.** Correct arithmetic without
choosing a scale. Rejected because it moves the representation decision into a
dependency rather than removing it: two libraries still have to agree on rounding
mode and precision, the engine would carry an allocating type on its hottest
path, and the ledger's own refusal of anything but integers would still require a
conversion at the boundary — which is the conversion this ADR exists to avoid.

**Price as a rational — numerator and denominator.** Exact, no rounding anywhere.
Rejected because the exactness is not free: comparing two rationals for price
priority means cross-multiplying, an order book keyed on a non-canonical type
needs normalisation on every insert, and the notional eventually has to become an
integer anyway. The rounding is deferred, not avoided, and the book pays for it
on every operation.

**Price in quote base units per _whole_ base unit.** More readable — 150 USDC per
SOL is `150_000_000` with no scale at all. Rejected because it cannot express a
price finer than one quote base unit per whole base unit, which for a low-decimal
quote against a high-value base is a tick far coarser than a real market needs,
and the fix would be a scale factor — this decision, arrived at later and with a
migration.

**Scale of 10^18, matching an Ethereum convention.** Rejected as unjustified
headroom: it costs range in the `u128` intermediate for precision no Solana asset
pairing needs, and a wider intermediate is the thing most likely to overflow
unnoticed.

## Consequences

- A fill's quantity is already in the ledger's unit and is posted without
  conversion.
- `price_int * qty` overflows `u64` at realistic values. The wider intermediate
  is mandatory and is a test, not a comment.
- TypeScript and Rust duplicate this arithmetic. A checked-in vector file,
  including the rounding boundary, is decoded and asserted by both — the
  duplication is permitted only because it is proven not to drift.
- A tick size is expressed in the same `price_int` units, so a market's tick is a
  plain integer multiple test and not a decimal comparison.
- If a future market needs a base asset with more than nine decimals against a
  low-decimal quote, the scale needs revisiting. Nothing on Solana currently
  forces that.
