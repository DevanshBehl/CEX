//! A deterministic central limit order book.
//!
//! `main.rs` is the process; this is the same code reachable from integration
//! tests, so replay and recovery are exercised for real rather than
//! approximated.
//!
//! # The one property this crate exists to have
//!
//! `Engine::apply` is pure: the same book state, sequence and command produce
//! the same events, forever, on any machine. No clock, no randomness, no
//! floats, no iteration over an unordered collection in any path that reaches
//! an event.
//!
//! That is not a style preference. Settlement is driven from a sequenced event
//! stream (ADR-0025), a wiped stream is recovered by replaying the journal
//! (ADR-0028), and both are only possible if a replay reproduces the original
//! byte for byte.
//!
//! # What this crate must never acquire
//!
//! A database handle, an HTTP client, a Redis connection, or any notion of a
//! balance. The engine owns price and priority; the ledger owns money. An
//! engine that could answer a question about a balance has been given a job
//! that is not its own.

#![forbid(unsafe_code)]

pub mod book;
pub mod config;
pub mod engine;
pub mod error;
pub mod journal;
pub mod runtime;
pub mod snapshot;
pub mod types;

pub use engine::Engine;
pub use error::{MatchingError, Result};
pub use types::*;
