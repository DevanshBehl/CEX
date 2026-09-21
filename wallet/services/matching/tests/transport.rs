//! The control plane, driven through the REAL router.
//!
//! `tower::ServiceExt::oneshot` against `http::router`, exactly as
//! `services/mpc/tests/boundary.rs` drives its own. A boundary tested by
//! calling a handler directly is not a boundary tested.

mod common;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::market;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tower::ServiceExt;
use wallet_matching::auth::{
    hash_payload, CallerSigner, CallerVerifier, ReplayCache, SignedRequest,
};
use wallet_matching::config::Config;
use wallet_matching::egress::{EventSink, MemorySink};
use wallet_matching::http::{router, AppState};
use wallet_matching::service::Service;

const SEED: [u8; 32] = [7u8; 32];
const TS: i64 = 1_700_000_000_000;

struct Harness {
    state: Arc<AppState>,
    signer: CallerSigner,
    clock: Arc<AtomicI64>,
    /// An RAII guard: held so the data directory outlives the harness, never
    /// read. Dropping it early would delete the journal mid-test.
    #[allow(dead_code)]
    dir: tempfile::TempDir,
}

async fn harness() -> Harness {
    harness_with(|c| c).await
}

async fn harness_with(tweak: impl FnOnce(Config) -> Config) -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = tweak(Config::local(dir.path(), market()));
    build(config, dir).await
}

async fn build(config: Config, dir: tempfile::TempDir) -> Harness {
    let signer = CallerSigner::from_seed(&SEED);
    let service = Service::recover(&config, EventSink::Memory(MemorySink::new()))
        .await
        .expect("recover");
    let clock = Arc::new(AtomicI64::new(1_700_000_000));
    let reader = clock.clone();
    let state = Arc::new(AppState {
        service,
        verifier: Some(
            CallerVerifier::new(&signer.public_key_base64(), config.tolerance_seconds)
                .expect("verifier"),
        ),
        replay: Mutex::new(ReplayCache::new(
            config.tolerance_seconds,
            config.replay_cache_capacity,
        )),
        now: Box::new(move || reader.load(Ordering::SeqCst)),
    });
    Harness {
        state,
        signer,
        clock,
        dir,
    }
}

impl Harness {
    fn now(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    fn advance(&self, seconds: i64) {
        self.clock.fetch_add(seconds, Ordering::SeqCst);
    }

    /// A correctly signed request.
    fn signed(&self, method: &str, path: &str, request_id: &str, body: Value) -> Request<Body> {
        self.signed_at(method, path, request_id, body, self.now())
    }

    fn signed_at(
        &self,
        method: &str,
        path: &str,
        request_id: &str,
        body: Value,
        timestamp: i64,
    ) -> Request<Body> {
        // A GET carries no body, and the signature covers exactly the bytes
        // that arrive — so `Null` must hash as empty, not as the string "null".
        let bytes = if body.is_null() {
            Vec::new()
        } else {
            serde_json::to_vec(&body).expect("encode")
        };
        let signature = self.signer.sign(&SignedRequest {
            method,
            path,
            request_id,
            payload_hash: &hash_payload(&bytes),
            timestamp,
        });
        Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("x-atlas-signature", signature)
            .header("x-atlas-request-id", request_id)
            .header("x-atlas-timestamp", timestamp.to_string())
            .body(Body::from(bytes))
            .expect("request")
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        let response = router(self.state.clone())
            .oneshot(request)
            .await
            .expect("response");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    fn place_body(&self, order_id: &str, side: &str, price: u64, qty: u64) -> Value {
        json!({
            "order_id": order_id,
            "timestamp_ms": TS,
            "request": {
                "client_order_id": format!("c-{order_id}"),
                "side": side,
                "order_type": "limit",
                "time_in_force": "GTC",
                "price": price,
                "qty": qty,
                "post_only": false,
                "stp_mode": "cancel_taker",
                "account_id": format!("acct-{order_id}")
            }
        })
    }

    async fn place(&self, order_id: &str, side: &str, price: u64, qty: u64) -> (StatusCode, Value) {
        let body = self.place_body(order_id, side, price, qty);
        self.send(self.signed("POST", "/v1/orders", &format!("req-{order_id}"), body))
            .await
    }
}

// ------------------------------------------------------------ authentication

#[tokio::test]
async fn an_unsigned_request_is_refused() {
    let h = harness().await;
    let request = Request::builder()
        .method("POST")
        .uri("/v1/orders")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&h.place_body("o-1", "buy", 10_000_000, 1_000_000)).unwrap(),
        ))
        .unwrap();
    let (status, body) = h.send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "missing_auth_header");
}

/// Proves the payload hash is genuinely in the canonical string.
#[tokio::test]
async fn a_signature_over_a_different_body_is_refused() {
    let h = harness().await;
    let mut request = h.signed(
        "POST",
        "/v1/orders",
        "req-1",
        h.place_body("o-1", "buy", 10_000_000, 1_000_000),
    );
    *request.body_mut() =
        Body::from(serde_json::to_vec(&h.place_body("o-2", "buy", 11_000_000, 2_000_000)).unwrap());
    let (status, body) = h.send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "signature_rejected");
}

#[tokio::test]
async fn a_signature_over_a_different_path_is_refused() {
    let h = harness().await;
    let body = json!({ "timestamp_ms": TS });
    let signed_for_other_path = h.signed("DELETE", "/v1/orders/other", "req-1", body.clone());
    let mut request = signed_for_other_path;
    *request.uri_mut() = "/v1/orders/mine".parse().unwrap();
    let (status, _) = h.send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// The clock check runs FIRST, so the recorded reason is the accurate one.
/// Regression: the handlers once verified `uri.path()` while the signature
/// covered path-and-query, leaving every query parameter unsigned. A captured
/// `GET /v1/events?after=0` could then be rewritten to `after=999999` — same
/// path, empty body, still a valid signature.
#[tokio::test]
async fn a_tampered_query_string_is_refused() {
    let h = harness().await;
    h.place("o-1", "buy", 10_000_000, 1_000_000).await;

    let mut request = h.signed("GET", "/v1/events?after=0", "req-events", Value::Null);
    *request.uri_mut() = "/v1/events?after=999999".parse().unwrap();
    let (status, body) = h.send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "signature_rejected");
}

/// The same hole in the other direction: a body is not a substitute for a
/// signed query, so an empty-bodied read must still bind its parameters.
#[tokio::test]
async fn a_signed_query_string_is_honoured_exactly() {
    let h = harness().await;
    for i in 0..4u64 {
        h.place(&format!("o-{i}"), "buy", 10_000_000, 1_000_000)
            .await;
    }
    let (status, body) = h
        .send(h.signed("GET", "/v1/events?after=2", "req-events", Value::Null))
        .await;
    assert_eq!(status, StatusCode::OK);
    let events = body["events"].as_array().unwrap();
    assert!(
        events
            .iter()
            .all(|e| e["Accepted"]["seq"].as_u64().unwrap_or(99) > 2),
        "after=2 returned earlier events: {body}"
    );
}

#[tokio::test]
async fn a_stale_timestamp_is_refused_and_named_as_such() {
    let h = harness().await;
    let stale = h.now() - 301;
    let request = h.signed_at(
        "POST",
        "/v1/orders",
        "req-1",
        h.place_body("o-1", "buy", 10_000_000, 1_000_000),
        stale,
    );
    let (status, body) = h.send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body["error"], "timestamp_outside_window",
        "the reason must name the timestamp, not the signature"
    );
}

/// ADR-0031's reason for existing.
///
/// The replayed order FULLY FILLS and leaves the book first. A test that
/// replays a still-resting order passes for the wrong reason, because
/// `Engine::place` would refuse it as a duplicate id anyway.
#[tokio::test]
async fn a_replayed_request_is_refused_even_after_the_order_left_the_book() {
    let h = harness().await;

    // A maker to fill against, then a taker that consumes it entirely.
    let (status, _) = h.place("maker", "sell", 10_000_000, 1_000_000).await;
    assert_eq!(status, StatusCode::OK);

    let taker = h.place_body("taker", "buy", 10_000_000, 1_000_000);
    let first = h.signed("POST", "/v1/orders", "req-taker", taker.clone());
    let (status, body) = h.send(first).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e.get("Fill").is_some()),
        "the taker must have filled: {body}"
    );

    // Both orders are now gone from the book, so the engine's duplicate-id
    // check cannot catch this. Only the replay cache can.
    let replay = h.signed("POST", "/v1/orders", "req-taker", taker);
    let (status, body) = h.send(replay).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a replay must be a 409, distinct from a bad signature's 401"
    );
    assert_eq!(body["error"], "request_replayed");
}

#[tokio::test]
async fn a_request_id_is_reusable_once_its_window_has_passed() {
    let h = harness().await;
    let body = h.place_body("o-1", "buy", 10_000_000, 1_000_000);
    let (status, _) = h.send(h.signed("POST", "/v1/orders", "req-1", body)).await;
    assert_eq!(status, StatusCode::OK);

    // Past the window the clock check refuses the old request anyway, so the
    // cache entry can no longer change an outcome and is evicted.
    h.advance(400);
    let body2 = h.place_body("o-2", "buy", 10_000_000, 1_000_000);
    let (status, _) = h.send(h.signed("POST", "/v1/orders", "req-1", body2)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn health_needs_no_signature_and_reveals_no_order() {
    let h = harness().await;
    h.place("o-1", "buy", 10_000_000, 1_000_000).await;
    let request = Request::builder()
        .uri("/v1/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = h.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["market"], "devnet:SOL-USDC");
    assert_eq!(body["last_seq"], 1);
    let rendered = body.to_string();
    assert!(!rendered.contains("o-1"), "health leaked an order id");
    assert!(!rendered.contains("acct-"), "health leaked an account id");
}

// ------------------------------------------------------------------ ingress

/// A rejection is a business outcome the engine computed, not the transport
/// saying the request never got that far.
#[tokio::test]
async fn a_rejected_order_is_a_200_carrying_a_rejected_event() {
    let h = harness().await;
    // Off tick: the market's tick is 1_000_000.
    let (status, body) = h.place("o-1", "buy", 10_000_001, 1_000_000).await;
    assert_eq!(status, StatusCode::OK);
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["Rejected"]["reason"], "TICK_VIOLATION");
}

#[tokio::test]
async fn malformed_json_is_a_400() {
    let h = harness().await;
    let bytes = b"{ not json".to_vec();
    let signature = h.signer.sign(&SignedRequest {
        method: "POST",
        path: "/v1/orders",
        request_id: "req-1",
        payload_hash: &hash_payload(&bytes),
        timestamp: h.now(),
    });
    let request = Request::builder()
        .method("POST")
        .uri("/v1/orders")
        .header("x-atlas-signature", signature)
        .header("x-atlas-request-id", "req-1")
        .header("x-atlas-timestamp", h.now().to_string())
        .body(Body::from(bytes))
        .unwrap();
    let (status, body) = h.send(request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "malformed_body");
}

#[tokio::test]
async fn an_unknown_route_is_a_404() {
    let h = harness().await;
    let request = Request::builder()
        .uri("/v1/nope")
        .body(Body::empty())
        .unwrap();
    let (status, _) = h.send(request).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cancel_and_amend_round_trip_over_http() {
    let h = harness().await;
    h.place("o-1", "buy", 10_000_000, 2_000_000).await;

    let (status, body) = h
        .send(h.signed(
            "PATCH",
            "/v1/orders/o-1",
            "req-amend",
            json!({ "timestamp_ms": TS, "new_order_id": "o-1-v2", "price": 9_000_000u64, "qty": 1_000_000u64 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["events"][0]["Cancelled"].is_object());

    let (status, body) = h
        .send(h.signed(
            "DELETE",
            "/v1/orders/o-1-v2",
            "req-cancel",
            json!({ "timestamp_ms": TS }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["events"][0]["Cancelled"].is_object());
}

// ------------------------------------------------------------------- egress

/// ADR-0030: a 2xx means the event reached the stream. If it did not, the
/// request is NOT acknowledged.
#[tokio::test]
async fn a_publish_that_does_not_confirm_is_a_503_and_is_ambiguous() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config::local(dir.path(), market());
    let mut sink = MemorySink::new();
    sink.fail_next(1);
    let signer = CallerSigner::from_seed(&SEED);
    let service = Service::recover(&config, EventSink::Memory(sink))
        .await
        .expect("recover");
    let clock = Arc::new(AtomicI64::new(1_700_000_000));
    let reader = clock.clone();
    let state = Arc::new(AppState {
        service,
        verifier: Some(
            CallerVerifier::new(&signer.public_key_base64(), config.tolerance_seconds).unwrap(),
        ),
        replay: Mutex::new(ReplayCache::new(config.tolerance_seconds, 1000)),
        now: Box::new(move || reader.load(Ordering::SeqCst)),
    });
    let h = Harness {
        state,
        signer,
        clock,
        dir,
    };

    let (status, body) = h.place("o-1", "buy", 10_000_000, 1_000_000).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "egress_unconfirmed");

    // AMBIGUOUS, not failed: the command is journaled and the book mutated.
    // The caller resolves it by asking, never by retrying blind.
    let (status, body) = h
        .send(h.signed(
            "GET",
            "/v1/orders/lookup?clientOrderId=c-o-1",
            "req-lookup",
            Value::Null,
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["outcome"], "seen",
        "a 503 must not mean the command did not happen"
    );
}

// ------------------------------------------------------------------- lookup

/// The case that distinguishes a journal answer from a book answer.
#[tokio::test]
async fn the_lookup_finds_an_order_that_filled_completely_and_left_the_book() {
    let h = harness().await;
    h.place("maker", "sell", 10_000_000, 1_000_000).await;
    h.place("taker", "buy", 10_000_000, 1_000_000).await;

    let (status, body) = h
        .send(h.signed(
            "GET",
            "/v1/orders/lookup?clientOrderId=c-taker",
            "req-lookup",
            Value::Null,
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["outcome"], "seen",
        "the book no longer holds it; the journal does"
    );
    assert_eq!(body["seq"], 2);
    // The ENGINE's order id, not the client's: it is what every event carries,
    // and it is what the sweeper correlates against.
    assert_eq!(body["order_id"], "taker");
}

#[tokio::test]
async fn the_lookup_says_never_seen_for_an_order_it_never_received() {
    let h = harness().await;
    let (status, body) = h
        .send(h.signed(
            "GET",
            "/v1/orders/lookup?clientOrderId=c-ghost",
            "req-lookup",
            Value::Null,
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["outcome"], "never_seen");
}

// --------------------------------------------------------------- re-emission

#[tokio::test]
async fn re_emitted_events_are_identical_to_those_first_published() {
    let h = harness().await;
    for i in 0..8u64 {
        let side = if i % 2 == 0 { "sell" } else { "buy" };
        let price = if side == "sell" {
            11_000_000
        } else {
            10_000_000
        };
        h.place(&format!("o-{i}"), side, price, 1_000_000).await;
    }

    let (status, body) = h
        .send(h.signed("GET", "/v1/events?after=0", "req-events", Value::Null))
        .await;
    assert_eq!(status, StatusCode::OK);
    let replayed = body["events"].as_array().unwrap().clone();
    assert!(!replayed.is_empty());

    // Same range, again: re-emission is a pure read.
    let (_, body2) = h
        .send(h.signed("GET", "/v1/events?after=0", "req-events-2", Value::Null))
        .await;
    assert_eq!(replayed, *body2["events"].as_array().unwrap());
}

#[tokio::test]
async fn re_emission_after_the_last_sequence_is_empty_rather_than_an_error() {
    let h = harness().await;
    h.place("o-1", "buy", 10_000_000, 1_000_000).await;
    let (status, body) = h
        .send(h.signed("GET", "/v1/events?after=99", "req-events", Value::Null))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["events"].as_array().unwrap().is_empty());
}

// ------------------------------------------------------------ market control

#[tokio::test]
async fn a_status_change_is_journaled_and_survives_a_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config::local(dir.path(), market());

    {
        let h = build(config.clone(), tempfile::tempdir().unwrap()).await;
        // Rebuild the harness onto the real directory.
        drop(h);
    }

    let signer = CallerSigner::from_seed(&SEED);
    let service = Service::recover(&config, EventSink::Memory(MemorySink::new()))
        .await
        .expect("recover");
    let clock = Arc::new(AtomicI64::new(1_700_000_000));
    let reader = clock.clone();
    let state = Arc::new(AppState {
        service,
        verifier: Some(
            CallerVerifier::new(&signer.public_key_base64(), config.tolerance_seconds).unwrap(),
        ),
        replay: Mutex::new(ReplayCache::new(config.tolerance_seconds, 1000)),
        now: Box::new(move || reader.load(Ordering::SeqCst)),
    });
    let h = Harness {
        state,
        signer,
        clock,
        dir,
    };

    let (status, body) = h
        .send(h.signed(
            "POST",
            "/v1/markets/status",
            "req-halt",
            json!({ "timestamp_ms": TS, "status": "halted" }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["events"][0]["StatusChanged"]["current"], "halted");

    // A halt refuses placements.
    let (status, body) = h.place("o-1", "buy", 10_000_000, 1_000_000).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["events"][0]["Rejected"]["reason"], "MARKET_NOT_OPEN");

    // Restart: the status came back because it was journaled, not remembered.
    let service = Service::recover(&config, EventSink::Memory(MemorySink::new()))
        .await
        .expect("recover");
    assert_eq!(
        service.status().await,
        wallet_matching::types::MarketStatus::Halted
    );
}

// ----------------------------------------------------------------- restart

#[tokio::test]
async fn sequences_are_monotonic_across_a_restart_over_http() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config::local(dir.path(), market());

    {
        let service = Service::recover(&config, EventSink::Memory(MemorySink::new()))
            .await
            .expect("recover");
        let signer = CallerSigner::from_seed(&SEED);
        let clock = Arc::new(AtomicI64::new(1_700_000_000));
        let reader = clock.clone();
        let state = Arc::new(AppState {
            service,
            verifier: Some(
                CallerVerifier::new(&signer.public_key_base64(), config.tolerance_seconds).unwrap(),
            ),
            replay: Mutex::new(ReplayCache::new(config.tolerance_seconds, 1000)),
            now: Box::new(move || reader.load(Ordering::SeqCst)),
        });
        let h = Harness {
            state,
            signer,
            clock,
            dir: tempfile::tempdir().unwrap(),
        };
        for i in 0..3u64 {
            h.place(&format!("o-{i}"), "buy", 10_000_000, 1_000_000)
                .await;
        }
    }

    let service = Service::recover(&config, EventSink::Memory(MemorySink::new()))
        .await
        .expect("recover");
    assert_eq!(service.last_seq().await, 3);
    let submitted = service
        .submit(
            TS,
            wallet_matching::types::Command::Cancel {
                order_id: "o-0".into(),
            },
        )
        .await
        .expect("submit");
    assert_eq!(submitted.seq, 4, "sequencing must not restart at zero");
    drop(dir);
}

// ------------------------------------------------------------ configuration

#[test]
fn the_service_refuses_a_non_loopback_bind_with_no_caller_key() {
    let env = |name: &str| -> Option<String> {
        Some(
            match name {
                "MATCHING_DATA_DIR" => "/tmp/matching",
                "MATCHING_MARKET_ID" => "devnet:SOL-USDC",
                "MATCHING_TICK_SIZE" | "MATCHING_LOT_SIZE" | "MATCHING_MIN_NOTIONAL" => "1000000",
                "MATCHING_COLLAR_BPS" => "1000",
                "MATCHING_LISTEN" => "0.0.0.0:8080",
                _ => return None,
            }
            .to_string(),
        )
    };
    let error = Config::from_env(env).expect_err("must refuse");
    assert!(
        error
            .to_string()
            .contains("open port with no authentication"),
        "unexpected: {error}"
    );
}

#[test]
fn a_loopback_bind_with_no_caller_key_is_allowed_for_development() {
    let env = |name: &str| -> Option<String> {
        Some(
            match name {
                "MATCHING_DATA_DIR" => "/tmp/matching",
                "MATCHING_MARKET_ID" => "devnet:SOL-USDC",
                "MATCHING_TICK_SIZE" | "MATCHING_LOT_SIZE" | "MATCHING_MIN_NOTIONAL" => "1000000",
                "MATCHING_COLLAR_BPS" => "1000",
                _ => return None,
            }
            .to_string(),
        )
    };
    let config = Config::from_env(env).expect("loopback default");
    assert_eq!(config.listen, "127.0.0.1:8080");
    assert!(config.caller_public_key.is_none());
}
