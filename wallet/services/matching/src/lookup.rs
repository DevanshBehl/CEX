//! The lookup S3's `PENDING_ENGINE` sweeper needs.
//!
//! # Why this is answered from the journal and not the book
//!
//! The sweeper reverses a hold when the engine says it never saw an order. An
//! order that was accepted and immediately filled in full is **gone from the
//! book and present in the journal**. Consulting the book would report it as
//! missing, and the sweeper would release a hold against a fill that really
//! happened.

use std::collections::HashMap;
use std::path::Path;

use crate::error::Result;
use crate::journal;
use crate::types::{Command, Seq};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LookupOutcome {
    /// The engine has no record of this client order id.
    NeverSeen,
    Seen {
        seq: Seq,
        order_id: String,
    },
    /// The index is still being rebuilt.
    ///
    /// **Its own answer, never collapsed into `NeverSeen`.** A sweeper that
    /// reads "cannot answer" as "never seen" reverses a live hold.
    Rebuilding,
}

pub struct LookupIndex {
    entries: HashMap<String, (Seq, String)>,
    ready: bool,
}

impl LookupIndex {
    /// An index that cannot answer yet. Every query returns `Rebuilding`.
    pub fn rebuilding() -> Self {
        Self {
            entries: HashMap::new(),
            ready: false,
        }
    }

    /// Scan the journal and index every placement in it.
    pub fn rebuild(journal_file: impl AsRef<Path>) -> Result<Self> {
        let replayed = journal::replay(journal_file, 0, false)?;
        let mut entries = HashMap::new();
        for command in replayed.commands {
            if let Command::Place { order_id, request } = command.command {
                entries.insert(request.client_order_id, (command.seq, order_id));
            }
        }
        Ok(Self {
            entries,
            ready: true,
        })
    }

    /// Records both ids. There is deliberately no single-id variant: one that
    /// defaulted the engine order id to the client order id would look correct
    /// and hand the sweeper an id no event carries.
    pub fn record_with_order_id(&mut self, client_order_id: String, seq: Seq, order_id: String) {
        self.entries.insert(client_order_id, (seq, order_id));
    }

    pub fn get(&self, client_order_id: &str) -> LookupOutcome {
        if !self.ready {
            return LookupOutcome::Rebuilding;
        }
        match self.entries.get(client_order_id) {
            Some((seq, order_id)) => LookupOutcome::Seen {
                seq: *seq,
                order_id: order_id.clone(),
            },
            None => LookupOutcome::NeverSeen,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
