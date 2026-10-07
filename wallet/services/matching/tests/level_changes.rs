//! Level changes (ADR-0036 §1): the engine's own account of which price levels
//! a command changed, and what each holds afterwards.
//!
//! The claim under test is that publishing them introduces NO second
//! implementation of the book. A consumer that starts from nothing and applies
//! only level changes, in sequence order, holds the engine's aggregated book
//! after every command — for streams nobody wrote down.

mod common;

use std::collections::BTreeMap;

use common::{market, place, request};
use proptest::prelude::*;
use wallet_matching::book::OrderBook;
use wallet_matching::config::Config;
use wallet_matching::egress::{EventSink, MemorySink};
use wallet_matching::service::Service;
use wallet_matching::types::{
    Command, LevelChange, MarketConfig, MarketStatus, OrderRequest, OrderType, SequencedCommand,
    Side, StpMode, TimeInForce,
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
        collar_bps: 1_000_000,
        status: MarketStatus::Open,
    }
}

/// `(is_buy, price) -> quantity`, levels with nothing resting absent.
type Mirror = BTreeMap<(bool, u64), u128>;

/// What a consumer does with a level change: set, or forget at zero.
fn apply(mirror: &mut Mirror, changes: &[LevelChange]) {
    for change in changes {
        let key = (change.side == Side::Buy, change.price);
        if change.qty == 0 {
            mirror.remove(&key);
        } else {
            mirror.insert(key, change.qty);
        }
    }
}

/// The engine's aggregated book, read the way `GET /v1/book` reads it.
fn aggregated(book: &OrderBook) -> Mirror {
    let mut out = Mirror::new();
    for (is_buy, ladder) in [(true, book.bids()), (false, book.asks())] {
        for (price, level) in ladder.iter_from_best() {
            out.insert((is_buy, *price), level.total_qty());
        }
    }
    out
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
    AmendNth {
        nth: u8,
        price_ticks: u8,
        qty_lots: u8,
    },
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

// Every self-trade mode, not only the gateway's: `cancel_maker` removes
// resting orders at prices no fill names, which is exactly the change a
// consumer deriving levels from events alone would miss.
fn stp() -> impl Strategy<Value = StpMode> {
    prop_oneof![
        Just(StpMode::CancelTaker),
        Just(StpMode::CancelMaker),
        Just(StpMode::CancelBoth),
    ]
}

fn action() -> impl Strategy<Value = Action> {
    prop_oneof![
        8 => (0u8..3, side(), prop::option::of(1u8..20), 1u8..8, tif(), any::<bool>(), stp())
            .prop_map(|(account, side, price_ticks, qty_lots, tif, post_only, stp)| {
                Action::Place { account, side, price_ticks, qty_lots, tif, post_only, stp }
            }),
        2 => (0u8..40).prop_map(Action::CancelNth),
        2 => (0u8..40, 1u8..20, 1u8..8).prop_map(|(nth, price_ticks, qty_lots)| {
            Action::AmendNth { nth, price_ticks, qty_lots }
        }),
    ]
}

fn stream() -> impl Strategy<Value = Vec<SequencedCommand>> {
    prop::collection::vec(action(), 1..80).prop_map(|actions| {
        let mut placed: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for (index, act) in actions.into_iter().enumerate() {
            let seq = index as u64 + 1;
            let nth = |n: u8, placed: &[String]| {
                placed
                    .get(usize::from(n) % placed.len().max(1))
                    .cloned()
                    .unwrap_or_else(|| "o-missing".into())
            };
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
                    let price = price_ticks.map(|p| u64::from(p) * TICK);
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
                            post_only: post_only && price.is_some(),
                            stp_mode: stp,
                            account_id: format!("acct-{account}"),
                        },
                    }
                }
                Action::CancelNth(n) => Command::Cancel {
                    order_id: nth(n, &placed),
                },
                Action::AmendNth {
                    nth: n,
                    price_ticks,
                    qty_lots,
                } => {
                    let order_id = nth(n, &placed);
                    let new_order_id = format!("o-{seq}");
                    placed.push(new_order_id.clone());
                    Command::Amend {
                        order_id,
                        new_order_id,
                        price: u64::from(price_ticks) * TICK,
                        qty: u64::from(qty_lots) * LOT,
                    }
                }
            };
            out.push(SequencedCommand {
                seq,
                timestamp_ms: 1_700_000_000_000 + seq as i64,
                command,
            });
        }
        out
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    /// Applied in order to an empty book, the level changes ARE the book.
    #[test]
    fn level_changes_rebuild_the_aggregated_book_at_every_step(commands in stream()) {
        let mut engine = Engine::new(wide_market());
        let mut mirror = Mirror::new();
        for command in commands {
            let seq = command.seq;
            let _ = engine.apply(command);
            apply(&mut mirror, &engine.take_level_changes());
            prop_assert_eq!(&mirror, &aggregated(engine.book()), "after sequence {}", seq);
        }
    }

    /// Asking for them changes nothing an event consumer can see: the events
    /// are identical whether or not anyone takes the level changes.
    #[test]
    fn taking_level_changes_does_not_change_the_events(commands in stream()) {
        let mut watched = Engine::new(wide_market());
        let mut unwatched = Engine::new(wide_market());
        for command in commands {
            let with = watched.apply(command.clone());
            let _ = watched.take_level_changes();
            let without = unwatched.apply(command);
            prop_assert_eq!(with, without);
        }
        prop_assert_eq!(watched.book(), unwatched.book());
    }

    /// Every reported quantity is the level's quantity now, so a change that
    /// is delivered twice leaves the consumer where it was.
    #[test]
    fn a_redelivered_change_is_harmless(commands in stream()) {
        let mut engine = Engine::new(wide_market());
        let mut mirror = Mirror::new();
        for command in commands {
            let _ = engine.apply(command);
            let changes = engine.take_level_changes();
            apply(&mut mirror, &changes);
            apply(&mut mirror, &changes);
        }
        prop_assert_eq!(mirror, aggregated(engine.book()));
    }
}

#[test]
fn a_level_that_empties_is_reported_at_zero_and_serialises_qty_as_a_string() {
    let mut engine = Engine::new(wide_market());
    let rest = |seq: u64, id: &str, side: Side| SequencedCommand {
        seq,
        timestamp_ms: 1,
        command: place(
            id,
            request(id, side, Some(9 * TICK), 2 * LOT, TimeInForce::GTC),
        ),
    };
    let _ = engine.apply(rest(1, "s-1", Side::Sell));
    assert_eq!(
        engine.take_level_changes(),
        vec![LevelChange {
            side: Side::Sell,
            price: 9 * TICK,
            qty: u128::from(2 * LOT)
        }]
    );
    let _ = engine.apply(rest(2, "b-1", Side::Buy));
    let changes = engine.take_level_changes();
    assert_eq!(
        changes,
        vec![LevelChange {
            side: Side::Sell,
            price: 9 * TICK,
            qty: 0
        }]
    );
    assert_eq!(
        serde_json::to_string(&changes).expect("json"),
        r#"[{"side":"sell","price":9000000,"qty":"0"}]"#
    );
}

#[test]
fn a_command_that_changes_no_level_reports_none() {
    let mut engine = Engine::new(wide_market());
    let _ = engine.apply(SequencedCommand {
        seq: 1,
        timestamp_ms: 1,
        command: Command::Cancel {
            order_id: "nothing".into(),
        },
    });
    assert!(engine.take_level_changes().is_empty());
}

// ------------------------------------------------------------- publication

fn sell(id: &str) -> Command {
    place(
        id,
        request(id, Side::Sell, Some(9_000_000), 1_000_000, TimeInForce::GTC),
    )
}

async fn service(fail: usize) -> (std::sync::Arc<Service>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config::local(dir.path(), market());
    let mut sink = MemorySink::new();
    sink.fail_next(fail);
    let service = Service::recover(&config, EventSink::Memory(sink))
        .await
        .expect("recover");
    (service, dir)
}

/// One `levels` per sequence, PRESENT even when empty: absent means "unknown,
/// take a snapshot", and a rejected command is not unknown.
#[tokio::test]
async fn every_sequence_publishes_its_levels_even_when_there_are_none() {
    let (service, _dir) = service(0).await;
    service.submit(1, sell("s-1")).await.expect("rest");
    service
        .submit(
            2,
            Command::Cancel {
                order_id: "nothing".into(),
            },
        )
        .await
        .expect("a cancel of nothing");

    let levels = service.memory_published_levels().await.expect("memory");
    assert_eq!(levels.len(), 2);
    assert_eq!(levels[0].0, 1);
    assert_eq!(levels[0].1.len(), 1);
    assert_eq!(levels[1], (2, vec![]));
}

/// A command republished after a 503 carries the levels it changed the first
/// time — from the ring here, and after a restart from a journal replay.
#[tokio::test]
async fn a_republished_command_carries_the_same_levels() {
    let (service, _dir) = service(1).await;
    assert!(service.submit(1, sell("s-1")).await.is_err());
    service
        .submit(2, sell("s-2"))
        .await
        .expect("publishes both");

    let levels = service.memory_published_levels().await.expect("memory");
    let seqs: Vec<u64> = levels.iter().map(|(seq, _)| *seq).collect();
    assert_eq!(seqs, vec![1, 2]);
    // Absolute, at each sequence: one lot resting, then two.
    assert_eq!(levels[0].1[0].qty, 1_000_000);
    assert_eq!(levels[1].1[0].qty, 2_000_000);
}

#[tokio::test]
async fn recovery_republishes_levels_from_the_journal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config::local(dir.path(), market());
    {
        let mut sink = MemorySink::new();
        sink.fail_next(2);
        let service = Service::recover(&config, EventSink::Memory(sink))
            .await
            .expect("recover");
        // Journaled, never published: the process dies with the stream behind.
        assert!(service.submit(1, sell("s-1")).await.is_err());
        assert!(service.submit(2, sell("s-2")).await.is_err());
    }
    let restarted = Service::recover(&config, EventSink::Memory(MemorySink::new()))
        .await
        .expect("recover");
    let levels = restarted.memory_published_levels().await.expect("memory");
    assert_eq!(
        levels
            .iter()
            .map(|(seq, changes)| (*seq, changes[0].qty))
            .collect::<Vec<_>>(),
        vec![(1, 1_000_000), (2, 2_000_000)]
    );
}
