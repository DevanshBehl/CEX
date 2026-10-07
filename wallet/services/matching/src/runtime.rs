//! Durable engine: journal, then match, then snapshot on cadence.
//!
//! This is the only place the ordering in ADR-0028 is enforced, which is why it
//! is the only place a command may be submitted.

use std::path::{Path, PathBuf};

use crate::book::OrderBook;
use crate::config::Config;
use crate::engine::Engine;
use crate::error::Result;
use crate::journal::{self, Journal};
use crate::snapshot::{self, Snapshot};
use crate::types::{Command, Event, LevelChange, MarketConfig, SequenceOutput, SequencedCommand};

pub struct Runtime {
    engine: Engine,
    journal: Journal,
    data_dir: PathBuf,
    snapshot_every_n: u64,
    last_snapshot_seq: u64,
}

pub fn journal_path(dir: impl AsRef<Path>) -> PathBuf {
    dir.as_ref().join("journal.wal")
}

impl Runtime {
    /// Recover, in ADR-0028's order: newest valid snapshot, then the journal
    /// tail after it, then resume sequencing from the last journaled sequence
    /// plus one.
    ///
    /// Sequences never restart at zero. Restarting would make the settlement
    /// worker's offset meaningless, and a duplicate sequence is a duplicate
    /// `reference_id` on a settlement — which the unique index would reject,
    /// turning a recoverable restart into a stuck queue.
    pub fn recover(config: &Config) -> Result<Self> {
        Self::recover_with(config, true)
    }

    pub fn recover_with(config: &Config, truncate_torn_tail: bool) -> Result<Self> {
        let loaded = snapshot::load(&config.data_dir)?;
        let (book, from_seq) = match loaded {
            Some(Snapshot { last_seq, book }) => (book, last_seq),
            None => (OrderBook::new(), 0),
        };

        let path = journal_path(&config.data_dir);
        let replayed = journal::replay(&path, from_seq, truncate_torn_tail)?;

        let mut engine = Engine::with_book(config.market.clone(), book, from_seq);
        for command in replayed.commands {
            let _ = engine.apply(command);
        }
        // Recovery touched every level it replayed. None of that belongs to
        // the first live command.
        let _ = engine.take_level_changes();

        Ok(Self {
            engine,
            journal: Journal::open(&path)?,
            data_dir: config.data_dir.clone(),
            snapshot_every_n: config.snapshot_every_n,
            last_snapshot_seq: from_seq,
        })
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }

    pub fn next_seq(&self) -> u64 {
        self.engine.last_seq() + 1
    }

    /// Sequence, append, fsync, match, emit.
    ///
    /// The journal write happens BEFORE `apply`, so an event this returns is
    /// always backed by a durable command.
    pub fn submit(&mut self, timestamp_ms: i64, command: Command) -> Result<Vec<Event>> {
        Ok(self.submit_with_levels(timestamp_ms, command)?.0)
    }

    /// `submit`, and the levels the command left changed (ADR-0036 §1).
    pub fn submit_with_levels(
        &mut self,
        timestamp_ms: i64,
        command: Command,
    ) -> Result<(Vec<Event>, Vec<LevelChange>)> {
        let sequenced = SequencedCommand {
            seq: self.next_seq(),
            timestamp_ms,
            command,
        };
        self.journal.append(&sequenced)?;
        let seq = sequenced.seq;
        let events = self.engine.apply(sequenced);
        let levels = self.engine.take_level_changes();

        if seq.saturating_sub(self.last_snapshot_seq) >= self.snapshot_every_n {
            self.write_snapshot()?;
        }
        Ok((events, levels))
    }

    pub fn write_snapshot(&mut self) -> Result<()> {
        snapshot::write(
            &self.data_dir,
            &Snapshot {
                last_seq: self.engine.last_seq(),
                book: self.engine.book().clone(),
            },
        )?;
        self.last_snapshot_seq = self.engine.last_seq();
        Ok(())
    }

    /// Replay a journal into a fresh engine, touching no files but the journal.
    ///
    /// The baseline that snapshot-plus-tail is asserted against.
    pub fn replay_from_scratch(
        market: MarketConfig,
        journal_file: impl AsRef<Path>,
    ) -> Result<(Engine, Vec<Event>)> {
        let replayed = journal::replay(journal_file, 0, false)?;
        let mut engine = Engine::new(market);
        let mut events = Vec::new();
        for command in replayed.commands {
            events.extend(engine.apply(command));
        }
        Ok((engine, events))
    }

    /// The same replay, kept per command, with each command's level changes.
    ///
    /// What republishing needs: the engine is deterministic, so the levels a
    /// replayed command changes are the levels it changed the first time.
    pub fn replay_with_levels(
        market: MarketConfig,
        journal_file: impl AsRef<Path>,
    ) -> Result<Vec<SequenceOutput>> {
        let replayed = journal::replay(journal_file, 0, false)?;
        let mut engine = Engine::new(market);
        let mut out = Vec::with_capacity(replayed.commands.len());
        for command in replayed.commands {
            let seq = command.seq;
            let events = engine.apply(command);
            let levels = engine.take_level_changes();
            out.push(SequenceOutput {
                seq,
                events,
                levels,
            });
        }
        Ok(out)
    }
}
