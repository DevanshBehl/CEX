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
use wallet_matching::types::{Side, TimeInForce};

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
