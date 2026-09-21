//! The engine as a service: the runtime, the egress path and the caches that
//! only exist because there is now a network in front of the book.
//!
//! # Lock ordering
//!
//! **runtime, then egress. Always.** Nothing in this crate may take them the
//! other way round.
//!
//! `submit` acquires the egress lock while the runtime lock is still held and
//! releases the runtime lock immediately after — hand-over-hand. That is what
//! makes publication order equal sequence order without a network call ever
//! happening inside the runtime's critical section (ADR-0030).

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::Config;
use crate::egress::{Egress, EventRing, EventSink, Watermark};
use crate::error::{MatchingError, Result};
use crate::journal;
use crate::lookup::{LookupIndex, LookupOutcome};
use crate::runtime::{journal_path, Runtime};
use crate::types::{Command, Event, MarketConfig, Seq};

pub struct Service {
    runtime: Mutex<Runtime>,
    egress: Mutex<Egress>,
    lookup: Mutex<LookupIndex>,
    market: MarketConfig,
    data_dir: PathBuf,
    ring_capacity: usize,
}

pub struct Submitted {
    pub seq: Seq,
    pub events: Vec<Event>,
}

impl Service {
    pub async fn recover(config: &Config, sink: EventSink) -> Result<Arc<Self>> {
        let runtime = Runtime::recover(config)?;
        let watermark = Watermark::load(&config.data_dir, config.watermark_sync_every)?;
        let lookup = LookupIndex::rebuild(journal_path(&config.data_dir))?;

        let service = Arc::new(Self {
            runtime: Mutex::new(runtime),
            egress: Mutex::new(Egress {
                sink,
                watermark,
                ring: EventRing::new(config.event_ring_capacity),
                stream: config.stream_name.clone(),
            }),
            lookup: Mutex::new(lookup),
            market: config.market.clone(),
            data_dir: config.data_dir.clone(),
            ring_capacity: config.event_ring_capacity,
        });

        service.republish_gap().await?;
        Ok(service)
    }

    /// Close the crash window between the journal write and the `XADD`.
    ///
    /// The command was durable and its events were not published. Recovery
    /// re-derives them from the journal and publishes from the watermark
    /// forward. Republishing an event a consumer already saw is safe, because
    /// settlement is idempotent by construction; skipping one is not
    /// (ADR-0030).
    async fn republish_gap(&self) -> Result<()> {
        let (from, to) = {
            let egress = self.egress.lock().await;
            let runtime = self.runtime.lock().await;
            (egress.watermark.value(), runtime.engine().last_seq())
        };
        if from >= to {
            return Ok(());
        }

        tracing::info!(
            from_seq = from,
            to_seq = to,
            "republishing events the stream may not have received"
        );
        let events = self.replay_events_after(from, usize::MAX)?;
        if events.is_empty() {
            return Ok(());
        }
        let mut egress = self.egress.lock().await;
        egress.publish(to, &events).await?;
        egress.watermark.flush()?;
        Ok(())
    }

    pub fn market(&self) -> &MarketConfig {
        &self.market
    }

    pub async fn last_seq(&self) -> Seq {
        self.runtime.lock().await.engine().last_seq()
    }

    pub async fn published_watermark(&self) -> Seq {
        self.egress.lock().await.watermark.value()
    }

    pub async fn status(&self) -> crate::types::MarketStatus {
        self.runtime.lock().await.engine().market().status
    }

    pub async fn book_snapshot(&self) -> crate::book::OrderBook {
        self.runtime.lock().await.engine().book().clone()
    }

    /// Journal, fsync, match, publish, and only then return.
    ///
    /// A successful return means the events are in the stream. An
    /// `Err(Egress)` means they are not — and the command still happened, so
    /// the caller's outcome is ambiguous and is resolved with `lookup`, never
    /// by retrying blind.
    pub async fn submit(&self, timestamp_ms: i64, command: Command) -> Result<Submitted> {
        // Both ids: the sweeper asks by CLIENT order id and needs the engine's
        // order id back, because that is what every event carries.
        let placement = match &command {
            Command::Place { order_id, request } => {
                Some((request.client_order_id.clone(), order_id.clone()))
            }
            _ => None,
        };

        let (seq, events, egress_guard) = {
            let mut runtime = self.runtime.lock().await;
            let events = runtime.submit(timestamp_ms, command)?;
            let seq = runtime.engine().last_seq();
            // Hand-over-hand. Acquired BEFORE the runtime lock is dropped, so
            // the next command cannot overtake this one on the way out.
            let egress = self.egress.lock().await;
            drop(runtime);
            (seq, events, egress)
        };

        // The order reached the journal, so the lookup must be able to find it
        // even if publishing now fails — that is the whole point of the
        // sweeper's question.
        if let Some((client_order_id, order_id)) = placement {
            self.lookup
                .lock()
                .await
                .record_with_order_id(client_order_id, seq, order_id);
        }

        let mut egress = egress_guard;
        egress.publish(seq, &events).await?;
        Ok(Submitted { seq, events })
    }

    pub async fn lookup(&self, client_order_id: &str) -> LookupOutcome {
        self.lookup.lock().await.get(client_order_id)
    }

    /// Events after `seq`, from the ring when it reaches back far enough and
    /// from a journal replay when it does not.
    ///
    /// Never takes the runtime lock: re-emission is a read and must not disturb
    /// the live engine.
    pub async fn events_since(&self, seq: Seq, limit: usize) -> Result<Vec<Event>> {
        if let Some(events) = self.egress.lock().await.ring.since(seq, limit) {
            return Ok(events);
        }
        tracing::warn!(
            after_seq = seq,
            ring_capacity = self.ring_capacity,
            "re-emission fell out of the ring and required a journal replay"
        );
        self.replay_events_after(seq, limit)
    }

    fn replay_events_after(&self, seq: Seq, limit: usize) -> Result<Vec<Event>> {
        let path = journal_path(&self.data_dir);
        let (_, events) = Runtime::replay_from_scratch(self.market.clone(), path)?;
        Ok(events
            .into_iter()
            .filter(|event| event.seq() > seq)
            .take(limit)
            .collect())
    }

    /// Force the watermark to disk. Called on shutdown, so a clean stop does
    /// not republish on the next boot.
    pub async fn flush_watermark(&self) -> Result<()> {
        self.egress.lock().await.watermark.flush()
    }

    /// For tests: how many records the journal holds.
    pub fn journal_len(&self) -> Result<usize> {
        let replayed = journal::replay(journal_path(&self.data_dir), 0, false)?;
        Ok(replayed.commands.len())
    }
}

impl From<MatchingError> for (u16, &'static str) {
    fn from(error: MatchingError) -> Self {
        match error {
            MatchingError::Egress(_) => (503, "egress_unconfirmed"),
            MatchingError::JournalCorruption { .. } => (500, "journal_corruption"),
            _ => (500, "internal"),
        }
    }
}
