//! Generated command streams, not fixtures.
//!
//! Fixtures test what was imagined. Everything in this file is asserted over
//! streams nobody wrote down (prompt_phase_s1.md §13).

use proptest::prelude::*;
use std::collections::HashMap;
use wallet_matching::types::{
    Command, Event, MarketConfig, MarketStatus, OrderRequest, OrderType, SequencedCommand, Side,
    StpMode, TimeInForce,
};
use wallet_matching::Engine;

const TICK: u64 = 1_000_000;
const LOT: u64 = 1_000_000;

fn wide_market() -> MarketConfig {
    MarketConfig {
        id: "devnet:SOL-USDC".into(),
        tick_size: TICK,
        lot_size: LOT,
        min_notional: 1,
        // Deliberately enormous, so the collar does not dominate generated
        // streams and mask the properties this file is actually about.
        collar_bps: 1_000_000,
        status: MarketStatus::Open,
    }
}

#[derive(Debug, Clone)]
enum Action {
    Place {
        account: u8,
        side: Side,
        price_ticks: Option<u8>,
        qty_lots: u8,
        tif: TimeInForce,
        post_only: bool,
        stp: StpMode,
    },
    CancelNth(u8),
}

fn side() -> impl Strategy<Value = Side> {
    prop_oneof![Just(Side::Buy), Just(Side::Sell)]
}

fn tif() -> impl Strategy<Value = TimeInForce> {
    prop_oneof![
        6 => Just(TimeInForce::GTC),
        2 => Just(TimeInForce::IOC),
        1 => Just(TimeInForce::FOK),
    ]
}

fn stp() -> impl Strategy<Value = StpMode> {
    prop_oneof![
        Just(StpMode::CancelTaker),
        Just(StpMode::CancelMaker),
        Just(StpMode::CancelBoth),
    ]
}

fn action() -> impl Strategy<Value = Action> {
    prop_oneof![
        8 => (0u8..3, side(), prop::option::of(1u8..20), 1u8..8, tif(), any::<bool>(), stp()).prop_map(
            |(account, side, price_ticks, qty_lots, tif, post_only, stp)| Action::Place {
                account,
                side,
                price_ticks,
                qty_lots,
                tif,
                post_only,
                stp,
            }
        ),
        2 => (0u8..40).prop_map(Action::CancelNth),
    ]
}

fn stream() -> impl Strategy<Value = Vec<SequencedCommand>> {
    prop::collection::vec(action(), 1..60).prop_map(|actions| {
        let mut placed: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for (index, act) in actions.into_iter().enumerate() {
            let seq = index as u64 + 1;
            let timestamp_ms = 1_700_000_000_000 + seq as i64;
            let command = match act {
                Action::Place {
                    account,
                    side,
                    price_ticks,
                    qty_lots,
                    tif,
                    post_only,
                    stp,
                } => {
                    let order_id = format!("o-{seq}");
                    placed.push(order_id.clone());
                    // A market order carries no price; post-only requires a limit.
                    let price = price_ticks.map(|p| u64::from(p) * TICK);
                    let post_only = post_only && price.is_some();
                    Command::Place {
                        order_id,
                        request: OrderRequest {
                            client_order_id: format!("c-{seq}"),
                            side,
                            order_type: if price.is_some() {
                                OrderType::Limit
                            } else {
                                OrderType::Market
                            },
                            time_in_force: tif,
                            price,
                            qty: u64::from(qty_lots) * LOT,
                            post_only,
                            stp_mode: stp,
                            account_id: format!("acct-{account}"),
                        },
                    }
                }
                Action::CancelNth(n) => {
                    let order_id = placed
                        .get(usize::from(n) % placed.len().max(1))
                        .cloned()
                        .unwrap_or_else(|| "o-missing".into());
                    Command::Cancel { order_id }
                }
            };
            out.push(SequencedCommand {
                seq,
                timestamp_ms,
                command,
            });
        }
        out
    })
}

fn run(commands: &[SequencedCommand]) -> (Engine, Vec<Event>) {
    let mut engine = Engine::new(wide_market());
    let mut events = Vec::new();
    for command in commands {
        events.extend(engine.apply(command.clone()));
    }
    (engine, events)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    /// Rule 119: this test exists before the book does. Determinism lost on a
    /// Tuesday is found in S4, with a month of commits to bisect.
    #[test]
    fn two_engines_fed_one_stream_emit_identical_events(commands in stream()) {
        let (a_engine, a) = run(&commands);
        let (b_engine, b) = run(&commands);
        prop_assert_eq!(
            bincode::serialize(&a).unwrap(),
            bincode::serialize(&b).unwrap()
        );
        prop_assert_eq!(a_engine.book(), b_engine.book());
    }

    #[test]
    fn the_book_is_never_crossed(commands in stream()) {
        let mut engine = Engine::new(wide_market());
        for command in &commands {
            engine.apply(command.clone());
            if let (Some(bid), Some(ask)) = (engine.book().best_bid(), engine.book().best_ask()) {
                prop_assert!(bid < ask, "crossed book: bid {} >= ask {}", bid, ask);
            }
        }
    }

    /// Every level total matches its queue, every index entry matches its
    /// ladder, no empty level remains, and price-time priority holds.
    #[test]
    fn every_book_invariant_holds_after_every_command(commands in stream()) {
        let mut engine = Engine::new(wide_market());
        for command in &commands {
            engine.apply(command.clone());
            prop_assert!(engine.book().invariants_hold());
        }
    }

    /// Rule 130. A command that vanished is, in S3, a hold reserved forever.
    #[test]
    fn every_command_produces_at_least_one_event(commands in stream()) {
        let mut engine = Engine::new(wide_market());
        for command in &commands {
            let events = engine.apply(command.clone());
            prop_assert!(!events.is_empty(), "no event for {:?}", command);
        }
    }

    /// Quantity is conserved: what was placed is filled, still resting, or
    /// explicitly released.
    #[test]
    fn quantity_is_conserved_for_every_order(commands in stream()) {
        let (engine, events) = run(&commands);

        let mut placed: HashMap<String, u64> = HashMap::new();
        let mut place_seq: HashMap<String, u64> = HashMap::new();
        for command in &commands {
            if let Command::Place { order_id, request } = &command.command {
                placed.insert(order_id.clone(), request.qty);
                place_seq.insert(order_id.clone(), command.seq);
            }
        }

        let mut filled: HashMap<String, u128> = HashMap::new();
        let mut released: HashMap<String, u128> = HashMap::new();
        for event in &events {
            match event {
                Event::Fill(fill) => {
                    *filled.entry(fill.taker_order_id.clone()).or_default() += u128::from(fill.qty);
                    *filled.entry(fill.maker_order_id.clone()).or_default() += u128::from(fill.qty);
                }
                Event::Rejected { order_id, seq, .. } => {
                    // Only a rejection of the PLACEMENT releases the whole
                    // order. A Rejected{UnknownOrder} answering a cancel means
                    // the order is already gone — filled, or cancelled earlier —
                    // and releasing on it would double-release. S3 must make
                    // the same distinction, which is why it is asserted
                    // separately in engine_events.rs.
                    if place_seq.get(order_id) == Some(seq) {
                        if let Some(qty) = placed.get(order_id) {
                            released.insert(order_id.clone(), u128::from(*qty));
                        }
                    }
                }
                Event::Cancelled { order_id, remaining_qty, .. }
                | Event::Expired { order_id, remaining_qty, .. } => {
                    *released.entry(order_id.clone()).or_default() += u128::from(*remaining_qty);
                }
                // Neither moves quantity: an accepted order still holds what
                // it placed, and a status change is not about an order at all.
                Event::Accepted { .. } | Event::StatusChanged { .. } => {}
            }
        }

        for (order_id, qty) in &placed {
            let resting = engine
                .book()
                .get(order_id)
                .map(|o| u128::from(o.remaining))
                .unwrap_or(0);
            let accounted = filled.get(order_id).copied().unwrap_or(0)
                + released.get(order_id).copied().unwrap_or(0)
                + resting;
            prop_assert_eq!(
                accounted,
                u128::from(*qty),
                "order {} placed {} but accounted {}",
                order_id,
                qty,
                accounted
            );
        }
    }

    /// Rule 125. A buy never fills above its limit; a sell never below.
    #[test]
    fn no_trade_executes_outside_its_limit_price(commands in stream()) {
        let (_, events) = run(&commands);
        let mut limits: HashMap<String, (Side, Option<u64>)> = HashMap::new();
        for command in &commands {
            if let Command::Place { order_id, request } = &command.command {
                limits.insert(order_id.clone(), (request.side, request.price));
            }
        }
        for event in &events {
            if let Event::Fill(fill) = event {
                if let Some((side, Some(limit))) = limits.get(&fill.taker_order_id) {
                    match side {
                        Side::Buy => prop_assert!(fill.price <= *limit),
                        Side::Sell => prop_assert!(fill.price >= *limit),
                    }
                }
                if let Some((side, Some(limit))) = limits.get(&fill.maker_order_id) {
                    match side {
                        Side::Buy => prop_assert!(fill.price <= *limit),
                        Side::Sell => prop_assert!(fill.price >= *limit),
                    }
                }
            }
        }
    }

    /// Rule 128. Post-only rejects rather than converting into a taker.
    #[test]
    fn a_post_only_order_never_takes(commands in stream()) {
        let (_, events) = run(&commands);
        let mut post_only: HashMap<String, bool> = HashMap::new();
        for command in &commands {
            if let Command::Place { order_id, request } = &command.command {
                post_only.insert(order_id.clone(), request.post_only);
            }
        }
        for event in &events {
            if let Event::Fill(fill) = event {
                prop_assert!(
                    !post_only.get(&fill.taker_order_id).copied().unwrap_or(false),
                    "post-only order {} was the taker",
                    fill.taker_order_id
                );
            }
        }
    }

    /// Rule 129. A FOK fills entirely or not at all — never partially.
    #[test]
    fn fok_is_all_or_nothing(commands in stream()) {
        let (_, events) = run(&commands);
        let mut fok: HashMap<String, u64> = HashMap::new();
        for command in &commands {
            if let Command::Place { order_id, request } = &command.command {
                if request.time_in_force == TimeInForce::FOK {
                    fok.insert(order_id.clone(), request.qty);
                }
            }
        }
        let mut taken: HashMap<String, u128> = HashMap::new();
        for event in &events {
            if let Event::Fill(fill) = event {
                *taken.entry(fill.taker_order_id.clone()).or_default() += u128::from(fill.qty);
            }
        }
        for (order_id, qty) in &fok {
            let got = taken.get(order_id).copied().unwrap_or(0);
            prop_assert!(
                got == 0 || got == u128::from(*qty),
                "FOK {} partially filled: {} of {}",
                order_id,
                got,
                qty
            );
        }
    }

    /// Rule 127. A cancel removes exactly one order and disturbs no other.
    #[test]
    fn a_cancel_removes_exactly_one_order(commands in stream()) {
        let mut engine = Engine::new(wide_market());
        for command in &commands {
            let before = engine.book().open_order_count();
            // Live ids only: a cancelled order leaves a tombstone in its queue
            // until the level is matched or dropped, which is what makes cancel
            // O(1) rather than a scan.
            let before_ids: Vec<String> = engine.book().live_ids();
            let events = engine.apply(command.clone());
            if !matches!(command.command, Command::Cancel { .. }) {
                continue;
            }
            let after = engine.book().open_order_count();
            match events.first() {
                Some(Event::Cancelled { order_id, .. }) => {
                    prop_assert_eq!(after, before - 1);
                    let mut expected = before_ids.clone();
                    expected.retain(|id| id != order_id);
                    prop_assert_eq!(expected, engine.book().live_ids());
                }
                _ => prop_assert_eq!(after, before),
            }
        }
    }
}
