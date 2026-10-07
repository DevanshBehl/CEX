//! Publishing events, and the watermark that makes a crash recoverable
//! (ADR-0030).
//!
//! # Blocking egress
//!
//! The ingress request is not acknowledged until its events are in the stream,
//! so a 2xx from this service means the event is durable downstream rather than
//! merely "the book changed". The cost is a Redis round trip on every command
//! and Redis being load-bearing for *accepting* orders; the alternative buys
//! availability by making a success response mean less than every caller will
//! assume it means.
//!
//! # Ordering without holding the runtime mutex
//!
//! A network call inside the runtime's critical section is a halted market, so
//! the mutex is released before the `XADD`. That reintroduces an ordering
//! problem, solved by hand-over-hand locking in `Service::submit`: the egress
//! lock is acquired while the runtime lock is still held, so publication order
//! is sequence order. Matching stays concurrent with publishing; publishing
//! stays serial with itself.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{MatchingError, Result};
use crate::types::{event_indices, take_whole_sequences, Event, LevelChange, Seq};

/// Level changes by the sequence that produced them (ADR-0036 §1).
///
/// A sequence ABSENT from the map has unknown level changes, which is not the
/// same as none: its stream entry carries no `levels` field, and a consumer
/// reads that as "take a new snapshot". A sequence that changed nothing is
/// present with an empty list.
pub type LevelsBySeq = BTreeMap<Seq, Vec<LevelChange>>;

/// Where events go. A closed set rather than a trait object: there are exactly
/// two, and an enum keeps the dispatch visible.
pub enum EventSink {
    // Boxed: the Redis connection manager is far larger than the memory sink,
    // and an enum sized to its biggest variant would make every EventSink as
    // heavy as a live connection.
    Redis(Box<RedisSink>),
    /// Tests, and the `--no-redis` development mode. Records what it was given
    /// and can be told to fail, which is how the 503 path is exercised.
    Memory(MemorySink),
}

impl EventSink {
    pub async fn publish(
        &mut self,
        stream: &str,
        events: &[Event],
        levels: &LevelsBySeq,
    ) -> Result<()> {
        match self {
            EventSink::Redis(sink) => sink.publish(stream, events, levels).await,
            EventSink::Memory(sink) => sink.publish(events, levels),
        }
    }

    pub fn describe(&self) -> &'static str {
        match self {
            EventSink::Redis(_) => "redis",
            EventSink::Memory(_) => "memory",
        }
    }
}

pub struct RedisSink {
    connection: redis::aio::ConnectionManager,
    /// Approximate trimming. The stream is a transport buffer, not an archive;
    /// the archive is the journal.
    max_len: usize,
    /// A publish that hangs is worse than one that fails.
    ///
    /// The egress lock is held for the duration of a publish, so an unbounded
    /// wait on an unreachable Redis stalls EVERY subsequent command behind it —
    /// the connection manager's own backoff was measured at eight minutes.
    /// ADR-0030 says a publish that fails *or times out* means the request is
    /// not acknowledged, and this is what makes the second half true.
    timeout: Duration,
}

impl RedisSink {
    pub async fn connect(url: &str, max_len: usize) -> Result<Self> {
        Self::connect_with_timeout(url, max_len, Duration::from_millis(2_000)).await
    }

    pub async fn connect_with_timeout(
        url: &str,
        max_len: usize,
        timeout: Duration,
    ) -> Result<Self> {
        let client = redis::Client::open(url).map_err(|e| MatchingError::Egress(e.to_string()))?;
        let connection = tokio::time::timeout(timeout, redis::aio::ConnectionManager::new(client))
            .await
            .map_err(|_| MatchingError::Egress("connect timed out".into()))?
            .map_err(|e| MatchingError::Egress(e.to_string()))?;
        Ok(Self {
            connection,
            max_len,
            timeout,
        })
    }

    async fn publish(
        &mut self,
        stream: &str,
        events: &[Event],
        levels: &LevelsBySeq,
    ) -> Result<()> {
        tokio::time::timeout(self.timeout, self.publish_inner(stream, events, levels))
            .await
            .map_err(|_| MatchingError::Egress("publish timed out".into()))?
    }

    async fn publish_inner(
        &mut self,
        stream: &str,
        events: &[Event],
        levels: &LevelsBySeq,
    ) -> Result<()> {
        for (position, (event, idx)) in events.iter().zip(event_indices(events)).enumerate() {
            let payload =
                serde_json::to_string(event).map_err(|e| MatchingError::Egress(e.to_string()))?;
            // On the LAST entry of each sequence, so a consumer applies the
            // levels only once it has seen every event of that sequence.
            let last_of_seq = events.get(position + 1).map(Event::seq) != Some(event.seq());
            let level_payload = match levels.get(&event.seq()) {
                Some(changes) if last_of_seq => Some(
                    serde_json::to_string(changes)
                        .map_err(|e| MatchingError::Egress(e.to_string()))?,
                ),
                _ => None,
            };
            // The engine sequence is a FIELD, so a consumer tracks position by
            // it and never by a Redis id — a Redis id does not survive the
            // stream being recreated. `idx` makes `(seq, idx)` a key for ONE
            // event, which a per-event settlement offset needs (ADR-0034 §1).
            let mut command = redis::cmd("XADD");
            command
                .arg(stream)
                .arg("MAXLEN")
                .arg("~")
                .arg(self.max_len)
                .arg("*")
                .arg("seq")
                .arg(event.seq())
                .arg("idx")
                .arg(idx)
                .arg("event")
                .arg(payload);
            // Additive, like `idx` was: settlement reads `seq`, `idx` and
            // `event` and ignores the rest.
            if let Some(level_payload) = level_payload {
                command.arg("levels").arg(level_payload);
            }
            let _: String = command
                .query_async(&mut self.connection)
                .await
                .map_err(|e| MatchingError::Egress(e.to_string()))?;
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct MemorySink {
    published: Vec<Event>,
    published_levels: Vec<(Seq, Vec<LevelChange>)>,
    fail_next: usize,
}

impl MemorySink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Make the next `n` publish calls fail, for exercising the 503 path.
    pub fn fail_next(&mut self, n: usize) {
        self.fail_next = n;
    }

    pub fn published(&self) -> &[Event] {
        &self.published
    }

    /// The `levels` field of each sequence's last entry, in publication order.
    pub fn published_levels(&self) -> &[(Seq, Vec<LevelChange>)] {
        &self.published_levels
    }

    fn publish(&mut self, events: &[Event], levels: &LevelsBySeq) -> Result<()> {
        if self.fail_next > 0 {
            self.fail_next -= 1;
            return Err(MatchingError::Egress("injected failure".into()));
        }
        self.published.extend_from_slice(events);
        let mut previous = None;
        for seq in events.iter().map(Event::seq) {
            if previous == Some(seq) {
                continue;
            }
            previous = Some(seq);
            if let Some(changes) = levels.get(&seq) {
                self.published_levels.push((seq, changes.clone()));
            }
        }
        Ok(())
    }
}

/// A bounded ring of recent events, so a consumer a few thousand sequences
/// behind is served without touching disk (prompt_phase_s2.md §9).
pub struct EventRing {
    events: VecDeque<Event>,
    /// Level changes for the sequences `events` still holds, so a command
    /// republished from the ring carries them as it did the first time.
    levels: LevelsBySeq,
    capacity: usize,
}

impl EventRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            events: VecDeque::new(),
            levels: LevelsBySeq::new(),
            capacity,
        }
    }

    /// Record one command's events together with the levels it changed.
    pub fn record_with_levels(&mut self, events: &[Event], levels: &[LevelChange]) {
        self.record(events);
        if let Some(seq) = events.first().map(Event::seq) {
            self.levels.insert(seq, levels.to_vec());
        }
        // Nothing older than the oldest event still held.
        if let Some(oldest) = self.oldest_seq() {
            self.levels = self.levels.split_off(&oldest);
        }
    }

    /// The recorded level changes for every sequence after `seq`.
    pub fn levels_since(&self, seq: Seq) -> LevelsBySeq {
        self.levels
            .range(seq + 1..)
            .map(|(seq, changes)| (*seq, changes.clone()))
            .collect()
    }

    pub fn record(&mut self, events: &[Event]) {
        for event in events {
            if self.events.len() == self.capacity {
                // Evict WHOLE sequences. Evicting one event at a time can leave
                // the ring holding a sequence with its head missing, which
                // `since` would serve as if it were complete — and a consumer
                // assigning `idx` by position would mis-key all of it.
                if let Some(evicted) = self.events.pop_front() {
                    while self.events.front().map(Event::seq) == Some(evicted.seq()) {
                        self.events.pop_front();
                    }
                }
            }
            self.events.push_back(event.clone());
        }
    }

    pub fn oldest_seq(&self) -> Option<Seq> {
        self.events.front().map(Event::seq)
    }

    /// Events after `seq`, or `None` when the ring no longer reaches back that
    /// far and the caller must fall back to a journal replay.
    pub fn since(&self, seq: Seq, limit: usize) -> Option<Vec<Event>> {
        match self.oldest_seq() {
            Some(oldest) if oldest <= seq + 1 => Some(take_whole_sequences(
                self.events.iter().filter(|event| event.seq() > seq),
                limit,
            )),
            // Empty ring: NOT proof that nothing happened. The ring starts
            // empty on every boot while the journal may hold everything ever
            // matched, and answering "nothing after seq" then would hide every
            // fill from a consumer recovering a wiped stream. The journal
            // answers instead.
            None => None,
            Some(_) => None,
        }
    }
}

/// The highest sequence confirmed into the stream.
///
/// Fsynced on a cadence rather than per event. An imprecise watermark costs
/// duplicate delivery, which settlement already tolerates by construction; a
/// missing journal record costs a lost fill, which nothing tolerates. So the
/// watermark may LAG its true value and must never LEAD it.
pub struct Watermark {
    path: PathBuf,
    value: Seq,
    since_sync: u64,
    sync_every: u64,
}

pub fn watermark_path(dir: impl AsRef<Path>) -> PathBuf {
    dir.as_ref().join("published.watermark")
}

impl Watermark {
    pub fn load(dir: impl AsRef<Path>, sync_every: u64) -> Result<Self> {
        let path = watermark_path(&dir);
        let value = match fs::read_to_string(&path) {
            Ok(raw) => raw.trim().parse::<Seq>().unwrap_or(0),
            Err(_) => 0,
        };
        Ok(Self {
            path,
            value,
            since_sync: 0,
            sync_every,
        })
    }

    pub fn value(&self) -> Seq {
        self.value
    }

    /// Advance, never retreat. A watermark that went backwards would republish
    /// correctly but would also hide a bug that matters.
    pub fn advance_to(&mut self, seq: Seq) -> Result<()> {
        if seq <= self.value {
            return Ok(());
        }
        self.value = seq;
        self.since_sync += 1;
        if self.since_sync >= self.sync_every {
            self.flush()?;
        }
        Ok(())
    }

    pub fn flush(&mut self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("watermark.tmp");
        {
            let mut file = fs::File::create(&temp)?;
            file.write_all(self.value.to_string().as_bytes())?;
            file.sync_all()?;
        }
        fs::rename(&temp, &self.path)?;
        self.since_sync = 0;
        Ok(())
    }
}

/// Everything on the publishing side of the engine.
pub struct Egress {
    pub sink: EventSink,
    pub watermark: Watermark,
    pub ring: EventRing,
    pub stream: String,
}

impl Egress {
    /// Publish, then advance the watermark. In that order: a watermark that led
    /// the stream would skip an event on recovery.
    ///
    /// The ring is NOT recorded here. It is a cache of the JOURNAL — every
    /// command that happened — and is recorded once per command by the caller
    /// whether or not this succeeds. Recording only what published left a 503'd
    /// command out of re-emission entirely, though it had happened and may have
    /// matched.
    pub async fn publish(
        &mut self,
        seq: Seq,
        events: &[Event],
        levels: &LevelsBySeq,
    ) -> Result<()> {
        self.sink.publish(&self.stream, events, levels).await?;
        self.watermark.advance_to(seq)?;
        Ok(())
    }
}
