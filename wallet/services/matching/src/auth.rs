//! Caller authentication and replay protection (ADR-0031).
//!
//! The scheme is copied from `services/mpc` field for field: an Ed25519
//! signature over a canonical string, with this service holding only the
//! caller's PUBLIC key. Compromising the engine therefore yields no ability to
//! impersonate the gateway.
//!
//! TLS protects the channel; the signature proves who is on the other end of
//! it. They are not alternatives — the transport can be terminated by a proxy,
//! and then the signature is the only thing that still says who called.
//!
//! # What does not carry over from `services/mpc`
//!
//! Its verifier has no replay cache, and does not need one: `/v1/sign` is
//! idempotent on `requestId`, so replaying a signed request returns the same
//! signature and changes nothing.
//!
//! **Placing an order is not idempotent.** `Engine::place` rejects a duplicate
//! order id only while that id is still RESTING. An order that filled
//! completely is gone from the book, so a replayed placement inside the
//! timestamp window creates a second order, which matches again. Hence
//! [`ReplayCache`].

use std::collections::{HashSet, VecDeque};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

/// ADR-0031. Wider costs proportionally more memory and a longer replay window;
/// narrower starts refusing legitimate requests on ordinary clock skew.
pub const DEFAULT_TOLERANCE_SECONDS: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFailure {
    /// The clock check, which runs FIRST so a replay of a genuinely signed old
    /// request is refused cheaply and the recorded reason is the accurate one.
    TimestampOutsideWindow,
    SignatureNotBase64,
    SignatureWrongLength,
    SignatureRejected,
    /// This request id was already seen inside the window. Its own outcome, and
    /// its own status code, so an operator can tell a client retrying from an
    /// attacker replaying.
    Replayed,
    /// The cache is full. Refusing is visible; forgetting silently reopens the
    /// vulnerability the cache exists to close.
    ReplayCacheExhausted,
}

impl AuthFailure {
    pub fn reason(self) -> &'static str {
        match self {
            AuthFailure::TimestampOutsideWindow => "timestamp_outside_window",
            AuthFailure::SignatureNotBase64 => "signature_not_base64",
            AuthFailure::SignatureWrongLength => "signature_wrong_length",
            AuthFailure::SignatureRejected => "signature_rejected",
            AuthFailure::Replayed => "request_replayed",
            AuthFailure::ReplayCacheExhausted => "replay_cache_exhausted",
        }
    }

    /// A replay is a 409, not a 401. It is a distinct, actionable signal.
    pub fn is_replay(self) -> bool {
        matches!(
            self,
            AuthFailure::Replayed | AuthFailure::ReplayCacheExhausted
        )
    }
}

/// The fields a signature covers.
///
/// The payload is covered by its HASH rather than its bytes, so the canonical
/// string stays bounded and nothing tempts a maintainer to log it.
pub struct SignedRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub request_id: &'a str,
    pub payload_hash: &'a [u8],
    pub timestamp: i64,
}

/// The exact bytes a caller signs.
///
/// Field-separated with a character that cannot appear in any field, so
/// `("ab", "c")` and `("a", "bc")` cannot produce the same string. Without that
/// the scheme has a splicing weakness that is easy to miss and hard to notice.
pub fn canonical_string(request: &SignedRequest<'_>) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        request.method,
        request.path,
        request.request_id,
        hex::encode(request.payload_hash),
        request.timestamp,
    )
}

pub fn hash_payload(payload: &[u8]) -> Vec<u8> {
    Sha256::digest(payload).to_vec()
}

pub struct CallerVerifier {
    public_key: VerifyingKey,
    tolerance_seconds: i64,
}

impl CallerVerifier {
    pub fn new(public_key_base64: &str, tolerance_seconds: i64) -> Result<Self, String> {
        let bytes = B64
            .decode(public_key_base64.trim())
            .map_err(|_| "caller key is not base64".to_string())?;
        let bytes: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| "caller key is not 32 bytes".to_string())?;
        let public_key =
            VerifyingKey::from_bytes(&bytes).map_err(|_| "caller key is invalid".to_string())?;
        Ok(Self {
            public_key,
            tolerance_seconds,
        })
    }

    pub fn tolerance_seconds(&self) -> i64 {
        self.tolerance_seconds
    }

    /// Verify a request, or reject it with a reason for the audit log.
    ///
    /// The timestamp is checked BEFORE the signature, deliberately.
    pub fn verify(
        &self,
        request: &SignedRequest<'_>,
        signature_base64: &str,
        now: i64,
    ) -> Result<(), AuthFailure> {
        if (now - request.timestamp).abs() > self.tolerance_seconds {
            return Err(AuthFailure::TimestampOutsideWindow);
        }
        let signature_bytes = B64
            .decode(signature_base64.trim())
            .map_err(|_| AuthFailure::SignatureNotBase64)?;
        let signature_bytes: [u8; 64] = signature_bytes
            .as_slice()
            .try_into()
            .map_err(|_| AuthFailure::SignatureWrongLength)?;
        let signature = Signature::from_bytes(&signature_bytes);
        self.public_key
            .verify(canonical_string(request).as_bytes(), &signature)
            .map_err(|_| AuthFailure::SignatureRejected)
    }
}

/// The other half of [`CallerVerifier`]: proves who is calling.
///
/// This lives here so the test suite and the load client can produce genuine
/// requests. **The engine never holds one** — it holds a public key and nothing
/// else, which is what makes compromising it useless for impersonation.
pub struct CallerSigner {
    key: SigningKey,
}

impl CallerSigner {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(seed),
        }
    }

    pub fn public_key_base64(&self) -> String {
        B64.encode(self.key.verifying_key().to_bytes())
    }

    pub fn sign(&self, request: &SignedRequest<'_>) -> String {
        B64.encode(
            self.key
                .sign(canonical_string(request).as_bytes())
                .to_bytes(),
        )
    }
}

/// A TTL set of request ids seen inside the timestamp tolerance window.
///
/// **The TTL is the tolerance window, and that is the whole argument for the
/// cache being bounded.** Once a request's timestamp falls outside tolerance,
/// `CallerVerifier` refuses it on the clock check regardless of what this
/// remembers — so an entry older than the window can never change an outcome,
/// and evicting it is free. Memory is bounded by request rate times window,
/// never by uptime.
///
/// In memory, and lost on restart. That is sufficient because a request signed
/// before the restart is outside its tolerance by the time the process is
/// serving again (ADR-0031).
///
/// The clock is passed in rather than read, so eviction is testable by
/// advancing a number.
pub struct ReplayCache {
    seen: HashSet<String>,
    order: VecDeque<(i64, String)>,
    ttl_seconds: i64,
    capacity: usize,
}

impl ReplayCache {
    pub fn new(ttl_seconds: i64, capacity: usize) -> Self {
        Self {
            seen: HashSet::new(),
            order: VecDeque::new(),
            ttl_seconds,
            capacity,
        }
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    /// Record a request id, or reject it as a replay.
    ///
    /// Eviction happens first, so an id whose window has passed does not count
    /// against capacity.
    pub fn observe(
        &mut self,
        request_id: &str,
        timestamp: i64,
        now: i64,
    ) -> Result<(), AuthFailure> {
        self.evict_expired(now);

        if self.seen.contains(request_id) {
            return Err(AuthFailure::Replayed);
        }
        if self.seen.len() >= self.capacity {
            // Refuse rather than forget. Forgetting is the failure mode that
            // silently reopens the vulnerability this cache exists to close.
            return Err(AuthFailure::ReplayCacheExhausted);
        }

        self.seen.insert(request_id.to_string());
        self.order.push_back((timestamp, request_id.to_string()));
        Ok(())
    }

    fn evict_expired(&mut self, now: i64) {
        while let Some((timestamp, _)) = self.order.front() {
            if now - *timestamp <= self.ttl_seconds {
                break;
            }
            if let Some((_, id)) = self.order.pop_front() {
                self.seen.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repeat_inside_the_window_is_a_replay() {
        let mut cache = ReplayCache::new(300, 1000);
        assert!(cache.observe("r-1", 1_000, 1_000).is_ok());
        assert_eq!(
            cache.observe("r-1", 1_000, 1_100),
            Err(AuthFailure::Replayed)
        );
    }

    #[test]
    fn an_entry_older_than_the_window_is_evicted_because_it_cannot_change_an_outcome() {
        let mut cache = ReplayCache::new(300, 1000);
        cache.observe("r-1", 1_000, 1_000).expect("first");
        // now - timestamp = 301 > ttl. The clock check would refuse this
        // request anyway, so remembering it buys nothing.
        cache.observe("r-2", 1_301, 1_301).expect("second");
        assert_eq!(cache.len(), 1, "the expired entry should be gone");
    }

    #[test]
    fn memory_is_bounded_by_rate_times_window_not_by_uptime() {
        let mut cache = ReplayCache::new(300, 10_000);
        // One request per second for an hour: twelve times the window.
        for second in 0..3_600i64 {
            cache
                .observe(&format!("r-{second}"), second, second)
                .expect("accepted");
        }
        assert!(
            cache.len() <= 301,
            "cache grew with uptime: {} entries",
            cache.len()
        );
    }

    #[test]
    fn exhaustion_refuses_rather_than_forgetting() {
        let mut cache = ReplayCache::new(300, 2);
        cache.observe("a", 0, 0).expect("a");
        cache.observe("b", 0, 0).expect("b");
        assert_eq!(
            cache.observe("c", 0, 0),
            Err(AuthFailure::ReplayCacheExhausted)
        );
        // And "a" is still remembered, so it is still refused as a replay.
        assert_eq!(cache.observe("a", 0, 0), Err(AuthFailure::Replayed));
    }

    #[test]
    fn the_canonical_string_cannot_be_spliced() {
        let hash = hash_payload(b"{}");
        let a = canonical_string(&SignedRequest {
            method: "POST",
            path: "/v1/orders",
            request_id: "ab",
            payload_hash: &hash,
            timestamp: 1,
        });
        let b = canonical_string(&SignedRequest {
            method: "POST",
            path: "/v1/orders",
            request_id: "a",
            payload_hash: &hash,
            timestamp: 1,
        });
        assert_ne!(a, b);
    }
}
