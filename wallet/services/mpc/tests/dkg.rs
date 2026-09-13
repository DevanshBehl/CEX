//! Distributed key generation over real sockets (ADR-0023).
//!
//! Five participant services and a coordinator service, each bound to its own
//! ephemeral port, each participant with its own store, KEK and pinned DKG
//! roster. The coordinator reaches participants through its HTTP client and
//! the test reaches the coordinator through its authenticated `/v1/frost/dkg/init`
//! route — the path the TypeScript API takes.
//!
//! Every participant router is wrapped in a small control layer so a test can
//! take a participant down, fail one request, or make it MALICIOUS: a
//! participant that seals a forged share correctly under the real transport
//! keys. Only the last proves that recipients reject a share on its
//! mathematics, not merely on its encryption.

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{from_fn_with_state, Next};
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer as _, SigningKey};
use frost_ed25519 as frost;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use wallet_mpc::auth::{CallerSigner, CallerVerifier};
use wallet_mpc::dkg::{seal_share, DkgContext, DkgIdentity, DkgRound2Request, DkgRound2Response};
use wallet_mpc::frost::{MAX_SIGNERS, MIN_SIGNERS};
use wallet_mpc::http::{router, AppState};
use wallet_mpc::keystore::Kek;
use wallet_mpc::signer::{AuthorizationProof, SigningService};
use wallet_mpc::store::Store;
use wallet_mpc::threshold::{encode_identifier, Coordinator, DkgInitResponse, ParticipantEndpoint};

const COORDINATOR_SEED: [u8; 32] = [3u8; 32];
const API_SEED: [u8; 32] = [4u8; 32];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Controls {
    /// Every request answers 503.
    down: AtomicBool,
    /// The next request to this path answers 503, once.
    fail_once: Mutex<Option<&'static str>>,
    /// Paths served, in order.
    hits: Mutex<Vec<String>>,
    /// When set, this participant forges its round-2 share for the named
    /// recipient (hex identifier).
    forge_for: Mutex<Option<String>>,
}

struct NodeControl {
    controls: Arc<Controls>,
    /// The participant's own transport identity and roster — what a malicious
    /// build of the participant software would have.
    context: DkgContext,
}

struct ParticipantNode {
    identifier: String,
    store: Arc<Store>,
    seed: [u8; 32],
    controls: Arc<Controls>,
}

impl ParticipantNode {
    fn kek(&self) -> Kek {
        Kek::from_base64(&B64.encode(self.seed)).unwrap()
    }

    fn rounds_served(&self) -> usize {
        self.controls
            .hits
            .lock()
            .unwrap()
            .iter()
            .filter(|path| path.starts_with("/v1/frost/dkg/"))
            .count()
    }

    fn key_package(&self, key_ref: &str) -> Option<frost::keys::KeyPackage> {
        let (_, _, sealed, _) = self.store.load_share(key_ref).unwrap()?;
        Some(postcard::from_bytes(&self.kek().open(&sealed).unwrap()).unwrap())
    }
}

struct Cluster {
    participants: Vec<ParticipantNode>,
    coordinator: Arc<Coordinator>,
    coordinator_url: String,
    coordinator_db: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

async fn control(State(node): State<Arc<NodeControl>>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    if node.controls.down.load(Ordering::SeqCst) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    node.controls.hits.lock().unwrap().push(path.clone());
    {
        let mut once = node.controls.fail_once.lock().unwrap();
        if once.as_deref() == Some(path.as_str()) {
            *once = None;
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }

    let victim = node.controls.forge_for.lock().unwrap().clone();
    let (Some(victim), true) = (victim, path == "/v1/frost/dkg/round2") else {
        return next.run(request).await;
    };

    // The malicious path: run the honest round, then swap the victim's
    // envelope for one carrying a share that is NOT f_self(victim).
    let (parts, body) = request.into_parts();
    let body = to_bytes(body, usize::MAX).await.unwrap();
    let round2: DkgRound2Request = serde_json::from_slice(&body).unwrap();
    let response = next.run(Request::from_parts(parts, Body::from(body))).await;
    if !response.status().is_success() {
        return response;
    }
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let mut honest: DkgRound2Response = serde_json::from_slice(&bytes).unwrap();

    let transcript: [u8; 32] = hex::decode(&honest.transcript_hash)
        .unwrap()
        .try_into()
        .unwrap();
    let mut scalar = [0u8; 32];
    scalar[0] = 42;
    let forged = frost::keys::dkg::round2::Package::new(
        frost::keys::SigningShare::deserialize(&scalar).unwrap(),
    );
    let victim_id = wallet_mpc::threshold::decode_identifier(&victim).unwrap();
    let envelope = seal_share(
        &node.context,
        victim_id,
        &round2.session_id,
        &round2.key_ref,
        &transcript,
        &forged,
    )
    .unwrap();
    for slot in honest.envelopes.iter_mut() {
        if slot.recipient == victim {
            *slot = envelope.clone();
        }
    }
    axum::Json(honest).into_response()
}

async fn serve(app: axum::Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    format!("http://{address}")
}

fn public_b64(seed: &[u8; 32]) -> String {
    B64.encode(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}

async fn spawn_cluster() -> Cluster {
    spawn_cluster_trusting(&public_b64(&COORDINATOR_SEED)).await
}

/// Five participants that trust `trusted_caller`, and a coordinator.
async fn spawn_cluster_trusting(trusted_caller: &str) -> Cluster {
    let seeds: Vec<[u8; 32]> = (0..MAX_SIGNERS).map(|i| [70u8 + i as u8; 32]).collect();
    let stores: Vec<Arc<Store>> = seeds
        .iter()
        .map(|_| Arc::new(Store::in_memory().unwrap()))
        .collect();

    // Each participant generates its transport key INSIDE its own store; the
    // operator pins the public halves in every participant's roster.
    let roster: BTreeMap<frost::Identifier, [u8; 32]> = stores
        .iter()
        .zip(&seeds)
        .enumerate()
        .map(|(i, (store, seed))| {
            let identity =
                DkgIdentity::load_or_create(store, &Kek::from_base64(&B64.encode(seed)).unwrap())
                    .unwrap();
            (
                frost::Identifier::try_from(i as u16 + 1).unwrap(),
                identity.public_key(),
            )
        })
        .collect();

    let mut participants = Vec::new();
    let mut endpoints = Vec::new();
    for (store, seed) in stores.into_iter().zip(seeds) {
        let kek = || Kek::from_base64(&B64.encode(seed)).unwrap();
        let context = || {
            DkgContext::new(
                DkgIdentity::load_or_create(&store, &kek()).unwrap(),
                roster.clone(),
            )
            .unwrap()
        };
        let identifier = encode_identifier(&context().identifier());
        let controls = Arc::new(Controls::default());

        let app = router(Arc::new(AppState {
            signer: SigningService::new(Arc::clone(&store), kek()),
            store: Arc::clone(&store),
            caller: CallerVerifier::new(trusted_caller, 60).unwrap(),
            participant_kek: Some(kek()),
            dkg: Some(context()),
            coordinator: None,
        }))
        .layer(from_fn_with_state(
            Arc::new(NodeControl {
                controls: Arc::clone(&controls),
                context: context(),
            }),
            control,
        ));

        endpoints.push(ParticipantEndpoint {
            url: serve(app).await,
            identifier: identifier.clone(),
        });
        participants.push(ParticipantNode {
            identifier,
            store,
            seed,
            controls,
        });
    }

    // File-backed, so the "what did the coordinator learn" test can read every
    // byte it persisted with an independent SQLite connection.
    let dir = tempfile::tempdir().unwrap();
    let coordinator_db = dir.path().join("coordinator.sqlite");
    let coordinator_store = Arc::new(Store::open(&coordinator_db).unwrap());
    let coordinator = Arc::new(
        Coordinator::new(
            endpoints,
            None,
            CallerSigner::from_base64(&B64.encode(COORDINATOR_SEED)).unwrap(),
            Arc::clone(&coordinator_store),
            std::time::Duration::from_secs(10),
        )
        .unwrap(),
    );

    let coordinator_url = serve(router(Arc::new(AppState {
        signer: SigningService::new(
            Arc::clone(&coordinator_store),
            Kek::from_base64(&B64.encode([90u8; 32])).unwrap(),
        ),
        store: coordinator_store,
        caller: CallerVerifier::new(&public_b64(&API_SEED), 60).unwrap(),
        participant_kek: None,
        dkg: None,
        coordinator: Some(Arc::clone(&coordinator)),
    })))
    .await;

    Cluster {
        participants,
        coordinator,
        coordinator_url,
        coordinator_db,
        _dir: dir,
    }
}

/// POST /v1/frost/dkg/init as the API does: body serialised once, signed over
/// its hash with the idempotency key in the request-id slot.
async fn init_over_http(
    cluster: &Cluster,
    key_ref: &str,
    idempotency_key: &str,
) -> Result<DkgInitResponse, StatusCode> {
    let body =
        serde_json::json!({ "keyRef": key_ref, "idempotencyKey": idempotency_key }).to_string();
    let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
    let canonical = format!(
        "POST\n/v1/frost/dkg/init\n{idempotency_key}\n{}\n{timestamp}",
        hex::encode(Sha256::digest(body.as_bytes()))
    );
    let signature = SigningKey::from_bytes(&API_SEED).sign(canonical.as_bytes());

    let response = reqwest::Client::new()
        .post(format!("{}/v1/frost/dkg/init", cluster.coordinator_url))
        .header("content-type", "application/json")
        .header("x-mpc-signature", B64.encode(signature.to_bytes()))
        .header("x-mpc-timestamp", timestamp.to_string())
        .header("x-mpc-caller", "wallet-api")
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    if !status.is_success() {
        return Err(StatusCode::from_u16(status.as_u16()).unwrap());
    }
    Ok(response.json().await.unwrap())
}

fn proof(reference: &str) -> AuthorizationProof {
    AuthorizationProof {
        approved_by: "risk-engine".into(),
        approved_at: "2026-09-13T00:00:00Z".into(),
        policy_version: "1".into(),
        reference: reference.into(),
        tier: None,
        signature: None,
    }
}

/// Verify an aggregate signature against the base58 ADDRESS the API was
/// given, decoded independently of the service.
fn verify_against_address(address: &str, payload: &[u8], signature: &frost::Signature) {
    let bytes = signature.serialize().unwrap();
    let key: [u8; 32] = bs58_decode(address)
        .as_slice()
        .try_into()
        .expect("32 bytes");
    ed25519_dalek::VerifyingKey::from_bytes(&key)
        .expect("address is a valid point")
        .verify_strict(
            payload,
            &ed25519_dalek::Signature::from_bytes(&bytes.as_slice().try_into().unwrap()),
        )
        .expect("the address can be spent by the group");
}

fn bs58_decode(encoded: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut bytes: Vec<u8> = vec![0];
    for character in encoded.bytes() {
        let mut carry = ALPHABET.iter().position(|c| *c == character).unwrap() as u32;
        for byte in bytes.iter_mut().rev() {
            let next = u32::from(*byte) * 58 + carry;
            *byte = (next & 0xff) as u8;
            carry = next >> 8;
        }
        while carry > 0 {
            bytes.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let leading = encoded.bytes().take_while(|c| *c == b'1').count();
    let significant = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    let mut out = vec![0u8; leading];
    out.extend_from_slice(&bytes[significant..]);
    out
}

/// Every value in every table, as bytes.
fn every_persisted_byte(path: &std::path::Path) -> Vec<Vec<u8>> {
    let connection = rusqlite::Connection::open(path).unwrap();
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();

    let mut values = Vec::new();
    for table in tables {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM \"{table}\""))
            .unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for column in 0..columns {
                use rusqlite::types::ValueRef;
                match row.get_ref(column).unwrap() {
                    ValueRef::Blob(b) => values.push(b.to_vec()),
                    ValueRef::Text(t) => values.push(t.to_vec()),
                    _ => {}
                }
            }
        }
    }
    values
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_five_party_ceremony_over_sockets_yields_a_key_any_three_can_sign_with() {
    let cluster = spawn_cluster().await;

    let generated = init_over_http(&cluster, "user:alice", "signup:alice")
        .await
        .expect("DKG over HTTP");
    assert!(!generated.existing);
    assert_eq!(generated.generation, "dkg");
    assert_eq!(generated.threshold, MIN_SIGNERS);
    assert_eq!(generated.participants, MAX_SIGNERS);
    assert_eq!(generated.verifying_shares.len(), MAX_SIGNERS as usize);

    // Every participant committed exactly the group the API was told about.
    for node in &cluster.participants {
        let package = node.key_package("user:alice").expect("share installed");
        assert_eq!(
            hex::encode(package.verifying_share().serialize().unwrap()),
            generated.verifying_shares[&node.identifier]
        );
    }

    // Any three: take two participants down each time, a different two.
    for (round, down) in [[3usize, 4], [0, 1], [0, 2]].iter().enumerate() {
        for node in &cluster.participants {
            node.controls.down.store(false, Ordering::SeqCst);
        }
        for index in down {
            cluster.participants[*index]
                .controls
                .down
                .store(true, Ordering::SeqCst);
        }

        let payload = format!("withdrawal from alice, signers without {down:?}");
        let signature = cluster
            .coordinator
            .sign(
                &format!("req-alice-{round}"),
                "user:alice",
                payload.as_bytes(),
                &proof(&format!("w-alice-{round}")),
            )
            .await
            .expect("three participants sign immediately after the ceremony");
        verify_against_address(&generated.group_public_key, payload.as_bytes(), &signature);
    }

    // And two cannot.
    for node in &cluster.participants[..3] {
        node.controls.down.store(true, Ordering::SeqCst);
    }
    cluster.participants[3]
        .controls
        .down
        .store(false, Ordering::SeqCst);
    cluster.participants[4]
        .controls
        .down
        .store(false, Ordering::SeqCst);
    assert!(cluster
        .coordinator
        .sign("req-alice-two", "user:alice", b"x", &proof("w-alice-two"))
        .await
        .is_err());
}

#[tokio::test]
async fn each_user_gets_an_independent_key() {
    let cluster = spawn_cluster().await;
    let alice = init_over_http(&cluster, "user:a", "k-a").await.unwrap();
    let bob = init_over_http(&cluster, "user:b", "k-b").await.unwrap();
    assert_ne!(alice.group_public_key, bob.group_public_key);

    // A key_ref nobody generated cannot be signed for, and does not fall back
    // to any other user's key.
    assert!(cluster
        .coordinator
        .sign("req-nobody", "user:nobody", b"payload", &proof("w-nobody"))
        .await
        .is_err());
}

// ---------------------------------------------------------------------------
// 2. Invalid share rejection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_forged_round2_share_aborts_the_recipient_before_any_key_state_is_saved() {
    let cluster = spawn_cluster().await;
    let victim = &cluster.participants[0];
    let forger = &cluster.participants[1];
    *forger.controls.forge_for.lock().unwrap() = Some(victim.identifier.clone());

    assert_eq!(
        init_over_http(&cluster, "user:mallory-target", "k-forge")
            .await
            .err(),
        Some(StatusCode::INTERNAL_SERVER_ERROR),
        "the ceremony must fail"
    );

    // The victim refused in round 3, wiped its session secret, and installed
    // nothing.
    assert!(victim
        .store
        .load_share("user:mallory-target")
        .unwrap()
        .is_none());
    let rows = latest_session(&victim.store, "user:mallory-target");
    assert_eq!(rows.0, "aborted");
    assert_eq!(rows.1.as_deref(), Some("dkg_invalid_share"));
    assert!(rows.2, "the aborted session's secret must be wiped");

    // Nobody committed: the coordinator never reached the commit step, so no
    // participant holds a share and the coordinator recorded no address.
    for node in &cluster.participants {
        assert!(node
            .store
            .load_share("user:mallory-target")
            .unwrap()
            .is_none());
        assert!(!node
            .controls
            .hits
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == "/v1/frost/dkg/commit"));
    }
    assert!(cluster
        .coordinator
        .stored_house_package("user:mallory-target")
        .unwrap()
        .is_none());
}

/// `(phase, failure_reason, secret_wiped)` of the participant's most recent
/// session for a key.
fn latest_session(store: &Store, key_ref: &str) -> (String, Option<String>, bool) {
    let session = store
        .latest_dkg_session(key_ref)
        .unwrap()
        .expect("the participant took part");
    (
        session.phase,
        session.failure_reason,
        session.sealed_secret.is_none(),
    )
}

// ---------------------------------------------------------------------------
// 3. Threshold security: the coordinator learns nothing secret
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_coordinators_state_contains_no_private_key_material() {
    let cluster = spawn_cluster().await;
    let generated = init_over_http(&cluster, "user:inspect", "k-inspect")
        .await
        .unwrap();

    let packages: Vec<_> = cluster
        .participants
        .iter()
        .map(|node| node.key_package("user:inspect").unwrap())
        .collect();

    // What an attacker would want: the group secret (reconstructed HERE, by
    // the test, from three shares — the one thing the system never does) and
    // every individual signing share.
    let group_secret = frost::keys::reconstruct(&packages[..3]).unwrap();
    assert_eq!(
        bs58_decode(&generated.group_public_key),
        frost::VerifyingKey::from(&group_secret)
            .serialize()
            .unwrap(),
        "sanity: three shares do reconstruct the address's key"
    );
    // Below threshold the library refuses outright. (That two shares carry
    // ZERO information about the secret is a property of degree-2 Shamir
    // sharing, proven rather than testable; ADR-0023 states it.)
    assert!(frost::keys::reconstruct(&packages[..2]).is_err());

    let mut secrets: Vec<Vec<u8>> = vec![group_secret.serialize()];
    secrets.extend(packages.iter().map(|p| p.signing_share().serialize()));

    let persisted = every_persisted_byte(&cluster.coordinator_db);
    let transcript = persisted
        .iter()
        .find(|value| contains(value, b"\"round2\""))
        .expect("the coordinator persisted its transcript");
    assert!(
        contains(transcript, b"ciphertext"),
        "sanity: the transcript includes the envelopes it routed"
    );

    for secret in &secrets {
        let encodings = [
            secret.clone(),
            hex::encode(secret).into_bytes(),
            B64.encode(secret).into_bytes(),
        ];
        for value in &persisted {
            for encoding in &encodings {
                assert!(
                    !contains(value, encoding),
                    "coordinator state contains private key material"
                );
            }
        }
    }

    // And none of the tables a key would live in has a row.
    let connection = rusqlite::Connection::open(&cluster.coordinator_db).unwrap();
    for table in [
        "keys",
        "frost_shares",
        "frost_nonces",
        "dkg_identity",
        "frost_dkg_sessions",
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "coordinator has rows in {table}");
    }
}

#[tokio::test]
async fn participants_seal_their_shares_at_rest() {
    let cluster = spawn_cluster().await;
    init_over_http(&cluster, "user:rest", "k-rest")
        .await
        .unwrap();
    for node in &cluster.participants {
        let (_, _, sealed, _) = node.store.load_share("user:rest").unwrap().unwrap();
        let share = node
            .key_package("user:rest")
            .unwrap()
            .signing_share()
            .serialize();
        assert!(!contains(&sealed, &share));
    }
}

// ---------------------------------------------------------------------------
// 4. Idempotency and abort
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_second_init_returns_the_existing_key_without_running_rounds() {
    let cluster = spawn_cluster().await;
    let first = init_over_http(&cluster, "user:carol", "k-carol")
        .await
        .unwrap();
    let rounds: Vec<usize> = cluster
        .participants
        .iter()
        .map(|n| n.rounds_served())
        .collect();
    assert!(
        rounds.iter().all(|r| *r == 4),
        "round1, round2, finalize, commit: {rounds:?}"
    );

    // Same idempotency key, and a different one: both return the same key.
    let again = init_over_http(&cluster, "user:carol", "k-carol")
        .await
        .unwrap();
    let retry = init_over_http(&cluster, "user:carol", "k-carol-retry")
        .await
        .unwrap();
    for response in [&again, &retry] {
        assert!(response.existing);
        assert_eq!(response.group_public_key, first.group_public_key);
        assert_eq!(response.verifying_shares, first.verifying_shares);
    }

    let after: Vec<usize> = cluster
        .participants
        .iter()
        .map(|n| n.rounds_served())
        .collect();
    assert_eq!(rounds, after, "no participant saw a new round");
}

#[tokio::test]
async fn an_idempotency_key_cannot_be_reused_for_another_key_ref() {
    let cluster = spawn_cluster().await;
    init_over_http(&cluster, "user:dan", "k-shared")
        .await
        .unwrap();
    assert_eq!(
        init_over_http(&cluster, "user:erin", "k-shared")
            .await
            .err(),
        Some(StatusCode::BAD_REQUEST)
    );
}

#[tokio::test]
async fn concurrent_inits_for_one_key_ref_yield_one_key() {
    let cluster = Arc::new(spawn_cluster().await);
    let attempts: Vec<_> = (0..4)
        .map(|i| {
            let cluster = Arc::clone(&cluster);
            tokio::spawn(async move {
                cluster
                    .coordinator
                    .run_dkg("user:race", &format!("race-{i}"))
                    .await
                    .map(|r| r.group_public_key)
            })
        })
        .collect();

    let mut addresses = HashSet::new();
    for attempt in attempts {
        addresses.insert(attempt.await.unwrap().expect("init"));
    }
    assert_eq!(addresses.len(), 1);

    cluster
        .coordinator
        .sign("req-race", "user:race", b"payload", &proof("w-race"))
        .await
        .expect("the one ceremony produced a whole share set");
}

#[tokio::test]
async fn an_aborted_ceremony_leaves_nothing_and_a_retry_starts_clean() {
    let cluster = spawn_cluster().await;
    // Participant 4 fails its FINALIZE once — after every participant has run
    // rounds 1 and 2, and after participants 1-3 hold verified pending shares.
    *cluster.participants[3].controls.fail_once.lock().unwrap() = Some("/v1/frost/dkg/finalize");

    assert!(init_over_http(&cluster, "user:frank", "k-frank")
        .await
        .is_err());
    for node in &cluster.participants {
        assert!(node.store.load_share("user:frank").unwrap().is_none());
    }
    assert!(cluster
        .coordinator
        .stored_house_package("user:frank")
        .unwrap()
        .is_none());

    // Retry: a NEW session. The participants' abandoned sessions are
    // superseded and their secrets wiped.
    let generated = init_over_http(&cluster, "user:frank", "k-frank")
        .await
        .unwrap();
    assert!(!generated.existing);
    cluster
        .coordinator
        .sign("req-frank", "user:frank", b"payload", &proof("w-frank"))
        .await
        .expect("the retried ceremony signs");
}

#[tokio::test]
async fn a_partially_committed_ceremony_is_resumed_not_restarted() {
    let cluster = spawn_cluster().await;
    // Participant 5 fails its COMMIT once: four participants have installed
    // their share. Restarting would be refused by those four forever; the
    // coordinator must resume the verified ceremony instead.
    *cluster.participants[4].controls.fail_once.lock().unwrap() = Some("/v1/frost/dkg/commit");

    assert!(init_over_http(&cluster, "user:gina", "k-gina")
        .await
        .is_err());
    assert!(cluster.participants[0]
        .store
        .load_share("user:gina")
        .unwrap()
        .is_some());
    assert!(cluster.participants[4]
        .store
        .load_share("user:gina")
        .unwrap()
        .is_none());
    // The address is NOT recorded while any participant lacks its share.
    assert!(cluster
        .coordinator
        .stored_house_package("user:gina")
        .unwrap()
        .is_none());

    let before: Vec<usize> = cluster
        .participants
        .iter()
        .map(|n| n.rounds_served())
        .collect();
    let generated = init_over_http(&cluster, "user:gina", "k-gina")
        .await
        .unwrap();
    let after: Vec<usize> = cluster
        .participants
        .iter()
        .map(|n| n.rounds_served())
        .collect();

    // Only commit calls were made on resume.
    for (b, a) in before.iter().zip(&after) {
        assert_eq!(a - b, 1);
    }
    assert!(cluster.participants[4]
        .store
        .load_share("user:gina")
        .unwrap()
        .is_some());

    let payload = b"gina pays";
    let signature = cluster
        .coordinator
        .sign("req-gina", "user:gina", payload, &proof("w-gina"))
        .await
        .unwrap();
    verify_against_address(&generated.group_public_key, payload, &signature);
}

#[tokio::test]
async fn participants_refuse_rounds_from_an_unauthenticated_coordinator() {
    let stranger = SigningKey::from_bytes(&[77u8; 32]);
    let cluster = spawn_cluster_trusting(&B64.encode(stranger.verifying_key().to_bytes())).await;
    assert!(cluster
        .coordinator
        .run_dkg("user:hal", "k-hal")
        .await
        .is_err());
    for node in &cluster.participants {
        assert!(node.store.load_share("user:hal").unwrap().is_none());
    }
}
