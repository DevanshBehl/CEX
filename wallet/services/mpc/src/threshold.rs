//! The coordinator, and the participant's HTTP surface (ADR-0015).
//!
//! # Where the boundary sits
//!
//! The TypeScript API talks to ONE endpoint, `POST /v1/sign`, and does not
//! know whether a single key or five participants produced the signature. That
//! is the whole architectural claim of Phase 4: the `Signer` interface does not
//! change when the implementation does. The fan-out lives here, below the
//! boundary, where it belongs.
//!
//! # What the coordinator can and cannot do
//!
//! It never holds a share. Aggregation is not privileged — an incorrect
//! aggregation yields an invalid signature, which is verified and rejected
//! before it is returned. So a compromised coordinator can:
//!
//!   - **censor**, by refusing to run rounds. A liveness failure: funds stay
//!     locked and recoverable.
//!   - **choose what to propose**, which is precisely why each participant
//!     verifies the authorization itself rather than trusting the package.
//!
//! It cannot forge, and it cannot make a participant sign something the
//! approval authority did not authorise.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use frost::round1::SigningCommitments;
use frost::round2::SignatureShare;
use frost::{Identifier, Signature};
use frost_ed25519 as frost;
use serde::{Deserialize, Serialize};

use crate::auth::{hash_payload, CallerSigner, SignedRequest};
use crate::error::{MpcError, Result};
use crate::frost::{aggregate, signing_package, MAX_SIGNERS, MIN_SIGNERS};
use crate::signer::AuthorizationProof;

/// One participant, as the coordinator sees it: a URL and an identity.
#[derive(Clone, Debug)]
pub struct ParticipantEndpoint {
    pub url: String,
    /// Hex-encoded FROST identifier, so a misconfigured roster is a boot-time
    /// error rather than a confusing aggregation failure.
    pub identifier: String,
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct CommitRequest {
    #[serde(rename = "nonceId")]
    pub nonce_id: String,
    #[serde(rename = "keyRef")]
    pub key_ref: String,
}

#[derive(Serialize, Deserialize)]
pub struct CommitResponse {
    pub identifier: String,
    /// Hex-encoded, serialized `SigningCommitments`.
    pub commitments: String,
}

#[derive(Serialize, Deserialize)]
pub struct ShareRequest {
    #[serde(rename = "nonceId")]
    pub nonce_id: String,
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// Hex-encoded payload the group is signing.
    pub payload: String,
    /// Every participant's commitments, so each one rebuilds the package
    /// itself rather than trusting a serialized one from the coordinator.
    pub commitments: BTreeMap<String, String>,
    pub authorization: AuthorizationProof,
}

#[derive(Serialize, Deserialize)]
pub struct ShareResponse {
    pub identifier: String,
    /// Hex-encoded `SignatureShare`.
    pub share: String,
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

pub fn encode_commitments(value: &SigningCommitments) -> Result<String> {
    let bytes =
        postcard::to_allocvec(value).map_err(|_| MpcError::Internal("commitment_encode_failed"))?;
    Ok(hex::encode(bytes))
}

pub fn decode_commitments(encoded: &str) -> Result<SigningCommitments> {
    let bytes = hex::decode(encoded).map_err(|_| MpcError::BadRequest("commitments_not_hex"))?;
    postcard::from_bytes(&bytes).map_err(|_| MpcError::BadRequest("commitments_invalid"))
}

pub fn encode_share(value: &SignatureShare) -> Result<String> {
    let bytes =
        postcard::to_allocvec(value).map_err(|_| MpcError::Internal("share_encode_failed"))?;
    Ok(hex::encode(bytes))
}

pub fn decode_share(encoded: &str) -> Result<SignatureShare> {
    let bytes = hex::decode(encoded).map_err(|_| MpcError::BadRequest("share_not_hex"))?;
    postcard::from_bytes(&bytes).map_err(|_| MpcError::BadRequest("share_invalid"))
}

pub fn encode_identifier(id: &Identifier) -> String {
    hex::encode(id.serialize())
}

pub fn decode_identifier(encoded: &str) -> Result<Identifier> {
    let bytes = hex::decode(encoded).map_err(|_| MpcError::BadRequest("identifier_not_hex"))?;
    Identifier::deserialize(&bytes).map_err(|_| MpcError::BadRequest("identifier_invalid"))
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

pub struct Coordinator {
    participants: Vec<ParticipantEndpoint>,
    client: reqwest::Client,
    /// The default group — the house treasury.
    ///
    /// `None` on a coordinator that has not been given one yet. It used to be
    /// required at construction, which meant a coordinator could not START
    /// until someone had put a house key in its store — and the only way to do
    /// that was to hand it a SHARE, contradicting the one property a
    /// coordinator is supposed to have. It provisions the house key like any
    /// other now (ADR-0020), and holds only the public package afterwards.
    public_package: Option<frost::keys::PublicKeyPackage>,
    /// Proves to participants that this is the coordinator calling.
    ///
    /// Participants authenticate every request; without this the coordinator's
    /// calls arrive unsigned and are rejected. See `CallerSigner`.
    signer: CallerSigner,
    /// Public material for per-user groups (ADR-0020). No key material.
    store: Arc<crate::store::Store>,
    /*
     * ONE PROVISIONING AT A TIME PER key_ref.
     *
     * THE BUG THIS FIXES, found on a live devnet run:
     *
     * A page issued two concurrent requests for the same user's address. Both
     * found no stored group key — it is written only after all five installs
     * succeed — so both generated a complete share set and began distributing
     * them. The second was refused by the first participant it reached
     * (`share_already_installed`), which is that refusal working as intended.
     *
     * But the outcome was a 500 for the user and, had the two raced in a
     * different order, a SPLIT KEY SET: some participants holding shares from
     * one ceremony and some from the other, for one key_ref, aggregating to
     * nothing. An address that receives deposits and can never spend them.
     *
     * The lock is per key_ref rather than global so one user's ceremony does
     * not serialise every other signup.
     */
    provisioning: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Coordinator {
    pub fn new(
        participants: Vec<ParticipantEndpoint>,
        // `None` until a house key is provisioned. See the field.
        public_package: Option<frost::keys::PublicKeyPackage>,
        signer: CallerSigner,
        store: Arc<crate::store::Store>,
        timeout: Duration,
    ) -> Result<Self> {
        if participants.len() < MIN_SIGNERS as usize {
            return Err(MpcError::Internal("roster_below_threshold"));
        }

        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|_| MpcError::Internal("http_client_failed"))?;

        Ok(Self {
            participants,
            client,
            public_package,
            signer,
            store,
            provisioning: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    /// The public package for a key: a per-user group, or the house default.
    fn package_for(&self, key_ref: &str) -> Result<frost::keys::PublicKeyPackage> {
        match self.store.load_group_key(key_ref)? {
            Some(bytes) => postcard::from_bytes(&bytes)
                .map_err(|_| MpcError::Internal("public_package_corrupt")),
            None => self
                .public_package
                .clone()
                // A key_ref with no per-user group and no house group is not a
                // key this coordinator can aggregate for. Refused by name
                // rather than by an opaque aggregation failure.
                .ok_or(MpcError::BadRequest("unknown_key_ref")),
        }
    }

    fn stored_group_key(&self, key_ref: &str) -> Result<Option<String>> {
        let Some(bytes) = self.store.load_group_key(key_ref)? else {
            return Ok(None);
        };
        let package: frost::keys::PublicKeyPackage = postcard::from_bytes(&bytes)
            .map_err(|_| MpcError::Internal("public_package_corrupt"))?;
        Ok(Some(bs58_encode(
            &package
                .verifying_key()
                .serialize()
                .map_err(|_| MpcError::Internal("group_key_unserializable"))?,
        )))
    }

    fn remember_group_key(&self, key_ref: &str, encoded_package: &str) -> Result<()> {
        let bytes =
            hex::decode(encoded_package).map_err(|_| MpcError::Internal("package_not_hex"))?;
        self.store.store_group_key(key_ref, &bytes)
    }

    /// The group verifying key — the treasury's public key.
    pub fn group_public_key(&self) -> Result<Vec<u8>> {
        self.public_package
            .as_ref()
            .ok_or(MpcError::Internal("coordinator_has_no_house_key"))?
            .verifying_key()
            .serialize()
            .map_err(|_| MpcError::Internal("group_key_unserializable"))
    }

    /// Adopt a house group after provisioning it (see `provision_user_key`).
    ///
    /// Takes `&mut self` so it can only happen at startup, before the
    /// coordinator is shared: a house key that could change while rounds were
    /// running would let two withdrawals be aggregated against two different
    /// keys with nothing recording which.
    pub fn adopt_house_key(&mut self, package: frost::keys::PublicKeyPackage) {
        self.public_package = Some(package);
    }

    /// The house group's public package, from the store, if one was provisioned.
    pub fn stored_house_package(
        &self,
        key_ref: &str,
    ) -> Result<Option<frost::keys::PublicKeyPackage>> {
        let Some(bytes) = self.store.load_group_key(key_ref)? else {
            return Ok(None);
        };
        postcard::from_bytes(&bytes)
            .map(Some)
            .map_err(|_| MpcError::Internal("public_package_corrupt"))
    }

    /// How many participants answered a health probe.
    ///
    /// Monitoring alerts when this reaches `MIN_SIGNERS` (DoD 209): at that
    /// point the next failure is an outage, and the decision to act has to be
    /// made before it, not after.
    pub async fn available(&self) -> usize {
        let mut reachable = 0;
        for participant in &self.participants {
            let url = format!("{}/v1/health", participant.url);
            if let Ok(response) = self.client.get(&url).send().await {
                if response.status().is_success() {
                    reachable += 1;
                }
            }
        }
        reachable
    }

    /// Run both rounds and return an ordinary Ed25519 signature.
    ///
    /// `request_id` seeds every nonce id, so a retry of the same request
    /// addresses the same nonces — and a participant that already used one
    /// refuses rather than signing twice. That is the property the whole
    /// `requestId` discipline has existed for since Phase 2.
    pub async fn sign(
        &self,
        request_id: &str,
        key_ref: &str,
        payload: &[u8],
        authorization: &AuthorizationProof,
    ) -> Result<Signature> {
        // --- Round 1: collect commitments ----------------------------------
        //
        // Every reachable participant is asked, not just the first three. A
        // participant that is slow or down should cost latency, not the round
        // — and with 5 asked and 3 needed, two can fail silently.
        let mut commitments: BTreeMap<Identifier, SigningCommitments> = BTreeMap::new();
        let mut wire: BTreeMap<String, String> = BTreeMap::new();
        let mut failures = Vec::new();

        for participant in &self.participants {
            let nonce_id = format!("{request_id}:{}", participant.identifier);
            match self.commit(participant, &nonce_id, key_ref).await {
                Ok(response) => {
                    let identifier = decode_identifier(&response.identifier)?;
                    commitments.insert(identifier, decode_commitments(&response.commitments)?);
                    wire.insert(response.identifier, response.commitments);
                }
                Err(error) => failures.push((participant.identifier.clone(), error)),
            }

            if commitments.len() == MIN_SIGNERS as usize {
                break;
            }
        }

        if commitments.len() < MIN_SIGNERS as usize {
            tracing::error!(
                available = commitments.len(),
                required = MIN_SIGNERS,
                failed = failures.len(),
                "threshold not met: not enough participants committed"
            );
            return Err(MpcError::Internal("threshold_not_met"));
        }

        // --- Round 2: collect signature shares -----------------------------
        let package = signing_package(commitments.clone(), payload);
        let mut shares: BTreeMap<Identifier, SignatureShare> = BTreeMap::new();

        for participant in &self.participants {
            let identifier = decode_identifier(&participant.identifier)?;
            if !commitments.contains_key(&identifier) {
                continue;
            }

            let nonce_id = format!("{request_id}:{}", participant.identifier);
            let response = self
                .share(
                    participant,
                    &nonce_id,
                    key_ref,
                    payload,
                    &wire,
                    authorization,
                )
                .await?;
            shares.insert(
                decode_identifier(&response.identifier)?,
                decode_share(&response.share)?,
            );
        }

        // The USER's group package when this is a per-user key (ADR-0020).
        // Aggregating a user's shares against the house's package produces an
        // invalid signature, and the verification inside `aggregate` is what
        // would catch it — as an opaque failure rather than a wrong key_ref.
        aggregate(&package, &shares, &self.package_for(key_ref)?)
    }

    /// POST to a participant, authenticated as the coordinator.
    ///
    /// The body is serialised ONCE and both signed and sent as those exact
    /// bytes. Signing a re-serialisation would work right up until serde
    /// ordered a field differently, and then it would fail as
    /// `signature_rejected` with nothing pointing at the cause.
    async fn post<B: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        participant: &ParticipantEndpoint,
        path: &'static str,
        request_id: &str,
        body: &B,
        refusal: &'static str,
    ) -> Result<R> {
        let body =
            serde_json::to_string(body).map_err(|_| MpcError::Internal("body_unencodable"))?;
        let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
        let signature = self.signer.sign(&SignedRequest {
            method: "POST",
            path,
            request_id,
            payload_hash: &hash_payload(body.as_bytes()),
            timestamp,
        });

        let response = self
            .client
            .post(format!("{}{path}", participant.url))
            .header("content-type", "application/json")
            .header("x-mpc-signature", signature)
            .header("x-mpc-timestamp", timestamp.to_string())
            .header("x-mpc-caller", "coordinator")
            .body(body)
            .send()
            .await
            .map_err(|_| MpcError::Internal("participant_unreachable"))?;

        if !response.status().is_success() {
            tracing::error!(
                participant = %participant.identifier,
                status = %response.status(),
                path,
                "participant refused a coordinator request"
            );
            return Err(MpcError::Internal(refusal));
        }

        response
            .json()
            .await
            .map_err(|_| MpcError::Internal("participant_response_invalid"))
    }

    async fn commit(
        &self,
        participant: &ParticipantEndpoint,
        nonce_id: &str,
        key_ref: &str,
    ) -> Result<CommitResponse> {
        self.post(
            participant,
            "/v1/frost/commit",
            nonce_id,
            &CommitRequest {
                nonce_id: nonce_id.to_owned(),
                key_ref: key_ref.to_owned(),
            },
            "participant_refused_commit",
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn share(
        &self,
        participant: &ParticipantEndpoint,
        nonce_id: &str,
        key_ref: &str,
        payload: &[u8],
        commitments: &BTreeMap<String, String>,
        authorization: &AuthorizationProof,
    ) -> Result<ShareResponse> {
        // A participant refusing round 2 after committing in round 1 is the
        // interesting failure: it means it verified the authorization and did
        // not like it. `post` logs every refusal at error level, because a
        // compromised coordinator proposing bad transactions looks exactly
        // like this.
        self.post(
            participant,
            "/v1/frost/share",
            nonce_id,
            &ShareRequest {
                nonce_id: nonce_id.to_owned(),
                key_ref: key_ref.to_owned(),
                payload: hex::encode(payload),
                commitments: commitments.clone(),
                authorization: authorization.clone(),
            },
            "participant_refused_share",
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// Per-user key provisioning (ADR-0020)
// ---------------------------------------------------------------------------

/// Install one participant's share. Sent by the coordinator during provisioning.
#[derive(Serialize, Deserialize)]
pub struct InstallShareRequest {
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// Hex-encoded, serialized `SecretShare`.
    pub share: String,
    /// Hex-encoded, serialized `PublicKeyPackage`.
    #[serde(rename = "publicPackage")]
    pub public_package: String,
}

#[derive(Serialize, Deserialize)]
pub struct InstallShareResponse {
    pub identifier: String,
    #[serde(rename = "groupPublicKey")]
    pub group_public_key: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProvisionRequest {
    /// Opaque. The API uses `user:{userId}`; the service never parses it.
    #[serde(rename = "keyRef")]
    pub key_ref: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProvisionResponse {
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// base58 — this IS the user's segregated Solana address.
    #[serde(rename = "groupPublicKey")]
    pub group_public_key: String,
    pub participants: u16,
    pub threshold: u16,
    /// True when this key already existed and nothing was generated.
    pub existing: bool,
}

pub fn encode_secret_share(value: &frost::keys::SecretShare) -> Result<String> {
    let bytes = postcard::to_allocvec(value)
        .map_err(|_| MpcError::Internal("secret_share_encode_failed"))?;
    Ok(hex::encode(bytes))
}

pub fn decode_secret_share(encoded: &str) -> Result<frost::keys::SecretShare> {
    let bytes = hex::decode(encoded).map_err(|_| MpcError::BadRequest("share_not_hex"))?;
    postcard::from_bytes(&bytes).map_err(|_| MpcError::BadRequest("share_invalid"))
}

pub fn encode_public_package(value: &frost::keys::PublicKeyPackage) -> Result<String> {
    let bytes = postcard::to_allocvec(value)
        .map_err(|_| MpcError::Internal("public_package_encode_failed"))?;
    Ok(hex::encode(bytes))
}

pub fn decode_public_package(encoded: &str) -> Result<frost::keys::PublicKeyPackage> {
    let bytes = hex::decode(encoded).map_err(|_| MpcError::BadRequest("package_not_hex"))?;
    postcard::from_bytes(&bytes).map_err(|_| MpcError::BadRequest("package_invalid"))
}

impl Coordinator {
    /// Provision a fresh 3-of-5 key for one user (ADR-0020).
    ///
    /// # This uses a TRUSTED DEALER, and that is a real weakness
    ///
    /// The coordinator generates all five shares and distributes them, so for
    /// the duration of this call **one process holds the whole key**. That
    /// violates the property the rest of the threshold design exists to
    /// provide, and master-prompt rule 99 forbids reconstructing a complete
    /// key for convenience.
    ///
    /// It is accepted deliberately and temporarily: it makes the data model,
    /// the storage, the signing pipeline and the address derivation identical
    /// to what interactive DKG will need, so the ceremony can replace *how
    /// shares come to exist* without touching anything else. The service logs
    /// a warning on every provisioning so this cannot be forgotten.
    ///
    /// Once DKG lands, each participant generates its own secret and no machine
    /// ever holds the group key — this function is then deleted, not disabled.
    pub async fn provision_user_key(&self, key_ref: &str) -> Result<ProvisionResponse> {
        if key_ref.trim().is_empty() || key_ref.len() > 256 {
            return Err(MpcError::BadRequest("key_ref_invalid"));
        }

        /*
         * Serialised per key_ref, and the idempotency check is INSIDE the lock.
         *
         * Outside it, two concurrent requests both read "no key", both generate
         * a share set, and both distribute — see the `provisioning` field. The
         * second one through finds the first one's key and returns it.
         */
        let gate = {
            let mut locks = self.provisioning.lock().await;
            Arc::clone(
                locks
                    .entry(key_ref.to_owned())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _provisioning = gate.lock().await;

        // Idempotent: a retried signup must not mint a second key for a user
        // whose address is already published and possibly already funded.
        if let Some(existing) = self.stored_group_key(key_ref)? {
            return Ok(ProvisionResponse {
                key_ref: key_ref.to_owned(),
                group_public_key: existing,
                participants: MAX_SIGNERS,
                threshold: MIN_SIGNERS,
                existing: true,
            });
        }

        tracing::warn!(
            key_ref,
            "provisioning a per-user key with a TRUSTED DEALER: this process briefly holds the \
             whole key. Interim only — see ADR-0020."
        );

        let (shares, public_package) =
            crate::frost::generate_with_dealer(MIN_SIGNERS, MAX_SIGNERS)?;

        if shares.len() != self.participants.len() {
            return Err(MpcError::Internal("roster_size_mismatch"));
        }

        let encoded_package = encode_public_package(&public_package)?;

        // Distributed before anything is stored locally. A share that cannot be
        // delivered means the key does not exist anywhere as far as the rest of
        // the system is concerned, which is the safe direction to fail: a user
        // with no address, rather than an address nobody can sign for.
        //
        // Matched by IDENTIFIER, never by position. Round 2 selects signers by
        // `participant.identifier` from the roster, so a share handed to the
        // wrong host would produce shares that aggregate to nothing — an
        // address that receives deposits and can never spend them. Zipping the
        // two lists would have made that depend on the roster's order in an
        // environment variable.
        for participant in &self.participants {
            let wanted = decode_identifier(&participant.identifier)?;
            let Some(share) = shares.iter().find(|share| share.identifier == wanted) else {
                return Err(MpcError::Internal("roster_identifier_not_in_share_set"));
            };
            self.install_share(participant, key_ref, share, &encoded_package)
                .await?;
        }

        let group_public_key = bs58_encode(
            &public_package
                .verifying_key()
                .serialize()
                .map_err(|_| MpcError::Internal("group_key_unserializable"))?,
        );

        self.remember_group_key(key_ref, &encoded_package)?;

        tracing::info!(key_ref, address = %group_public_key, "per-user key provisioned");

        Ok(ProvisionResponse {
            key_ref: key_ref.to_owned(),
            group_public_key,
            participants: MAX_SIGNERS,
            threshold: MIN_SIGNERS,
            existing: false,
        })
    }

    async fn install_share(
        &self,
        participant: &ParticipantEndpoint,
        key_ref: &str,
        share: &crate::frost::GeneratedShare,
        public_package: &str,
    ) -> Result<()> {
        let installed: InstallShareResponse = self
            .post(
                participant,
                "/v1/frost/install",
                key_ref,
                &InstallShareRequest {
                    key_ref: key_ref.to_owned(),
                    share: encode_secret_share(&share.secret_share)?,
                    public_package: public_package.to_owned(),
                },
                "participant_refused_install",
            )
            .await?;

        // The participant reports which identifier it now holds for this key.
        // If that is not the roster entry the coordinator addressed, the roster
        // does not describe reality and every later round for this key would
        // address the wrong host.
        if installed.identifier != participant.identifier {
            tracing::error!(
                expected = %participant.identifier,
                installed = %installed.identifier,
                "participant installed a share under a different identifier"
            );
            return Err(MpcError::Internal("participant_identifier_mismatch"));
        }
        Ok(())
    }
}

/// base58, for Solana addresses. Hand-rolled to avoid a dependency for one use.
fn bs58_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 2);

    for &byte in bytes {
        let mut carry = byte as usize;
        for digit in digits.iter_mut() {
            carry += (*digit as usize) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }

    // Each leading zero byte is one leading '1'.
    let leading = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = String::with_capacity(leading + digits.len());
    // `repeat_n` is stable only from 1.82 and this crate's MSRV is 1.80.
    out.extend(std::iter::repeat('1').take(leading));
    out.extend(digits.iter().rev().map(|d| ALPHABET[*d as usize] as char));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The base58 encoder, against known vectors.
    ///
    /// Hand-rolled to avoid a dependency for one call site, which means it is
    /// exactly the kind of code that is wrong in a way nothing notices: a
    /// mis-encoded group key becomes an address the funds are not at, and every
    /// internal test still agrees with itself.
    #[test]
    fn base58_matches_known_vectors() {
        // The all-zero 32-byte key is Solana's system program address, which is
        // 32 '1' characters — and it is the case a naive implementation gets
        // wrong, because leading zeros carry no value.
        assert_eq!(bs58_encode(&[0u8; 32]), "1".repeat(32));

        // From the Bitcoin base58 test vectors.
        assert_eq!(bs58_encode(&[0x61]), "2g");
        assert_eq!(bs58_encode(b"hello world"), "StV1DL6CwTryKyV");
        assert_eq!(bs58_encode(&[]), "");

        // A leading zero byte is one '1', and the rest encodes normally.
        assert_eq!(bs58_encode(&[0x00, 0x61]), "12g");
    }

    #[test]
    fn base58_round_trips_a_real_key_length() {
        // 32 bytes encodes to 32-44 characters — the Solana address range.
        let encoded = bs58_encode(&[0xff; 32]);
        assert!(
            encoded.len() >= 32 && encoded.len() <= 44,
            "got {}",
            encoded.len()
        );
    }
}
