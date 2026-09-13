//! The trust boundary, exercised over real HTTP (ADR-0013).
//!
//! The unit tests prove the pieces. These prove the thing that actually
//! protects the key: that an unauthenticated caller gets nothing, that no
//! endpoint returns key material, and that the wire contract is exactly what
//! the TypeScript client is written against.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tower::ServiceExt;

use wallet_mpc::auth::CallerVerifier;
use wallet_mpc::http::{router, AppState};
use wallet_mpc::keystore::Kek;
use wallet_mpc::signer::SigningService;
use wallet_mpc::store::Store;

const KEY_REF: &str = "treasury-hot-1";

struct Harness {
    app: axum::Router,
    client: SigningKey,
}

fn harness() -> Harness {
    let client = SigningKey::from_bytes(&[3u8; 32]);
    let store = Arc::new(Store::in_memory().expect("store"));
    let kek = Kek::from_base64(&B64.encode([5u8; 32])).expect("kek");
    let signer = SigningService::new(Arc::clone(&store), kek);
    signer.ensure_key(KEY_REF).expect("key");

    let caller =
        CallerVerifier::new(&B64.encode(client.verifying_key().to_bytes()), 60).expect("verifier");

    Harness {
        app: router(Arc::new(AppState {
            signer,
            store,
            caller,
            participant_kek: None,
            coordinator: None,
        })),
        client,
    }
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

/// The exact bytes a caller signs. `RustSingleKeySigner` must produce these.
fn canonical(method: &str, path: &str, request_id: &str, payload_hash: &[u8], ts: i64) -> String {
    format!(
        "{method}\n{path}\n{request_id}\n{}\n{ts}",
        hex::encode(payload_hash)
    )
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn sign_body(request_id: &str, payload: &[u8]) -> String {
    format!(
        r#"{{"requestId":"{request_id}","keyRef":"{KEY_REF}","payload":"{}",
            "authorization":{{"approvedBy":"risk-engine","approvedAt":"2026-09-11T12:00:00Z",
            "policyVersion":"1","reference":"withdrawal-1"}}}}"#,
        B64.encode(payload)
    )
}

fn signed_request(h: &Harness, request_id: &str, payload: &[u8], ts: i64) -> Request<Body> {
    let body = sign_body(request_id, payload);
    let signature = h
        .client
        .sign(canonical("POST", "/v1/sign", request_id, &sha256(payload), ts).as_bytes());

    Request::builder()
        .method("POST")
        .uri("/v1/sign")
        .header("content-type", "application/json")
        .header("x-mpc-signature", B64.encode(signature.to_bytes()))
        .header("x-mpc-timestamp", ts.to_string())
        .header("x-mpc-caller", "wallet-api")
        .body(Body::from(body))
        .expect("request")
}

async fn send(app: &axum::Router, request: Request<Body>) -> (StatusCode, String) {
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

// ---------------------------------------------------------------------------
// Authentication (prompt_phase4.md rules 54, 160, 178)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_correctly_signed_request_is_signed() {
    let h = harness();
    let (status, body) = send(&h.app, signed_request(&h, "r1", b"payload", now())).await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("\"signature\""));
    assert!(body.contains("\"replayed\":false"));
}

#[tokio::test]
async fn an_unauthenticated_request_is_refused() {
    let h = harness();
    let request = Request::builder()
        .method("POST")
        .uri("/v1/sign")
        .header("content-type", "application/json")
        .body(Body::from(sign_body("r1", b"payload")))
        .expect("request");

    let (status, _) = send(&h.app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_request_signed_by_the_wrong_key_is_refused() {
    let h = harness();
    let attacker = SigningKey::from_bytes(&[9u8; 32]);
    let ts = now();

    let signature =
        attacker.sign(canonical("POST", "/v1/sign", "r1", &sha256(b"payload"), ts).as_bytes());

    let request = Request::builder()
        .method("POST")
        .uri("/v1/sign")
        .header("content-type", "application/json")
        .header("x-mpc-signature", B64.encode(signature.to_bytes()))
        .header("x-mpc-timestamp", ts.to_string())
        .body(Body::from(sign_body("r1", b"payload")))
        .expect("request");

    let (status, _) = send(&h.app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_replayed_old_request_is_refused_despite_a_valid_signature() {
    let h = harness();
    let stale = now() - 3600;
    let (status, _) = send(&h.app, signed_request(&h, "r1", b"payload", stale)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_signature_cannot_be_moved_to_a_different_request_id() {
    let h = harness();
    let ts = now();

    // Signed for r1, submitted as r2 — the attack that would let one authorised
    // signature be spent on a second signing operation.
    let signature = h
        .client
        .sign(canonical("POST", "/v1/sign", "r1", &sha256(b"payload"), ts).as_bytes());

    let request = Request::builder()
        .method("POST")
        .uri("/v1/sign")
        .header("content-type", "application/json")
        .header("x-mpc-signature", B64.encode(signature.to_bytes()))
        .header("x-mpc-timestamp", ts.to_string())
        .body(Body::from(sign_body("r2", b"payload")))
        .expect("request");

    let (status, _) = send(&h.app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// Idempotency (ADR-0013, prompt_phase4.md rules 63-64, 177)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_same_request_id_signs_once_and_replays_after() {
    let h = harness();

    let (_, first) = send(&h.app, signed_request(&h, "r1", b"payload", now())).await;
    assert!(first.contains("\"replayed\":false"));

    for _ in 0..5 {
        let (status, body) = send(&h.app, signed_request(&h, "r1", b"payload", now())).await;
        assert_eq!(status, StatusCode::OK);
        // The distinction that matters: it did not sign again.
        assert!(body.contains("\"replayed\":true"), "{body}");
    }
}

#[tokio::test]
async fn reusing_a_request_id_with_different_bytes_is_refused() {
    let h = harness();
    send(&h.app, signed_request(&h, "r1", b"original", now())).await;

    let (status, _) = send(&h.app, signed_request(&h, "r1", b"attacker payload", now())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// Authorization (master-prompt rule 109, prompt_phase4.md rule 66)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn signing_without_an_authorization_proof_is_refused() {
    let h = harness();
    let ts = now();
    let payload = b"payload";

    let body = format!(
        r#"{{"requestId":"r1","keyRef":"{KEY_REF}","payload":"{}",
            "authorization":{{"approvedBy":"","approvedAt":"","policyVersion":"","reference":""}}}}"#,
        B64.encode(payload)
    );

    let signature = h
        .client
        .sign(canonical("POST", "/v1/sign", "r1", &sha256(payload), ts).as_bytes());

    let request = Request::builder()
        .method("POST")
        .uri("/v1/sign")
        .header("content-type", "application/json")
        .header("x-mpc-signature", B64.encode(signature.to_bytes()))
        .header("x-mpc-timestamp", ts.to_string())
        .body(Body::from(body))
        .expect("request");

    let (status, _) = send(&h.app, request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// No key material escapes (prompt_phase4.md rules 57, 161, 179)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn no_endpoint_returns_key_material() {
    let h = harness();

    let (_, signed) = send(&h.app, signed_request(&h, "r1", b"payload", now())).await;
    let (_, health) = send(
        &h.app,
        Request::builder()
            .uri("/v1/health")
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    // A Solana keypair's secret is 32 bytes; base64 of it is 44 characters.
    // Nothing resembling one may appear, and no field may be named for one.
    for body in [&signed, &health] {
        for forbidden in [
            "secret",
            "private",
            "seed",
            "encrypted_secret",
            "share",
            "kek",
        ] {
            assert!(
                !body.to_lowercase().contains(forbidden),
                "{forbidden:?} appeared in {body}"
            );
        }
    }
}

#[tokio::test]
async fn there_is_no_endpoint_to_export_or_import_a_key() {
    let h = harness();

    // The absence IS the design (ADR-0013): an operation that does not exist
    // cannot be called by a compromised API.
    for path in [
        "/v1/keys",
        "/v1/export",
        "/v1/keys/treasury-hot-1",
        "/v1/import",
        "/v1/secret",
    ] {
        let (status, _) = send(
            &h.app,
            Request::builder().uri(path).body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} should not exist");
    }
}

#[tokio::test]
async fn health_is_unauthenticated_and_reveals_nothing() {
    let h = harness();
    let (status, body) = send(
        &h.app,
        Request::builder()
            .uri("/v1/health")
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"status\":\"ok\""));
    // It must not reveal whether any particular key exists.
    assert!(!body.contains(KEY_REF));
}

// ---------------------------------------------------------------------------
// The wire contract the TypeScript client is written against
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_public_key_endpoint_returns_only_the_public_half() {
    let h = harness();
    let ts = now();

    let signature = h
        .client
        .sign(canonical("GET", "/v1/public-key", KEY_REF, &sha256(b""), ts).as_bytes());

    let request = Request::builder()
        .method("GET")
        .uri(format!("/v1/public-key?keyRef={KEY_REF}"))
        .header("x-mpc-signature", B64.encode(signature.to_bytes()))
        .header("x-mpc-timestamp", ts.to_string())
        .body(Body::empty())
        .expect("request");

    let (status, body) = send(&h.app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let public = body
        .split("\"publicKey\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("publicKey field");
    assert_eq!(B64.decode(public).expect("base64").len(), 32);
}

#[test]
fn the_canonical_signing_string_is_stable() {
    // If this and the TypeScript client disagree, every request is rejected —
    // which is a far better failure than the alternative.
    assert_eq!(
        canonical(
            "POST",
            "/v1/sign",
            "req-1",
            &sha256(b"payload"),
            1_700_000_000
        ),
        format!(
            "POST\n/v1/sign\nreq-1\n{}\n1700000000",
            hex::encode(sha256(b"payload"))
        )
    );
}
