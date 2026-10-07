//! Egress against a REAL Redis.
//!
//! What these check — stream semantics, trimming, reconnect, what survives a
//! wipe — are properties of Redis itself, exactly as the wallet's integration
//! tests use a real PostgreSQL rather than a mock.
//!
//! Skipped when `MATCHING_TEST_REDIS_URL` is unset, so a developer without
//! infrastructure still gets a green `cargo test`. CI sets it.

mod common;

use common::{market, place, request};
use wallet_matching::config::Config;
use wallet_matching::egress::{EventSink, RedisSink};
use wallet_matching::service::Service;
use wallet_matching::types::{event_indices, Event, Side, TimeInForce};

fn redis_url() -> Option<String> {
    std::env::var("MATCHING_TEST_REDIS_URL")
        .ok()
        .filter(|v| !v.is_empty())
}

macro_rules! require_redis {
    () => {
        match redis_url() {
            Some(url) => url,
            None => {
                eprintln!("skipped: MATCHING_TEST_REDIS_URL is unset");
                return;
            }
        }
    };
}

async fn drain(url: &str, stream: &str) -> Vec<(u64, String)> {
    let client = redis::Client::open(url).expect("client");
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("connect");
    let entries: Vec<(String, Vec<(String, String)>)> = redis::cmd("XRANGE")
        .arg(stream)
        .arg("-")
        .arg("+")
        .query_async(&mut conn)
        .await
        .unwrap_or_default();
    entries
        .into_iter()
        .map(|(_, fields)| {
            let map: std::collections::HashMap<_, _> = fields.into_iter().collect();
            (
                map.get("seq").and_then(|s| s.parse().ok()).unwrap_or(0),
                map.get("event").cloned().unwrap_or_default(),
            )
        })
        .collect()
}

async fn reset(url: &str, stream: &str) {
    let client = redis::Client::open(url).expect("client");
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("connect");
    let _: i64 = redis::cmd("DEL")
        .arg(stream)
        .query_async(&mut conn)
        .await
        .unwrap_or(0);
}

fn config(dir: &std::path::Path, stream: &str) -> Config {
    Config {
        stream_name: stream.to_string(),
        ..Config::local(dir, market())
    }
}

#[tokio::test]
async fn every_event_reaches_the_stream_carrying_its_engine_sequence() {
    let url = require_redis!();
    let stream = "test:events:sequence";
    reset(&url, stream).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), stream);
    let sink = RedisSink::connect(&url, 100_000).await.expect("connect");
    let service = Service::recover(&config, EventSink::Redis(Box::new(sink)))
        .await
        .expect("recover");

    for i in 0..5u64 {
        service
            .submit(
                1_700_000_000_000,
                place(
                    &format!("o-{i}"),
                    request("a", Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
                ),
            )
            .await
            .expect("submit");
    }

    let published = drain(&url, stream).await;
    assert_eq!(published.len(), 5);
    // A consumer tracks position by ENGINE sequence, never by Redis id.
    let seqs: Vec<u64> = published.iter().map(|(seq, _)| *seq).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
}

/// Every entry carries `idx`, and `(seq, idx)` on the stream is exactly what a
/// consumer recovering through `GET /v1/events` derives by position (ADR-0034
/// §1). A crossing order makes one sequence emit several events.
#[tokio::test]
async fn every_entry_carries_its_event_key() {
    let url = require_redis!();
    let stream = "test:events:keys";
    reset(&url, stream).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), stream);
    let sink = RedisSink::connect(&url, 100_000).await.expect("connect");
    let service = Service::recover(&config, EventSink::Redis(Box::new(sink)))
        .await
        .expect("recover");

    for (id, side) in [("s-1", Side::Sell), ("s-2", Side::Sell), ("b-1", Side::Buy)] {
        let qty = if side == Side::Buy {
            2_000_000
        } else {
            1_000_000
        };
        service
            .submit(
                1_700_000_000_000,
                place(
                    id,
                    request(id, side, Some(9_000_000), qty, TimeInForce::GTC),
                ),
            )
            .await
            .expect("submit");
    }

    let client = redis::Client::open(url.as_str()).expect("client");
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("connect");
    let entries: Vec<(String, Vec<(String, String)>)> = redis::cmd("XRANGE")
        .arg(stream)
        .arg("-")
        .arg("+")
        .query_async(&mut conn)
        .await
        .expect("xrange");
    let on_stream: Vec<(u64, u32)> = entries
        .into_iter()
        .map(|(_, fields)| {
            let map: std::collections::HashMap<_, _> = fields.into_iter().collect();
            (
                map["seq"].parse().expect("seq"),
                map["idx"].parse().expect("idx"),
            )
        })
        .collect();
    // Sells rest (one event each); the buy fills twice and is accepted.
    assert_eq!(on_stream, vec![(1, 0), (2, 0), (3, 0), (3, 1), (3, 2)]);

    let reemitted = service.events_since(0, 1_000).await.expect("events");
    let derived: Vec<(u64, u32)> = reemitted
        .iter()
        .map(Event::seq)
        .zip(event_indices(&reemitted))
        .collect();
    assert_eq!(derived, on_stream);
}

/// Publication order is sequence order, which is what hand-over-hand locking in
/// `Service::submit` buys. A settlement worker that saw a disposition before the
/// fill that preceded it would release a hold before consuming it.
#[tokio::test]
async fn events_arrive_in_sequence_order_under_concurrency() {
    let url = require_redis!();
    let stream = "test:events:ordering";
    reset(&url, stream).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), stream);
    let sink = RedisSink::connect(&url, 100_000).await.expect("connect");
    let service = Service::recover(&config, EventSink::Redis(Box::new(sink)))
        .await
        .expect("recover");

    let mut handles = Vec::new();
    for i in 0..25u64 {
        let service = service.clone();
        handles.push(tokio::spawn(async move {
            service
                .submit(
                    1_700_000_000_000,
                    place(
                        &format!("o-{i}"),
                        request("a", Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
                    ),
                )
                .await
        }));
    }
    for handle in handles {
        handle.await.expect("join").expect("submit");
    }

    let seqs: Vec<u64> = drain(&url, stream)
        .await
        .into_iter()
        .map(|(s, _)| s)
        .collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(seqs, sorted, "events were published out of sequence order");
    assert_eq!(seqs.len(), 25);
}

/// ADR-0030's crash window: the command is durable, the events are not
/// published. Recovery re-derives them from the journal.
#[tokio::test]
async fn a_wiped_stream_is_rebuilt_from_the_journal_on_restart() {
    let url = require_redis!();
    let stream = "test:events:recovery";
    reset(&url, stream).await;

    let dir = tempfile::tempdir().expect("tempdir");
    // Never flush the watermark during the run, so the restart sees a gap —
    // which is exactly what a hard kill leaves behind.
    let config = Config {
        watermark_sync_every: u64::MAX,
        ..config(dir.path(), stream)
    };

    {
        let sink = RedisSink::connect(&url, 100_000).await.expect("connect");
        let service = Service::recover(&config, EventSink::Redis(Box::new(sink)))
            .await
            .expect("recover");
        for i in 0..4u64 {
            service
                .submit(
                    1_700_000_000_000,
                    place(
                        &format!("o-{i}"),
                        request("a", Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
                    ),
                )
                .await
                .expect("submit");
        }
        // Dropped without flushing: the process "crashed".
    }

    reset(&url, stream).await;
    assert!(
        drain(&url, stream).await.is_empty(),
        "stream should be wiped"
    );

    let sink = RedisSink::connect(&url, 100_000).await.expect("connect");
    let service = Service::recover(&config, EventSink::Redis(Box::new(sink)))
        .await
        .expect("recover");
    assert_eq!(service.last_seq().await, 4);

    let seqs: Vec<u64> = drain(&url, stream)
        .await
        .into_iter()
        .map(|(s, _)| s)
        .collect();
    assert_eq!(
        seqs,
        vec![1, 2, 3, 4],
        "recovery must republish everything the stream lost"
    );
}

/// An unreachable Redis is a 503 and never a lost event: the command stays in
/// the journal and the next recovery republishes it.
#[tokio::test]
async fn an_unreachable_redis_refuses_the_command_rather_than_dropping_its_events() {
    let _ = require_redis!();
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "test:events:unreachable");

    // A port nothing is listening on, with a short timeout so the test measures
    // the refusal rather than the connection manager's backoff. Without the
    // timeout this took 473 seconds — and in production it would have held the
    // egress lock for all of it, stalling every command behind it.
    let sink = RedisSink::connect_with_timeout(
        "redis://127.0.0.1:1",
        100_000,
        std::time::Duration::from_millis(250),
    )
    .await;
    let Ok(sink) = sink else {
        return; // refused at connect time, which is also correct
    };
    let service = Service::recover(&config, EventSink::Redis(Box::new(sink)))
        .await
        .expect("recover");

    let started = std::time::Instant::now();
    let result = service
        .submit(
            1_700_000_000_000,
            place(
                "o-1",
                request("a", Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
            ),
        )
        .await;
    assert!(
        result.is_err(),
        "an unconfirmed publish must not be acknowledged"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "the publish hung for {:?}: the egress lock would be held for all of it",
        started.elapsed()
    );

    // The command still happened: it is in the journal, which is what makes the
    // caller's 503 ambiguous rather than a failure to act.
    assert_eq!(service.journal_len().expect("journal"), 1);
}

/// The LAST entry of each sequence carries `levels` (ADR-0036 §1): the levels
/// that command changed, as absolute quantities. Earlier entries of the same
/// sequence do not, so a consumer applies them only once it has every event.
#[tokio::test]
async fn the_last_entry_of_each_sequence_carries_its_level_changes() {
    let url = require_redis!();
    let stream = "test:events:levels";
    reset(&url, stream).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), stream);
    let sink = RedisSink::connect(&url, 100_000).await.expect("connect");
    let service = Service::recover(&config, EventSink::Redis(Box::new(sink)))
        .await
        .expect("recover");

    for (id, side, qty) in [
        ("s-1", Side::Sell, 1_000_000),
        ("s-2", Side::Sell, 1_000_000),
        ("b-1", Side::Buy, 3_000_000),
    ] {
        service
            .submit(
                1_700_000_000_000,
                place(
                    id,
                    request(id, side, Some(9_000_000), qty, TimeInForce::GTC),
                ),
            )
            .await
            .expect("submit");
    }

    let client = redis::Client::open(url.as_str()).expect("client");
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("connect");
    let entries: Vec<(String, Vec<(String, String)>)> = redis::cmd("XRANGE")
        .arg(stream)
        .arg("-")
        .arg("+")
        .query_async(&mut conn)
        .await
        .expect("xrange");
    let levels: Vec<(u64, u32, Option<String>)> = entries
        .into_iter()
        .map(|(_, fields)| {
            let map: std::collections::HashMap<_, _> = fields.into_iter().collect();
            (
                map["seq"].parse().expect("seq"),
                map["idx"].parse().expect("idx"),
                map.get("levels").cloned(),
            )
        })
        .collect();

    let at = |price: u64, side: &str, qty: u64| {
        Some(format!(
            r#"[{{"side":"{side}","price":{price},"qty":"{qty}"}}]"#
        ))
    };
    assert_eq!(
        levels,
        vec![
            (1, 0, at(9_000_000, "sell", 1_000_000)),
            (2, 0, at(9_000_000, "sell", 2_000_000)),
            // Two fills and the taker's disposition: only the last has levels.
            (3, 0, None),
            (3, 1, None),
            // The asks emptied; the buy's remainder rests. Asks sort first.
            (
                3,
                2,
                Some(
                    r#"[{"side":"sell","price":9000000,"qty":"0"},{"side":"buy","price":9000000,"qty":"1000000"}]"#
                        .to_string()
                )
            ),
        ]
    );
}
