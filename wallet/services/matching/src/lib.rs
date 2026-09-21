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
//! # What the ENGINE must never acquire
//!
//! `engine`, `book` and `types` know nothing of the network. No clock, no
//! socket, no file — `Engine::apply` takes a command and returns events, and
//! that is the whole of its world.
//!
//! S2 gives the crate a transport (`auth`, `egress`, `http`, `service`), and
//! the separation is the point: the transport may hold a Redis connection and
//! a TLS listener, and the engine may not learn that either exists. A command
//! arriving over HTTP and a command replayed from the journal are the same
//! command, which is what keeps a replay byte-identical to the original run.
//!
//! **Nothing in this crate, at any layer, holds a database handle or any notion
//! of a balance.** The engine owns price and priority; the ledger owns money.

#![forbid(unsafe_code)]

pub mod auth;
pub mod book;
pub mod config;
pub mod egress;
pub mod engine;
pub mod error;
pub mod http;
pub mod journal;
pub mod lookup;
pub mod runtime;
pub mod service;
pub mod snapshot;
pub mod types;

pub use engine::Engine;
pub use error::{MatchingError, Result};
pub use types::*;
