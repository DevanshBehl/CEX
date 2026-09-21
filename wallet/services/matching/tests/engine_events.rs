//! Example tests for the cases a generated stream cannot express clearly.

mod common;

use common::{market, place, request};
use wallet_matching::types::{
    Command, Event, MarketStatus, OrderType, RejectReason, SequencedCommand, Side, StpMode,
    TimeInForce,
};
use wallet_matching::Engine;

fn seq(n: u64, command: Command) -> SequencedCommand {
    SequencedCommand {
        seq: n,
        timestamp_ms: 1_700_000_000_000 + n as i64,
        command,
    }
}

fn engine() -> Engine {
    Engine::new(market())
}

#[test]
fn a_resting_order_is_accepted_with_its_full_quantity() {
    let mut e = engine();
    let events = e.apply(seq(
        1,
        place(
            "o-1",
            request(
                "a",
                Side::Buy,
                Some(10_000_000),
                2_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    assert!(matches!(
        events.as_slice(),
        [Event::Accepted {
            resting_qty: 2_000_000,
            ..
        }]
    ));
}

#[test]
fn a_full_fill_emits_the_fills_then_accepted_with_nothing_resting() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "maker",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                2_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let events = e.apply(seq(
        2,
        place(
            "taker",
            request(
                "b",
                Side::Buy,
                Some(10_000_000),
                2_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    match events.as_slice() {
        [Event::Fill(fill), Event::Accepted { resting_qty, .. }] => {
            assert_eq!(fill.qty, 2_000_000);
            assert_eq!(fill.price, 10_000_000);
            assert_eq!(fill.taker_side, Side::Buy);
            assert_eq!(fill.taker_order_id, "taker");
            assert_eq!(fill.maker_order_id, "maker");
            // Carried, and unpopulated until S4 (ADR-0029).
            assert_eq!(fill.maker_fee, None);
            assert_eq!(fill.taker_fee, None);
            assert_eq!(*resting_qty, 0);
        }
        other => panic!("unexpected: {other:?}"),
    }
}

/// The distinction S3 depends on: a rejection of a PLACEMENT releases the whole
/// order, but a `Rejected{UnknownOrder}` answering a CANCEL does not — the order
/// is already gone, and releasing again would double-release a hold.
#[test]
fn cancelling_an_already_filled_order_is_rejected_and_releases_nothing() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "maker",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        2,
        place(
            "taker",
            request(
                "b",
                Side::Buy,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let events = e.apply(seq(
        3,
        Command::Cancel {
            order_id: "maker".into(),
        },
    ));
    assert!(matches!(
        events.as_slice(),
        [Event::Rejected {
            reason: RejectReason::UnknownOrder,
            ..
        }]
    ));
}

#[test]
fn a_cancel_for_an_order_that_never_existed_is_never_silently_successful() {
    let mut e = engine();
    let events = e.apply(seq(
        1,
        Command::Cancel {
            order_id: "ghost".into(),
        },
    ));
    assert!(matches!(
        events.as_slice(),
        [Event::Rejected {
            reason: RejectReason::UnknownOrder,
            ..
        }]
    ));
}

#[test]
fn post_only_rejects_rather_than_converting_into_a_taker() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "maker",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let mut r = request(
        "b",
        Side::Buy,
        Some(10_000_000),
        1_000_000,
        TimeInForce::GTC,
    );
    r.post_only = true;
    let events = e.apply(seq(2, place("po", r)));
    assert!(matches!(
        events.as_slice(),
        [Event::Rejected {
            reason: RejectReason::PostOnlyWouldCross,
            ..
        }]
    ));
    assert_eq!(e.book().open_order_count(), 1, "the maker is untouched");
}

#[test]
fn an_ioc_remainder_expires_and_never_rests() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "maker",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let events = e.apply(seq(
        2,
        place(
            "ioc",
            request(
                "b",
                Side::Buy,
                Some(10_000_000),
                3_000_000,
                TimeInForce::IOC,
            ),
        ),
    ));
    match events.as_slice() {
        [Event::Fill(fill), Event::Expired { remaining_qty, .. }] => {
            assert_eq!(fill.qty, 1_000_000);
            assert_eq!(*remaining_qty, 2_000_000);
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(e.book().get("ioc").is_none());
}

/// A market order that became a resting limit order at the collar edge is an
/// order the client did not place.
#[test]
fn a_market_remainder_is_cancelled_never_rested() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "maker",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        2,
        place(
            "b1",
            request("c", Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
        ),
    ));
    let events = e.apply(seq(
        3,
        place(
            "mkt",
            request("b", Side::Buy, None, 5_000_000, TimeInForce::IOC),
        ),
    ));
    assert!(events.iter().any(|e| matches!(e, Event::Expired { .. })));
    assert!(e.book().get("mkt").is_none());
}

#[test]
fn a_market_order_against_a_book_with_no_reference_is_rejected() {
    let mut e = engine();
    let events = e.apply(seq(
        1,
        place(
            "mkt",
            request("a", Side::Buy, None, 1_000_000, TimeInForce::IOC),
        ),
    ));
    assert!(matches!(
        events.as_slice(),
        [Event::Rejected {
            reason: RejectReason::NoReferencePrice,
            ..
        }]
    ));
}

#[test]
fn a_fok_that_cannot_fill_entirely_expires_without_touching_the_book() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "maker",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let events = e.apply(seq(
        2,
        place(
            "fok",
            request(
                "b",
                Side::Buy,
                Some(10_000_000),
                5_000_000,
                TimeInForce::FOK,
            ),
        ),
    ));
    assert!(matches!(
        events.as_slice(),
        [Event::Expired {
            remaining_qty: 5_000_000,
            ..
        }]
    ));
    assert_eq!(
        e.book().get("maker").map(|o| o.remaining),
        Some(1_000_000),
        "a rejected FOK must not have consumed the maker"
    );
}

/// The regression for the bug `fok_is_all_or_nothing` found: a same-account
/// maker in front of a reachable one made the dry run over-count.
#[test]
fn a_fok_does_not_count_liquidity_that_self_trade_prevention_will_block() {
    let mut e = engine();
    // Best ask is our own; behind it sits somebody else's.
    e.apply(seq(
        1,
        place(
            "own",
            request(
                "me",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        2,
        place(
            "other",
            request(
                "them",
                Side::Sell,
                Some(11_000_000),
                5_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let mut r = request(
        "me",
        Side::Buy,
        Some(11_000_000),
        3_000_000,
        TimeInForce::FOK,
    );
    r.stp_mode = StpMode::CancelTaker;
    let events = e.apply(seq(3, place("fok", r)));
    // CancelTaker stops at our own maker, so nothing behind it is reachable and
    // the FOK cannot fill at all.
    assert!(
        matches!(events.as_slice(), [Event::Expired { .. }]),
        "expected a clean expiry, got {events:?}"
    );
    assert!(
        !events.iter().any(|e| matches!(e, Event::Fill(_))),
        "a FOK must never partially fill"
    );
}

#[test]
fn cancel_maker_removes_the_maker_and_keeps_matching() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "own",
            request(
                "me",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        2,
        place(
            "other",
            request(
                "them",
                Side::Sell,
                Some(11_000_000),
                5_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let mut r = request(
        "me",
        Side::Buy,
        Some(11_000_000),
        2_000_000,
        TimeInForce::IOC,
    );
    r.stp_mode = StpMode::CancelMaker;
    let events = e.apply(seq(3, place("t", r)));
    // Our own maker is cancelled (an event, because S3 releases its hold), and
    // matching continues into the other account's liquidity.
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::Cancelled { order_id, .. } if order_id == "own")));
    assert!(events.iter().any(|e| matches!(e, Event::Fill(_))));
}

#[test]
fn a_halted_market_refuses_placements_but_still_accepts_cancels() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "resting",
            request(
                "a",
                Side::Buy,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.set_status(MarketStatus::Halted);

    let placed = e.apply(seq(
        2,
        place(
            "new",
            request(
                "a",
                Side::Buy,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    assert!(matches!(
        placed.as_slice(),
        [Event::Rejected {
            reason: RejectReason::MarketNotOpen,
            ..
        }]
    ));

    // A halt stops price formation; it does not take away the exit (ADR-0027).
    let cancelled = e.apply(seq(
        3,
        Command::Cancel {
            order_id: "resting".into(),
        },
    ));
    assert!(matches!(cancelled.as_slice(), [Event::Cancelled { .. }]));
}

#[test]
fn an_amend_loses_time_priority() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "first",
            request(
                "a",
                Side::Buy,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        2,
        place(
            "second",
            request(
                "b",
                Side::Buy,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    let events = e.apply(seq(
        3,
        Command::Amend {
            order_id: "first".into(),
            new_order_id: "first-v2".into(),
            price: 10_000_000,
            qty: 1_000_000,
        },
    ));
    assert!(matches!(events[0], Event::Cancelled { .. }));

    // "second" now has priority over the amended order.
    let queue = e.book().live_ids_at(Side::Buy, 10_000_000);
    assert_eq!(queue, vec!["second".to_string(), "first-v2".to_string()]);
}

#[test]
fn an_amend_for_an_unknown_order_changes_nothing() {
    let mut e = engine();
    let events = e.apply(seq(
        1,
        Command::Amend {
            order_id: "ghost".into(),
            new_order_id: "ghost-v2".into(),
            price: 10_000_000,
            qty: 1_000_000,
        },
    ));
    assert!(matches!(
        events.as_slice(),
        [Event::Rejected {
            reason: RejectReason::UnknownOrder,
            ..
        }]
    ));
    assert_eq!(e.book().open_order_count(), 0);
}

#[test]
fn a_duplicate_order_id_is_rejected() {
    let mut e = engine();
    let r = request(
        "a",
        Side::Buy,
        Some(10_000_000),
        1_000_000,
        TimeInForce::GTC,
    );
    e.apply(seq(1, place("dup", r.clone())));
    let events = e.apply(seq(2, place("dup", r)));
    assert!(matches!(
        events.as_slice(),
        [Event::Rejected {
            reason: RejectReason::DuplicateClientOrderId,
            ..
        }]
    ));
}

#[test]
fn structural_violations_are_rejected() {
    let mut e = engine();
    let cases: Vec<(&str, _, RejectReason)> = vec![
        (
            "off tick",
            request(
                "a",
                Side::Buy,
                Some(10_000_001),
                1_000_000,
                TimeInForce::GTC,
            ),
            RejectReason::TickViolation,
        ),
        (
            "off lot",
            request(
                "a",
                Side::Buy,
                Some(10_000_000),
                1_000_001,
                TimeInForce::GTC,
            ),
            RejectReason::LotViolation,
        ),
        (
            "zero quantity",
            request("a", Side::Buy, Some(10_000_000), 0, TimeInForce::GTC),
            RejectReason::QuantityNotPositive,
        ),
    ];
    for (index, (name, r, expected)) in cases.into_iter().enumerate() {
        let events = e.apply(seq(index as u64 + 1, place(&format!("o-{index}"), r)));
        match events.as_slice() {
            [Event::Rejected { reason, .. }] => assert_eq!(*reason, expected, "{name}"),
            other => panic!("{name}: unexpected {other:?}"),
        }
    }
}

#[test]
fn a_limit_order_missing_its_price_is_rejected() {
    let mut e = engine();
    let mut r = request("a", Side::Buy, None, 1_000_000, TimeInForce::GTC);
    r.order_type = OrderType::Limit;
    let events = e.apply(seq(1, place("o", r)));
    assert!(matches!(
        events.as_slice(),
        [Event::Rejected {
            reason: RejectReason::PriceRequired,
            ..
        }]
    ));
}

// --- tombstones -----------------------------------------------------------
//
// A cancel is O(1): it forgets the order and decrements the level's live total
// without scanning the queue to splice it out. The id stays behind as a
// tombstone until matching prunes it or the level is dropped. These tests pin
// the behaviour that makes that safe.

#[test]
fn cancelling_the_front_of_a_level_leaves_the_rest_in_priority_order() {
    let mut e = engine();
    for i in 0..5u64 {
        e.apply(seq(
            i + 1,
            place(
                &format!("o-{i}"),
                request(
                    &format!("a-{i}"),
                    Side::Buy,
                    Some(10_000_000),
                    1_000_000,
                    TimeInForce::GTC,
                ),
            ),
        ));
    }
    e.apply(seq(
        10,
        Command::Cancel {
            order_id: "o-0".into(),
        },
    ));
    e.apply(seq(
        11,
        Command::Cancel {
            order_id: "o-2".into(),
        },
    ));

    assert_eq!(
        e.book().live_ids_at(Side::Buy, 10_000_000),
        vec!["o-1".to_string(), "o-3".into(), "o-4".into()]
    );
    assert!(e.book().invariants_hold());
}

#[test]
fn a_level_whose_live_quantity_reaches_zero_leaves_the_book() {
    let mut e = engine();
    for i in 0..3u64 {
        e.apply(seq(
            i + 1,
            place(
                &format!("o-{i}"),
                request(
                    "a",
                    Side::Buy,
                    Some(10_000_000),
                    1_000_000,
                    TimeInForce::GTC,
                ),
            ),
        ));
    }
    assert_eq!(e.book().bids().depth(), 1);
    for i in 0..3u64 {
        e.apply(seq(
            10 + i,
            Command::Cancel {
                order_id: format!("o-{i}"),
            },
        ));
    }
    // Not merely empty of live orders — gone, or best_bid would name a price
    // nothing can trade at.
    assert_eq!(e.book().bids().depth(), 0);
    assert_eq!(e.book().best_bid(), None);
    assert!(e.book().invariants_hold());
}

#[test]
fn matching_skips_tombstones_and_fills_the_next_live_maker() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "dead",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        2,
        place(
            "alive",
            request(
                "b",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        3,
        Command::Cancel {
            order_id: "dead".into(),
        },
    ));

    let events = e.apply(seq(
        4,
        place(
            "taker",
            request(
                "c",
                Side::Buy,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    match events.as_slice() {
        [Event::Fill(fill), Event::Accepted { .. }] => {
            assert_eq!(fill.maker_order_id, "alive", "a tombstone was matched");
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(e.book().invariants_hold());
}

/// A FOK's dry run walks the queue, so it must not count tombstones as
/// available liquidity — that would promise a fill that is not there.
#[test]
fn a_fok_does_not_count_tombstoned_liquidity() {
    let mut e = engine();
    e.apply(seq(
        1,
        place(
            "dead",
            request(
                "a",
                Side::Sell,
                Some(10_000_000),
                5_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        2,
        place(
            "alive",
            request(
                "b",
                Side::Sell,
                Some(10_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
    ));
    e.apply(seq(
        3,
        Command::Cancel {
            order_id: "dead".into(),
        },
    ));

    let events = e.apply(seq(
        4,
        place(
            "fok",
            request(
                "c",
                Side::Buy,
                Some(10_000_000),
                3_000_000,
                TimeInForce::FOK,
            ),
        ),
    ));
    assert!(
        matches!(events.as_slice(), [Event::Expired { .. }]),
        "the FOK counted a cancelled order as available: {events:?}"
    );
}
