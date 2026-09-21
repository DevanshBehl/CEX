//! The engine's view of the contracts in `packages/types`.
//!
//! These are hand-derived from the TypeScript, and that duplication is
//! permitted only because `vectors/price-vectors.json` is decoded by both sides
//! and asserted to agree (prompt_phase_s1.md rules 76, 137). Change one without
//! the other and `arithmetic.rs` fails.

use serde::{Deserialize, Serialize};

/// ADR-0026. Quote base units per one base base-unit, times `PRICE_SCALE`.
pub const PRICE_SCALE: u128 = 1_000_000_000;
pub const PRICE_SCALE_EXP: u32 = 9;
pub const BPS_DENOMINATOR: u128 = 10_000;

pub type Price = u64;
pub type Qty = u64;
pub type Seq = u64;

/// An order id, assigned by the gateway. The engine never invents one.
pub type OrderId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Self {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderType {
    Limit,
    Market,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeInForce {
    /// Rests until cancelled.
    GTC,
    /// Takes what is available immediately; the remainder is cancelled, not rested.
    IOC,
    /// Fills entirely or not at all.
    FOK,
}

/// Self-trade prevention. Every mode emits an event for what it cancelled or
/// refused: in S3 each of those releases a hold, and an outcome with no event
/// is money reserved forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StpMode {
    CancelTaker,
    CancelMaker,
    CancelBoth,
}

/// APPEND-ONLY, mirroring `REJECT_REASONS` in `packages/types`. A code that has
/// been persisted must keep meaning what it meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RejectReason {
    UnknownMarket,
    MarketNotOpen,
    NoReferencePrice,
    TickViolation,
    LotViolation,
    BelowMinNotional,
    OutsideCollar,
    NotionalOverflow,
    QuantityNotPositive,
    PriceRequired,
    PriceNotAllowed,
    PostOnlyRequiresLimit,
    DuplicateClientOrderId,
    PostOnlyWouldCross,
    SelfTradePrevented,
    UnknownOrder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderRequest {
    pub client_order_id: String,
    pub side: Side,
    pub order_type: OrderType,
    pub time_in_force: TimeInForce,
    /// `None` for a market order; required for a limit order.
    pub price: Option<Price>,
    pub qty: Qty,
    pub post_only: bool,
    pub stp_mode: StpMode,
    /// Used only for self-trade prevention. The engine knows nothing else about it.
    pub account_id: String,
}

/// What the engine consumes.
///
/// `seq` and `timestamp_ms` are SUPPLIED, never read. The engine does not own a
/// clock (ADR-0028): a fill's timestamp is the timestamp of the command that
/// caused it, journaled with it, and therefore reproduced exactly by a replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {
    Place {
        order_id: OrderId,
        request: OrderRequest,
    },
    Cancel {
        order_id: OrderId,
    },
    /// An atomic cancel-and-replace. It LOSES TIME PRIORITY, which is a
    /// documented consequence rather than something a user discovers.
    Amend {
        order_id: OrderId,
        new_order_id: OrderId,
        price: Price,
        qty: Qty,
    },
    /// Change the market's trading status.
    ///
    /// Journaled like any other command, so a replay reproduces the market
    /// having been halted at exactly the sequence it was halted at. A status
    /// held outside the journal would be a second source of truth about what
    /// the book was allowed to do.
    ///
    /// APPENDED to this enum deliberately. bincode encodes a variant by index,
    /// so a new variant at the end leaves `Place`, `Cancel` and `Amend`
    /// decodable in every journal already written. Inserting one anywhere else
    /// silently reinterprets recorded history.
    SetStatus {
        status: MarketStatus,
    },
}

/// A command with its assigned sequence and timestamp. This is what the journal
/// stores and what a replay feeds back in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencedCommand {
    pub seq: Seq,
    pub timestamp_ms: i64,
    pub command: Command,
}

/// A fill.
///
/// `taker_side` is not derivable from anything else here and settlement needs
/// it to attribute the taker fee (ADR-0029). The fee fields are carried and left
/// `None` until S4: adding them later would invalidate every journal and every
/// golden vector written before them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fill {
    pub fill_id: String,
    pub seq: Seq,
    pub taker_order_id: OrderId,
    pub maker_order_id: OrderId,
    pub taker_side: Side,
    pub price: Price,
    pub qty: Qty,
    pub timestamp_ms: i64,
    /// Quote base units. Populated in S4.
    pub maker_fee: Option<u64>,
    pub taker_fee: Option<u64>,
}

/// Deterministic: the sequence and the index of the fill within that command's
/// output. A replay produces the same ids, which is what makes S4's settlement
/// idempotency key stable across one.
pub fn fill_id(seq: Seq, index: usize) -> String {
    format!("{seq}:{index}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {
    Accepted {
        seq: Seq,
        order_id: OrderId,
        resting_qty: Qty,
    },
    Rejected {
        seq: Seq,
        order_id: OrderId,
        reason: RejectReason,
    },
    Fill(Fill),
    Cancelled {
        seq: Seq,
        order_id: OrderId,
        remaining_qty: Qty,
    },
    Expired {
        seq: Seq,
        order_id: OrderId,
        remaining_qty: Qty,
    },
    /// Appended for the same reason `Command::SetStatus` is.
    StatusChanged {
        seq: Seq,
        previous: MarketStatus,
        current: MarketStatus,
    },
}

impl Event {
    pub fn seq(&self) -> Seq {
        match self {
            Event::Accepted { seq, .. }
            | Event::Rejected { seq, .. }
            | Event::Cancelled { seq, .. }
            | Event::Expired { seq, .. }
            | Event::StatusChanged { seq, .. } => *seq,
            Event::Fill(fill) => fill.seq,
        }
    }

    /// Events after which the order holds no further reservation. S3 releases
    /// on these.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Event::Rejected { .. } | Event::Cancelled { .. } | Event::Expired { .. }
        )
    }
}

/// `floor(price * qty / PRICE_SCALE)` in quote base units (ADR-0026).
///
/// The multiplication is performed in `u128` and that is MANDATORY, not
/// defensive: with a price near 1e8 and a quantity near 1e15 the product is
/// about 1e23, and `u64` tops out near 1.8e19. `vectors/price-vectors.json`
/// carries that case specifically, so a `u64` intermediate here fails a test
/// rather than silently wrapping.
///
/// `None` on overflow. An overflow is a rejection, never a wrap.
pub fn notional(price: Price, qty: Qty) -> Option<u64> {
    let value = (u128::from(price) * u128::from(qty)) / PRICE_SCALE;
    u64::try_from(value).ok()
}

/// `floor(notional * bps / 10_000)`. Same truncation direction as `notional`,
/// so a fee is never larger than the schedule says (ADR-0029).
pub fn fee_amount(notional_value: u64, bps: u32) -> Option<u64> {
    let value = (u128::from(notional_value) * u128::from(bps)) / BPS_DENOMINATOR;
    u64::try_from(value).ok()
}

pub fn is_multiple_of(value: u64, step: u64) -> bool {
    step != 0 && value % step == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketStatus {
    PreOpen,
    Open,
    PostOnly,
    /// Accepts nothing — except cancels. A halt stops price formation; it does
    /// not take away the exit (ADR-0027).
    Halted,
}

impl MarketStatus {
    pub fn accepts_placement(self) -> bool {
        matches!(self, MarketStatus::Open | MarketStatus::PostOnly)
    }
}

/// Mirrors `Market` in `packages/types` (ADR-0027). Every structural constraint
/// on an order lives here and never on the request — a client-supplied collar
/// is not a safety band, it is a field an attacker sets to remove the band.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketConfig {
    pub id: String,
    pub tick_size: Price,
    pub lot_size: Qty,
    pub min_notional: u64,
    pub collar_bps: u32,
    pub status: MarketStatus,
}

impl MarketConfig {
    /// The band an order is judged against, given a reference price.
    pub fn collar_band(&self, reference: Price) -> (Price, Price) {
        let deviation = (u128::from(reference) * u128::from(self.collar_bps)) / BPS_DENOMINATOR;
        let lower = u128::from(reference).saturating_sub(deviation);
        let upper = u128::from(reference)
            .saturating_add(deviation)
            .min(u128::from(u64::MAX));
        (lower as u64, upper as u64)
    }
}
