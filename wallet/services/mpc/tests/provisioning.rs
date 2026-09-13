//! Per-user key provisioning over real sockets (ADR-0020).
//!
//! # Why this test binds real ports
//!
//! The coordinator reaches participants with an HTTP client. Every other test
//! in this crate drives the router in-process with `oneshot`, which cannot
//! exercise the coordinator at all — its requests would go nowhere.
//!
//! So five participants are bound to ephemeral ports and the coordinator is
//! pointed at them. That is the only way to test the thing that actually
//! ships: provisioning a user's key means five network calls that can each
//! fail, and a share that is generated but never delivered is a user with an
//! address nobody can sign for.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::net::TcpListener;

use wallet_mpc::auth::{CallerSigner, CallerVerifier};
use wallet_mpc::frost::{MAX_SIGNERS, MIN_SIGNERS};
use wallet_mpc::http::{router, AppState};
use wallet_mpc::keystore::Kek;
use wallet_mpc::signer::SigningService;
use wallet_mpc::store::Store;
use wallet_mpc::threshold::{Coordinator, ParticipantEndpoint};

/// The coordinator's caller key. Participants trust exactly this one — in a
/// deployment it is `MPC_COORDINATOR_KEY`, and its public half is every
/// participant's `MPC_CALLER_PUBLIC_KEY`.
const COORDINATOR_SEED: [u8; 32] = [3u8; 32];

fn coordinator_public_key() -> String {
    B64.encode(
        SigningKey::from_bytes(&COORDINATOR_SEED)
            .verifying_key()
            .to_bytes(),
    )
}

/// Bind one participant service and return its URL.
///
/// `trusted_caller` is the participant's `MPC_CALLER_PUBLIC_KEY`: the one key
/// whose signature it will accept on a request.
async fn spawn_participant(index: u8, trusted_caller: &str) -> String {
    let store = Arc::new(Store::in_memory().expect("store"));
    let kek = Kek::from_base64(&B64.encode([60u8 + index; 32])).expect("kek");
    let signer_kek = Kek::from_base64(&B64.encode([60u8 + index; 32])).expect("kek");

    let caller = CallerVerifier::new(trusted_caller, 60).expect("verifier");

    let app = router(Arc::new(AppState {
        signer: SigningService::new(Arc::clone(&store), signer_kek),
        store,
        caller,
        participant_kek: Some(kek),
        coordinator: None,
    }));

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    format!("http://{address}")
}

/// A coordinator pointed at freshly bound participants.
async fn spawn_cluster() -> (Coordinator, Arc<Store>) {
    spawn_cluster_trusting(&coordinator_public_key()).await
}

/// The same, with the participants configured to trust some other caller.
async fn spawn_cluster_trusting(trusted_caller: &str) -> (Coordinator, Arc<Store>) {
    let mut endpoints = Vec::new();
    for index in 0..MAX_SIGNERS {
        // The canonical FROST identifiers 1..=5, which is what the dealer's
        // default identifier list produces. The coordinator matches shares to
        // roster entries by identifier, so these must be the real thing.
        let identifier = frost_ed25519::Identifier::try_from(index + 1).expect("identifier");
        endpoints.push(ParticipantEndpoint {
            url: spawn_participant(index as u8, trusted_caller).await,
            identifier: wallet_mpc::threshold::encode_identifier(&identifier),
        });
    }

    /*
     * NO house group.
     *
     * A coordinator starts without one now and provisions it like any other
     * key — which is also what makes these tests meaningful: nothing here can
     * accidentally aggregate against a pre-existing house package.
     */
    let store = Arc::new(Store::in_memory().expect("store"));
    let coordinator = Coordinator::new(
        endpoints,
        None,
        CallerSigner::from_base64(&B64.encode(COORDINATOR_SEED)).expect("signer"),
        Arc::clone(&store),
        std::time::Duration::from_secs(10),
    )
    .expect("coordinator");

    (coordinator, store)
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

#[tokio::test]
async fn provisioning_gives_each_user_a_different_address() {
    let (coordinator, _store) = spawn_cluster().await;

    let alice = coordinator
        .provision_user_key("user:alice")
        .await
        .expect("alice");
    let bob = coordinator
        .provision_user_key("user:bob")
        .await
        .expect("bob");

    // THE POINT of segregated custody: no shared key, no shared address.
    assert_ne!(alice.group_public_key, bob.group_public_key);
    assert_eq!(alice.threshold, MIN_SIGNERS);
    assert_eq!(alice.participants, MAX_SIGNERS);
    assert!(!alice.existing);

    // The address is a plausible Solana address.
    assert!(
        alice.group_public_key.len() >= 32 && alice.group_public_key.len() <= 44,
        "address length {}",
        alice.group_public_key.len()
    );
}

#[tokio::test]
async fn provisioning_is_idempotent() {
    // A retried signup must NOT mint a second key. The user's address may
    // already be published and already funded, and replacing it would strand
    // whatever is there.
    let (coordinator, _store) = spawn_cluster().await;

    let first = coordinator
        .provision_user_key("user:carol")
        .await
        .expect("first");
    let second = coordinator
        .provision_user_key("user:carol")
        .await
        .expect("second");

    assert_eq!(first.group_public_key, second.group_public_key);
    assert!(!first.existing);
    assert!(second.existing);
}

#[tokio::test]
async fn a_provisioned_user_key_actually_signs() {
    // Provisioning that produces an address nobody can sign for is worse than
    // failing: the address gets published, funded, and then discovered to be
    // unspendable.
    let (coordinator, _store) = spawn_cluster().await;
    let provisioned = coordinator
        .provision_user_key("user:dave")
        .await
        .expect("dave");

    let payload = b"a withdrawal from dave's segregated address";
    let approval = SigningKey::from_bytes(&[9u8; 32]);
    let reference = "w-dave-1";

    let message = format!(
        "risk-engine\n2026-09-12T00:00:00Z\n1\n{reference}\n{}",
        hex::encode(sha256(payload))
    );

    let authorization = wallet_mpc::signer::AuthorizationProof {
        approved_by: "risk-engine".into(),
        approved_at: "2026-09-12T00:00:00Z".into(),
        policy_version: "1".into(),
        reference: reference.into(),
        tier: None,
        signature: Some(B64.encode(approval.sign(message.as_bytes()).to_bytes())),
    };

    let signature = coordinator
        .sign("req-dave-1", "user:dave", payload, &authorization)
        .await
        .expect("signature");

    // Verified against the ADDRESS the user was given — decoded from base58,
    // independently of anything inside the service. That is the property that
    // matters: whatever is sent to that address can be moved by this signature
    // scheme. Aggregating against the wrong group package yields an invalid
    // signature, and this is what catches it.
    let bytes = signature.serialize().expect("serialize");
    let signature: [u8; 64] = bytes.as_slice().try_into().expect("64 bytes");
    let address: [u8; 32] = bs58_decode(&provisioned.group_public_key)
        .as_slice()
        .try_into()
        .expect("32 bytes");

    ed25519_dalek::VerifyingKey::from_bytes(&address)
        .expect("address is a valid ed25519 point")
        .verify_strict(payload, &ed25519_dalek::Signature::from_bytes(&signature))
        .expect("the address that received the deposit can spend it");
}

/// base58 decode, for checking the address the service hands out.
///
/// Deliberately an independent implementation rather than a call into the
/// service's encoder: a test that round-trips through the same code proves
/// only that it is self-consistent.
fn bs58_decode(encoded: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut bytes: Vec<u8> = vec![0];
    for character in encoded.bytes() {
        let value = ALPHABET
            .iter()
            .position(|c| *c == character)
            .expect("base58 character") as u32;
        let mut carry = value;
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

#[tokio::test]
async fn a_participant_that_does_not_trust_the_coordinator_refuses_a_share() {
    // The regression this file exists for. The coordinator used to send its
    // participant requests UNSIGNED, which no participant would have accepted
    // in a real deployment — and the in-process tests did not notice, because
    // they played the coordinator themselves in test code that did sign.
    //
    // Here the participants trust a different key, so the only thing that can
    // make provisioning fail is the authentication.
    let stranger = SigningKey::from_bytes(&[77u8; 32]);
    let (coordinator, _store) =
        spawn_cluster_trusting(&B64.encode(stranger.verifying_key().to_bytes())).await;

    // Matched rather than `expect_err`: the response type deliberately does
    // not derive Debug, so no wire type can be printed into a log by habit.
    let Err(error) = coordinator.provision_user_key("user:grace").await else {
        panic!("a participant installed a share for an unauthenticated caller");
    };

    assert!(
        format!("{error:?}").contains("refused"),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn one_user_key_cannot_sign_for_another() {
    // The isolation property. Compromising three participants for Alice must
    // not yield anything usable for Bob.
    let (coordinator, _store) = spawn_cluster().await;
    coordinator
        .provision_user_key("user:erin")
        .await
        .expect("erin");

    // `user:frank` was never provisioned: no participant holds a share for it,
    // and the round must fail rather than fall back to any other key.
    let authorization = wallet_mpc::signer::AuthorizationProof {
        approved_by: "risk-engine".into(),
        approved_at: "2026-09-12T00:00:00Z".into(),
        policy_version: "1".into(),
        reference: "w-frank-1".into(),
        tier: None,
        signature: None,
    };

    assert!(coordinator
        .sign("req-frank-1", "user:frank", b"payload", &authorization)
        .await
        .is_err());
}

#[tokio::test]
async fn concurrent_provisioning_of_one_key_yields_one_key() {
    /*
     * REGRESSION, found on a live devnet run.
     *
     * A page issued two concurrent requests for the same user's address. Both
     * saw no stored group key — it is written only after all five installs —
     * so both generated a share set and both began distributing. One was
     * refused by the first participant it reached, and the user got a 500.
     *
     * Had they raced in a different order the result would have been worse: a
     * SPLIT KEY SET, some participants holding shares from one ceremony and
     * some from the other, aggregating to nothing. An address that receives
     * deposits and can never spend them.
     */
    let (coordinator, _store) = spawn_cluster().await;
    let coordinator = std::sync::Arc::new(coordinator);

    let attempts: Vec<_> = (0..4)
        .map(|_| {
            let coordinator = std::sync::Arc::clone(&coordinator);
            tokio::spawn(async move { coordinator.provision_user_key("user:race").await })
        })
        .collect();

    let mut addresses = Vec::new();
    for attempt in attempts {
        let result = attempt.await.expect("join").expect("provision");
        addresses.push(result.group_public_key);
    }

    // One address, four times. Not four addresses, and not three plus an error.
    assert_eq!(
        addresses
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        1
    );

    // And it is a key that can actually sign: proof the share set is whole.
    let authorization = wallet_mpc::signer::AuthorizationProof {
        approved_by: "risk-engine".into(),
        approved_at: "2026-09-12T00:00:00Z".into(),
        policy_version: "1".into(),
        reference: "w-race-1".into(),
        tier: None,
        signature: None,
    };

    coordinator
        .sign("req-race-1", "user:race", b"payload", &authorization)
        .await
        .expect("the winning ceremony installed a complete share set");
}
