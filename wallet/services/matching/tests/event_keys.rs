//! Event keys and re-emission pages (ADR-0034 §1, prompt_phase_s4.md §5).
//!
//! `(seq, idx)` is what a settlement consumer records its position by. These
//! tests pin the three ways it could silently go wrong: deriving it from a fill
//! id, a re-emission page that ends partway through a sequence, and a ring that
//! evicts the head of a sequence and serves the tail as if it were whole.

mod common;

use common::{market, place, request};
use wallet_matching::egress::EventRing;
use wallet_matching::types::{
    event_indices, take_whole_sequences, Command, Event, SequencedCommand, Side, TimeInForce,
};
use wallet_matching::Engine;

fn at(n: u64, command: Command) -> SequencedCommand {
    SequencedCommand {
        seq: n,
        timestamp_ms: 1_700_000_000_000 + n as i64,
        command,
    }
}

/// A short history whose sequences emit different numbers of events, including
/// an amend — the case where a fill id and an event position disagree.
fn history() -> Vec<Event> {
    let mut engine = Engine::new(market());
    let commands = vec![
        place(
            "m-1",
            request(
                "maker",
                Side::Sell,
                Some(10_000_000),
                2_000_000,
                TimeInForce::GTC,
            ),
        ),
        place(
            "m-2",
            request(
                "maker",
                Side::Sell,
                Some(11_000_000),
                2_000_000,
                TimeInForce::GTC,
            ),
        ),
        place(
            "b-1",
            request(
                "taker",
                Side::Buy,
                Some(9_000_000),
                1_000_000,
                TimeInForce::GTC,
            ),
        ),
        // Amend the resting buy so it crosses both asks: Cancelled(b-1), then
        // the replacement's fills, then its disposition — four events.
        Command::Amend {
            order_id: "b-1".into(),
            new_order_id: "b-2".into(),
            price: 11_000_000,
            qty: 3_000_000,
        },
        Command::Cancel {
            order_id: "m-2".into(),
        },
    ];
    commands
        .into_iter()
        .enumerate()
        .flat_map(|(i, command)| engine.apply(at(i as u64 + 1, command)))
        .collect()
}

fn keys(events: &[Event]) -> Vec<(u64, u32)> {
    events
        .iter()
        .map(Event::seq)
        .zip(event_indices(events))
        .collect()
}

#[test]
fn idx_counts_every_event_in_a_sequence_from_zero() {
    let events = history();
    let amend: Vec<&Event> = events.iter().filter(|e| e.seq() == 4).collect();
    assert_eq!(amend.len(), 4, "cancel, two fills, accepted: {amend:?}");
    let indices: Vec<u32> = keys(&events)
        .into_iter()
        .filter(|(seq, _)| *seq == 4)
        .map(|(_, idx)| idx)
        .collect();
    assert_eq!(indices, vec![0, 1, 2, 3]);
    // Every other sequence restarts at 0.
    for (seq, idx) in keys(&events) {
        if seq != 4 {
            assert_eq!(idx, 0, "seq {seq} emitted one event");
        }
    }
}

#[test]
fn a_fill_id_is_not_an_event_key() {
    let events = history();
    let (first_fill_position, first_fill) = events
        .iter()
        .enumerate()
        .find_map(|(i, e)| match e {
            Event::Fill(f) if f.seq == 4 => Some((i, f.clone())),
            _ => None,
        })
        .expect("the amend fills");
    // The amend's first FILL is `4:0`, but it is the second EVENT of sequence 4.
    assert_eq!(first_fill.fill_id, "4:0");
    assert_eq!(event_indices(&events)[first_fill_position], 1);
}

#[test]
fn a_page_never_ends_partway_through_a_sequence() {
    let events = history();
    // Every limit, including ones that fall inside sequence 4.
    for limit in 1..=events.len() {
        let page = take_whole_sequences(events.iter(), limit);
        assert!(page.len() >= limit.min(events.len()));
        let last = page.last().expect("non-empty").seq();
        let in_page = page.iter().filter(|e| e.seq() == last).count();
        let in_full = events.iter().filter(|e| e.seq() == last).count();
        assert_eq!(in_page, in_full, "limit {limit} cut sequence {last}");
    }
}

#[test]
fn keys_derived_from_pages_equal_the_keys_published() {
    let events = history();
    let published = keys(&events);
    for limit in 1..=events.len() {
        // Page through exactly as a recovering consumer does.
        let mut derived: Vec<(u64, u32)> = Vec::new();
        let mut after = 0u64;
        loop {
            let page = take_whole_sequences(events.iter().filter(|e| e.seq() > after), limit);
            if page.is_empty() {
                break;
            }
            derived.extend(keys(&page));
            after = page.last().expect("non-empty").seq();
        }
        assert_eq!(derived, published, "limit {limit}");
    }
}

#[test]
fn the_ring_evicts_whole_sequences() {
    let events = history();
    // Capacity small enough that recording the amend's four events must evict.
    let mut ring = EventRing::new(3);
    let mut start = 0;
    while start < events.len() {
        let seq = events[start].seq();
        let end = events[start..]
            .iter()
            .position(|e| e.seq() != seq)
            .map_or(events.len(), |n| start + n);
        ring.record(&events[start..end]);
        start = end;

        // Whatever the ring holds, it holds whole sequences.
        let held = ring.since(0, usize::MAX).unwrap_or_default();
        if let Some(first) = held.first() {
            let in_ring = held.iter().filter(|e| e.seq() == first.seq()).count();
            let in_full = events.iter().filter(|e| e.seq() == first.seq()).count();
            assert_eq!(
                in_ring,
                in_full,
                "ring holds a partial sequence {}",
                first.seq()
            );
        }
    }
}

// ------------------------------------------------------- publish after a 503

mod after_a_failed_publish {
    use super::*;
    use wallet_matching::config::Config;
    use wallet_matching::egress::{EventSink, MemorySink};
    use wallet_matching::service::Service;

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

    fn buy(id: &str) -> Command {
        place(
            id,
            request(id, Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
        )
    }

    /// The bug this guards: a 503'd command left the watermark behind it, the
    /// NEXT command's publish advanced the watermark past it, and nothing ever
    /// republished it. A fill in it would never have reached settlement.
    #[tokio::test]
    async fn the_unconfirmed_command_reaches_the_stream_before_the_next_one() {
        let (service, _dir) = service(1).await;
        assert!(
            service.submit(1, buy("o-1")).await.is_err(),
            "first publish fails"
        );
        service
            .submit(2, buy("o-2"))
            .await
            .expect("second publishes");

        let published = service.memory_published().await.expect("memory sink");
        let seqs: Vec<u64> = published.iter().map(Event::seq).collect();
        assert_eq!(seqs, vec![1, 2], "sequence 1 was never republished");
        assert_eq!(service.published_watermark().await, 2);
    }

    #[tokio::test]
    async fn re_emission_serves_a_command_whose_publish_failed() {
        let (service, _dir) = service(1).await;
        assert!(service.submit(1, buy("o-1")).await.is_err());
        let events = service.events_since(0, 100).await.expect("events");
        assert_eq!(events.iter().map(Event::seq).collect::<Vec<_>>(), vec![1]);
    }

    /// After a restart the ring is empty and the journal is not. "Nothing after
    /// seq" would hide every fill from a consumer recovering a wiped stream.
    #[tokio::test]
    async fn an_empty_ring_after_restart_answers_from_the_journal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = Config::local(dir.path(), market());
        {
            let service = Service::recover(&config, EventSink::Memory(MemorySink::new()))
                .await
                .expect("recover");
            service.submit(1, buy("o-1")).await.expect("submit");
            service.submit(2, buy("o-2")).await.expect("submit");
            service.flush_watermark().await.expect("flush");
        }
        let restarted = Service::recover(&config, EventSink::Memory(MemorySink::new()))
            .await
            .expect("recover");
        let events = restarted.events_since(0, 100).await.expect("events");
        assert_eq!(
            events.iter().map(Event::seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
}
