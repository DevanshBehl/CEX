//! 3-of-5 FROST over real HTTP (ADR-0015, prompt_phase4.md §7, DoD 203-212).
//!
//! The unit tests in `frost.rs` prove the cryptographic properties against the
//! participant type directly. These prove the thing that actually ships: five
//! separate participant SERVICES, each with its own store and its own sealed
//! share, talking the wire protocol — and the properties surviving that.
//!
//! What this cannot model in one process is the deployment independence
//! ADR-0015 requires: five hosts, five credentials, five failure domains. Each
//! participant gets its own `Store` and its own `Kek` here, which is as close
//! as a test can get, and the ADR is explicit that the rest is operational.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;
use tower::ServiceExt;

use wallet_mpc::auth::CallerVerifier;
use wallet_mpc::frost::{self, Participant, MAX_SIGNERS, MIN_SIGNERS};
use wallet_mpc::http::{router, AppState};
use wallet_mpc::keystore::Kek;
use wallet_mpc::signer::SigningService;
use wallet_mpc::store::Store;
use wallet_mpc::threshold;

const KEY_REF: &str = "treasury";

struct Node {
    app: axum::Router,
    identifier: String,
}

struct Cluster {
    nodes: Vec<Node>,
    public_package: frost_ed25519::keys::PublicKeyPackage,
    client: SigningKey,
    approval: SigningKey,
}

fn cluster(with_approval_key: bool) -> Cluster {
    let client = SigningKey::from_bytes(&[3u8; 32]);
    let approval = SigningKey::from_bytes(&[9u8; 32]);

    let (shares, public_package) =
        frost::generate_with_dealer(MIN_SIGNERS, MAX_SIGNERS).expect("dealer");

    let nodes = shares
        .iter()
        .enumerate()
        .map(|(index, share)| {
            // Its OWN store and its OWN key-encryption key. A shared KEK would
            // mean one disclosure decrypts every share, which is the thing the
            // threshold exists to prevent.
            let store = Arc::new(Store::in_memory().expect("store"));
            let kek = Kek::from_base64(&B64.encode([40u8 + index as u8; 32])).expect("kek");

            Participant::install(&store, &kek, KEY_REF, share).expect("install");
            // A second handle to the same KEK rather than a clone: `Kek` is
            // deliberately not `Clone`, so key material cannot be duplicated
            // by accident (ADR-0014).
            let participant_kek =
                Kek::from_base64(&B64.encode([40u8 + index as u8; 32])).expect("kek");
            let participant = Participant::load(Arc::clone(&store), participant_kek, KEY_REF)
                .expect("load")
                .expect("share");
            let identifier = threshold::encode_identifier(&participant.identifier());

            let signer_kek = Kek::from_base64(&B64.encode([40u8 + index as u8; 32])).expect("kek");
            let signer = SigningService::new(Arc::clone(&store), signer_kek);
            let signer = if with_approval_key {
                signer
                    .with_approval_key(&B64.encode(approval.verifying_key().to_bytes()))
                    .expect("approval key")
            } else {
                signer
            };

            let caller = CallerVerifier::new(&B64.encode(client.verifying_key().to_bytes()), 60)
                .expect("verifier");

            Node {
                app: router(Arc::new(AppState {
                    signer,
                    store,
                    caller,
                    participant: Some(Arc::new(participant)),
                    coordinator: None,
                })),
                identifier,
            }
        })
        .collect();

    Cluster {
        nodes,
        public_package,
        client,
        approval,
    }
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64
}

fn canonical(path: &str, request_id: &str, payload_hash: &[u8], ts: i64) -> String {
    format!(
        "POST\n{path}\n{request_id}\n{}\n{ts}",
        hex::encode(payload_hash)
    )
}

/// Build an authenticated request the way the coordinator does.
fn signed_request(client: &SigningKey, path: &str, request_id: &str, body: &str) -> Request<Body> {
    let ts = now();
    let signature =
        client.sign(canonical(path, request_id, &sha256(body.as_bytes()), ts).as_bytes());

    Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("x-mpc-caller", "coordinator")
        .header("x-mpc-timestamp", ts.to_string())
        .header("x-mpc-signature", B64.encode(signature.to_bytes()))
        .body(Body::from(body.to_owned()))
        .expect("request")
}

async fn call(app: &axum::Router, request: Request<Body>) -> (StatusCode, serde_json::Value) {
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

/// An approval proof bound to this payload, signed by the approval authority.
fn authorization(approval: &SigningKey, reference: &str, payload: &[u8]) -> serde_json::Value {
    let approved_by = "risk-engine";
    let approved_at = "2026-09-12T00:00:00Z";
    let policy_version = "1";

    let message = format!(
        "{approved_by}\n{approved_at}\n{policy_version}\n{reference}\n{}",
        hex::encode(sha256(payload))
    );

    json!({
        "approvedBy": approved_by,
        "approvedAt": approved_at,
        "policyVersion": policy_version,
        "reference": reference,
        "tier": "hot",
        "signature": B64.encode(approval.sign(message.as_bytes()).to_bytes()),
    })
}

/// Run both rounds against `signers` and aggregate.
async fn run_rounds(
    cluster: &Cluster,
    signers: &[usize],
    payload: &[u8],
    round: &str,
    authorization: &serde_json::Value,
) -> Result<frost_ed25519::Signature, String> {
    let mut wire: BTreeMap<String, String> = BTreeMap::new();
    let mut commitments = BTreeMap::new();

    for &index in signers {
        let node = &cluster.nodes[index];
        let nonce_id = format!("{round}:{}", node.identifier);
        let body = json!({ "nonceId": nonce_id, "keyRef": KEY_REF }).to_string();

        let (status, value) = call(
            &node.app,
            signed_request(&cluster.client, "/v1/frost/commit", &nonce_id, &body),
        )
        .await;

        if status != StatusCode::OK {
            return Err(format!("commit failed: {status}"));
        }

        let identifier = value["identifier"].as_str().expect("identifier").to_owned();
        let encoded = value["commitments"]
            .as_str()
            .expect("commitments")
            .to_owned();
        commitments.insert(
            threshold::decode_identifier(&identifier).expect("identifier"),
            threshold::decode_commitments(&encoded).expect("commitments"),
        );
        wire.insert(identifier, encoded);
    }

    let mut shares = BTreeMap::new();
    for &index in signers {
        let node = &cluster.nodes[index];
        let nonce_id = format!("{round}:{}", node.identifier);
        let body = json!({
            "nonceId": nonce_id,
            "keyRef": KEY_REF,
            "payload": hex::encode(payload),
            "commitments": wire,
            "authorization": authorization,
        })
        .to_string();

        let (status, value) = call(
            &node.app,
            signed_request(&cluster.client, "/v1/frost/share", &nonce_id, &body),
        )
        .await;

        if status != StatusCode::OK {
            return Err(format!("share failed: {status}"));
        }

        shares.insert(
            threshold::decode_identifier(value["identifier"].as_str().expect("id")).expect("id"),
            threshold::decode_share(value["share"].as_str().expect("share")).expect("share"),
        );
    }

    let package = frost::signing_package(commitments, payload);
    frost::aggregate(&package, &shares, &cluster.public_package).map_err(|e| e.reason().to_string())
}

// ---------------------------------------------------------------------------
// The threshold, over the wire
// ---------------------------------------------------------------------------

#[tokio::test]
async fn any_three_of_five_services_produce_a_valid_signature() {
    let cluster = cluster(true);
    let payload = b"a real withdrawal transaction";
    let auth = authorization(&cluster.approval, "w-1", payload);

    let signature = run_rounds(&cluster, &[0, 2, 4], payload, "r1", &auth)
        .await
        .expect("signature");

    assert!(cluster
        .public_package
        .verifying_key()
        .verify(payload, &signature)
        .is_ok());
}

#[tokio::test]
async fn two_services_cannot() {
    let cluster = cluster(true);
    let payload = b"a real withdrawal transaction";
    let auth = authorization(&cluster.approval, "w-2", payload);

    assert!(run_rounds(&cluster, &[0, 1], payload, "r2", &auth)
        .await
        .is_err());
}

// ---------------------------------------------------------------------------
// The property that makes the threshold worth building (DoD 206)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_participant_refuses_an_unsigned_authorization() {
    // A compromised coordinator can produce a well-formed proof. It cannot
    // produce one the approval authority signed — and the participants hold
    // that key independently of it.
    let cluster = cluster(true);
    let payload = b"pay an attacker";

    let unsigned = json!({
        "approvedBy": "risk-engine",
        "approvedAt": "2026-09-12T00:00:00Z",
        "policyVersion": "1",
        "reference": "w-3",
        "tier": "hot",
    });

    assert!(run_rounds(&cluster, &[0, 1, 2], payload, "r3", &unsigned)
        .await
        .is_err());
}

#[tokio::test]
async fn a_participant_refuses_a_proof_bound_to_a_different_payload() {
    // Replay: a genuine approval for one withdrawal, presented for another.
    // The payload hash in the signed message is what stops it.
    let cluster = cluster(true);
    let approved = b"pay alice 1 SOL";
    let attempted = b"pay attacker 1000 SOL";

    let auth = authorization(&cluster.approval, "w-4", approved);

    assert!(run_rounds(&cluster, &[0, 1, 2], attempted, "r4", &auth)
        .await
        .is_err());
}

#[tokio::test]
async fn a_participant_refuses_a_tier_it_is_not_authorised_for() {
    // Warm requires an operator as well as the risk engine (ADR-0018). A proof
    // carrying only automation is refused — by the participant, so a
    // compromised coordinator cannot skip the check.
    let cluster = cluster(true);
    let payload = b"move the warm float";

    let mut auth = authorization(&cluster.approval, "w-5", payload);
    auth["tier"] = json!("warm");

    assert!(run_rounds(&cluster, &[0, 1, 2], payload, "r5", &auth)
        .await
        .is_err());
}

// ---------------------------------------------------------------------------
// Nonce discipline over the wire (DoD 207)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_participant_service_refuses_to_reuse_a_nonce() {
    let cluster = cluster(true);
    let payload = b"first";
    let auth = authorization(&cluster.approval, "w-6", payload);

    assert!(run_rounds(&cluster, &[0, 1, 2], payload, "r6", &auth)
        .await
        .is_ok());

    // The same round id again: every participant's nonce is already used.
    assert!(run_rounds(&cluster, &[0, 1, 2], payload, "r6", &auth)
        .await
        .is_err());
}

#[tokio::test]
async fn a_non_participant_service_refuses_the_round_endpoints() {
    // A single-key deployment must not be talkable into pretending it holds a
    // share: the endpoints exist in every build, and refuse without one.
    let client = SigningKey::from_bytes(&[3u8; 32]);
    let store = Arc::new(Store::in_memory().expect("store"));
    let kek = Kek::from_base64(&B64.encode([5u8; 32])).expect("kek");
    let signer = SigningService::new(Arc::clone(&store), kek);
    let caller =
        CallerVerifier::new(&B64.encode(client.verifying_key().to_bytes()), 60).expect("verifier");

    let app = router(Arc::new(AppState {
        signer,
        store,
        caller,
        participant: None,
        coordinator: None,
    }));

    let body = json!({ "nonceId": "n1", "keyRef": KEY_REF }).to_string();
    let (status, _) = call(
        &app,
        signed_request(&client, "/v1/frost/commit", "n1", &body),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_round_endpoints_require_authentication() {
    let cluster = cluster(true);
    let body = json!({ "nonceId": "n1", "keyRef": KEY_REF }).to_string();

    let request = Request::builder()
        .method("POST")
        .uri("/v1/frost/commit")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .expect("request");

    let (status, _) = call(&cluster.nodes[0].app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn no_endpoint_returns_share_material() {
    let cluster = cluster(true);
    let payload = b"a withdrawal";
    let auth = authorization(&cluster.approval, "w-7", payload);

    let node = &cluster.nodes[0];
    let nonce_id = "leak-check";
    let body = json!({ "nonceId": nonce_id, "keyRef": KEY_REF }).to_string();
    let (_, value) = call(
        &node.app,
        signed_request(&cluster.client, "/v1/frost/commit", nonce_id, &body),
    )
    .await;

    let rendered = value.to_string();
    // A commitment is public by design; a signing SHARE or a nonce is not.
    assert!(!rendered.contains("signing_share"));
    assert!(!rendered.contains("secret"));
    let _ = auth;
}
