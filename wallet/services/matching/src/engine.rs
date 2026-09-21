//! The engine.
//!
//! `apply` is pure: the same book state, sequence and command produce the same
//! events, forever, on any machine. No clock, no randomness, no floats, no
//! iteration over an unordered collection anywhere output depends on it.
//!
//! # Event contract
//!
//! Every command produces at least one event. In S3 each event moves a hold, so
//! a command that produced none would be money reserved forever.
//!
//! For a placement the engine emits its `Fill`s in match order, then exactly one
//! disposition:
//!
//! - `Accepted { resting_qty: r }` with `r > 0` — `r` is still held and may fill
//! - `Accepted { resting_qty: 0 }` — fully filled; the fills consumed the hold
//! - `Expired { remaining_qty: r }` — `r` will never fill; release it
//! - `Rejected` — nothing entered the book; release everything
//!
//! `Rejected`, `Cancelled` and `Expired` are exactly the events after which a
//! remainder must be released, which is why `Event::is_terminal` names those
//! three and not `Accepted`.

use crate::book::{OrderBook, RestingOrder};
use crate::types::{
    fill_id, is_multiple_of, notional, Command, Event, Fill, MarketConfig, OrderId, OrderRequest,
    OrderType, Price, Qty, RejectReason, SequencedCommand, Side, StpMode, TimeInForce,
};

#[derive(Debug, Clone)]
pub struct Engine {
    market: MarketConfig,
    book: OrderBook,
    last_seq: u64,
}

impl Engine {
    pub fn new(market: MarketConfig) -> Self {
        Self {
            market,
            book: OrderBook::new(),
            last_seq: 0,
        }
    }

    pub fn with_book(market: MarketConfig, book: OrderBook, last_seq: u64) -> Self {
        Self {
            market,
            book,
            last_seq,
        }
    }

    pub fn book(&self) -> &OrderBook {
        &self.book
    }

    pub fn market(&self) -> &MarketConfig {
        &self.market
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// S6 writes here. Every path that reads status must already tolerate it
    /// changing between two commands.
    pub fn set_status(&mut self, status: crate::types::MarketStatus) {
        self.market.status = status;
    }

    /// The journaled form. Emits an event like every other command, because a
    /// command that produced none would be a gap in the sequence a consumer
    /// cannot distinguish from a lost one.
    fn set_status_command(&mut self, seq: u64, status: crate::types::MarketStatus) -> Vec<Event> {
        let previous = self.market.status;
        self.market.status = status;
        vec![Event::StatusChanged {
            seq,
            previous,
            current: status,
        }]
    }

    /// The reference price, in the order ADR-0027 fixes: last trade, then the
    /// mid of a two-sided quote, then nothing.
    ///
    /// `None` is load-bearing. An empty book has no opinion about what anything
    /// is worth, and a market order is a request to trade at whatever the market
    /// says.
    pub fn reference_price(&self) -> Option<Price> {
        if let Some(last) = self.book.last_trade_price() {
            return Some(last);
        }
        match (self.book.best_bid(), self.book.best_ask()) {
            (Some(bid), Some(ask)) => Some(((u128::from(bid) + u128::from(ask)) / 2) as u64),
            _ => None,
        }
    }

    pub fn apply(&mut self, sequenced: SequencedCommand) -> Vec<Event> {
        let SequencedCommand {
            seq,
            timestamp_ms,
            command,
        } = sequenced;
        self.last_seq = seq;

        match command {
            Command::Place { order_id, request } => {
                self.place(seq, timestamp_ms, order_id, request)
            }
            Command::Cancel { order_id } => self.cancel(seq, order_id),
            Command::Amend {
                order_id,
                new_order_id,
                price,
                qty,
            } => self.amend(seq, timestamp_ms, order_id, new_order_id, price, qty),
            Command::SetStatus { status } => self.set_status_command(seq, status),
        }
    }

    // ---------------------------------------------------------------- cancel

    fn cancel(&mut self, seq: u64, order_id: OrderId) -> Vec<Event> {
        // Never silently successful. In S3 a silent success would release a
        // hold against an order that is still live.
        match self.book.remove(&order_id) {
            Some(order) => vec![Event::Cancelled {
                seq,
                order_id,
                remaining_qty: order.remaining,
            }],
            None => vec![Event::Rejected {
                seq,
                order_id,
                reason: RejectReason::UnknownOrder,
            }],
        }
    }

    // ----------------------------------------------------------------- amend

    /// An atomic cancel-and-replace. It LOSES TIME PRIORITY, documented rather
    /// than discovered.
    fn amend(
        &mut self,
        seq: u64,
        timestamp_ms: i64,
        order_id: OrderId,
        new_order_id: OrderId,
        price: Price,
        qty: Qty,
    ) -> Vec<Event> {
        let Some(existing) = self.book.remove(&order_id) else {
            return vec![Event::Rejected {
                seq,
                order_id,
                reason: RejectReason::UnknownOrder,
            }];
        };

        let mut events = vec![Event::Cancelled {
            seq,
            order_id,
            remaining_qty: existing.remaining,
        }];

        let request = OrderRequest {
            client_order_id: new_order_id.clone(),
            side: existing.side,
            order_type: OrderType::Limit,
            time_in_force: TimeInForce::GTC,
            price: Some(price),
            qty,
            post_only: false,
            stp_mode: existing.stp_mode,
            account_id: existing.account_id.clone(),
        };
        events.extend(self.place(seq, timestamp_ms, new_order_id, request));
        events
    }

    // ----------------------------------------------------------------- place

    fn place(
        &mut self,
        seq: u64,
        timestamp_ms: i64,
        order_id: OrderId,
        request: OrderRequest,
    ) -> Vec<Event> {
        let reject = |reason: RejectReason| {
            vec![Event::Rejected {
                seq,
                order_id: order_id.clone(),
                reason,
            }]
        };

        if self.book.contains(&order_id) {
            return reject(RejectReason::DuplicateClientOrderId);
        }
        if let Some(reason) = self.validate(&request) {
            return reject(reason);
        }

        let is_limit = request.order_type == OrderType::Limit;
        let limit_price = request.price;
        let reference = self.reference_price();

        // Post-only REJECTS rather than converting into a taker. Silently
        // changing a client's intent is worse than refusing it.
        if request.post_only {
            let price = limit_price.expect("validated: a limit order carries a price");
            if self.would_cross(request.side, price) {
                return reject(RejectReason::PostOnlyWouldCross);
            }
        }

        // The ceiling a market order may reach. The collar is what stops it
        // walking a thin book into an absurd fill.
        let collar_limit = match (is_limit, reference) {
            (true, _) => limit_price,
            (false, Some(reference)) => {
                let (lower, upper) = self.market.collar_band(reference);
                Some(if request.side == Side::Buy {
                    upper
                } else {
                    lower
                })
            }
            (false, None) => return reject(RejectReason::NoReferencePrice),
        };

        // FOK determines availability BEFORE mutating anything. A partial
        // mutation followed by a rollback is how a FOK leaks a fill.
        if request.time_in_force == TimeInForce::FOK {
            let available = self.fillable_qty(
                request.side,
                collar_limit,
                &request.account_id,
                request.stp_mode,
            );
            if available < u128::from(request.qty) {
                return vec![Event::Expired {
                    seq,
                    order_id,
                    remaining_qty: request.qty,
                }];
            }
        }

        let mut events: Vec<Event> = Vec::new();
        let mut remaining = request.qty;
        let mut stp_cancelled_taker = false;

        loop {
            if remaining == 0 {
                break;
            }
            let Some(best) = self.book.ladder_for(request.side.opposite()).best_price() else {
                break;
            };
            if !crosses(request.side, collar_limit, best) {
                break;
            }
            let Some(maker) = self.book.front_live(request.side.opposite(), best) else {
                break;
            };

            // --- self-trade prevention ---
            if maker.account_id == request.account_id {
                match request.stp_mode {
                    StpMode::CancelMaker | StpMode::CancelBoth => {
                        if let Some(removed) = self.book.remove(&maker.order_id) {
                            events.push(Event::Cancelled {
                                seq,
                                order_id: removed.order_id,
                                remaining_qty: removed.remaining,
                            });
                        }
                        if request.stp_mode == StpMode::CancelBoth {
                            stp_cancelled_taker = true;
                            break;
                        }
                        continue;
                    }
                    StpMode::CancelTaker => {
                        stp_cancelled_taker = true;
                        break;
                    }
                }
            }

            let traded = remaining.min(maker.remaining);
            self.book
                .consume_front(request.side.opposite(), best, traded);
            self.book.set_last_trade_price(best);
            remaining -= traded;

            events.push(Event::Fill(Fill {
                fill_id: fill_id(
                    seq,
                    events
                        .iter()
                        .filter(|e| matches!(e, Event::Fill(_)))
                        .count(),
                ),
                seq,
                taker_order_id: order_id.clone(),
                maker_order_id: maker.order_id.clone(),
                taker_side: request.side,
                price: best,
                qty: traded,
                timestamp_ms,
                maker_fee: None,
                taker_fee: None,
            }));
        }

        // --- disposition ---
        if stp_cancelled_taker {
            let filled_anything = events.iter().any(|e| matches!(e, Event::Fill(_)));
            if filled_anything {
                events.push(Event::Expired {
                    seq,
                    order_id,
                    remaining_qty: remaining,
                });
            } else {
                events.push(Event::Rejected {
                    seq,
                    order_id,
                    reason: RejectReason::SelfTradePrevented,
                });
            }
            return events;
        }

        if remaining == 0 {
            events.push(Event::Accepted {
                seq,
                order_id,
                resting_qty: 0,
            });
            return events;
        }

        // A market order's remainder is CANCELLED, never rested. A market order
        // that became a resting limit order at the collar edge is an order the
        // client did not place.
        let may_rest = is_limit && request.time_in_force == TimeInForce::GTC;
        if may_rest {
            let price = limit_price.expect("validated: a limit order carries a price");
            self.book.rest(RestingOrder {
                order_id: order_id.clone(),
                account_id: request.account_id.clone(),
                side: request.side,
                price,
                remaining,
                stp_mode: request.stp_mode,
                rested_at_seq: seq,
            });
            events.push(Event::Accepted {
                seq,
                order_id,
                resting_qty: remaining,
            });
        } else {
            events.push(Event::Expired {
                seq,
                order_id,
                remaining_qty: remaining,
            });
        }
        events
    }

    // -------------------------------------------------------------- helpers

    /// Every check runs. No short-circuit, for the same reason `packages/risk`
    /// evaluates every rule — except that the engine returns the first reason,
    /// because the gateway has already run the full validator and anything
    /// reaching here is a second line of defence.
    fn validate(&self, request: &OrderRequest) -> Option<RejectReason> {
        if !self.market.status.accepts_placement() {
            return Some(RejectReason::MarketNotOpen);
        }
        if self.market.status == crate::types::MarketStatus::PostOnly && !request.post_only {
            return Some(RejectReason::MarketNotOpen);
        }
        if request.qty == 0 {
            return Some(RejectReason::QuantityNotPositive);
        }
        let is_limit = request.order_type == OrderType::Limit;
        match (is_limit, request.price) {
            (true, None) => return Some(RejectReason::PriceRequired),
            (false, Some(_)) => return Some(RejectReason::PriceNotAllowed),
            _ => {}
        }
        if request.post_only && !is_limit {
            return Some(RejectReason::PostOnlyRequiresLimit);
        }
        if let Some(price) = request.price {
            if !is_multiple_of(price, self.market.tick_size) {
                return Some(RejectReason::TickViolation);
            }
        }
        if !is_multiple_of(request.qty, self.market.lot_size) {
            return Some(RejectReason::LotViolation);
        }

        let reference = self.reference_price();
        let judged_at = match (request.price, reference) {
            (Some(price), _) => price,
            (None, Some(reference)) => reference,
            (None, None) => return Some(RejectReason::NoReferencePrice),
        };

        if let (Some(price), Some(reference)) = (request.price, reference) {
            let (lower, upper) = self.market.collar_band(reference);
            if price < lower || price > upper {
                return Some(RejectReason::OutsideCollar);
            }
        }

        match notional(judged_at, request.qty) {
            None => return Some(RejectReason::NotionalOverflow),
            Some(value) if value < self.market.min_notional => {
                return Some(RejectReason::BelowMinNotional)
            }
            Some(_) => {}
        }
        None
    }

    fn would_cross(&self, side: Side, price: Price) -> bool {
        match self.book.ladder_for(side.opposite()).best_price() {
            Some(best) => crosses(side, Some(price), best),
            None => false,
        }
    }

    /// How much a taker could fill, without mutating anything. FOK's dry run.
    ///
    /// THE DRY RUN MUST MODEL SELF-TRADE PREVENTION EXACTLY, because the match
    /// loop does. Counting a maker the loop will never reach makes a FOK promise
    /// a fill it cannot complete, and the FOK then partially fills — which is
    /// the one thing a FOK is defined not to do.
    ///
    /// `CancelTaker` and `CancelBoth` STOP the taker at the first own-account
    /// maker, so nothing behind it is reachable. `CancelMaker` removes that
    /// maker and carries on, so everything behind it is.
    ///
    /// Found by `fok_is_all_or_nothing` over a generated stream; no example
    /// test in this crate had a same-account maker sitting in front of a
    /// reachable one.
    fn fillable_qty(
        &self,
        side: Side,
        limit: Option<Price>,
        account_id: &str,
        stp_mode: StpMode,
    ) -> u128 {
        let mut total: u128 = 0;
        for (price, level) in self.book.ladder_for(side.opposite()).iter_from_best() {
            if !crosses(side, limit, *price) {
                break;
            }
            for order_id in level.iter() {
                let Some(order) = self.book.get(order_id) else {
                    continue;
                };
                if order.account_id == account_id {
                    match stp_mode {
                        // The taker stops here; nothing further is reachable.
                        StpMode::CancelTaker | StpMode::CancelBoth => return total,
                        // The maker is removed and matching continues past it.
                        StpMode::CancelMaker => continue,
                    }
                }
                total += u128::from(order.remaining);
            }
        }
        total
    }
}

/// Does a taker at `limit` cross a resting order at `resting`?
///
/// `None` means a market order with no price of its own — the collar already
/// bounded it, so at this point it crosses whatever is there.
fn crosses(taker_side: Side, limit: Option<Price>, resting: Price) -> bool {
    match limit {
        None => true,
        Some(limit) => match taker_side {
            Side::Buy => resting <= limit,
            Side::Sell => resting >= limit,
        },
    }
}
