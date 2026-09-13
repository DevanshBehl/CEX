//! The wallet's signing boundary, as a library.
//!
//! `main.rs` is the process; this is the same code reachable from integration
//! tests so the HTTP layer can be exercised for real rather than approximated.
//! The boundary's whole value is what it refuses, and that is only testable by
//! making actual requests to it.

pub mod auth;
pub mod custody;
pub mod dkg;
pub mod error;
pub mod frost;
pub mod http;
pub mod keystore;
pub mod signer;
pub mod store;
pub mod threshold;
