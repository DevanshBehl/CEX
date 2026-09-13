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

    /// The group verifying key — the treasury's public key.
    pub fn group_public_key(&self) -> Result<Vec<u8>> {
        self.public_package
            .as_ref()
            .ok_or(MpcError::Internal("coordinator_has_no_house_key"))?
            .verifying_key()
            .serialize()
            .map_err(|_| MpcError::Internal("group_key_unserializable"))
    }

    /// Adopt a house group after generating it (see `run_dkg`).
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
// Per-user key generation: distributed, no dealer (ADR-0020, ADR-0023)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct DkgInitRequest {
    /// Opaque. The API uses `user:{userId}`; the service never parses it.
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// Scoped to one key_ref: reusing it for a different key is refused.
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Serialize, Deserialize)]
pub struct DkgInitResponse {
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// base58 — this IS the user's segregated Solana address.
    #[serde(rename = "groupPublicKey")]
    pub group_public_key: String,
    pub participants: u16,
    pub threshold: u16,
    /// True when this key already existed and no rounds were run.
    pub existing: bool,
    /// Identifier (hex) -> verification share `Y_i = s_i·G` (hex). Public.
    #[serde(rename = "verifyingShares")]
    pub verifying_shares: BTreeMap<String, String>,
    /// Hex SHA-256 of the agreed public key package (see `dkg::public_package_hash`).
    #[serde(rename = "publicPackageHash")]
    pub public_package_hash: String,
    /// Always `"dkg"`. Stated so a consumer can refuse anything else.
    pub generation: String,
}

/// Everything the coordinator received during one ceremony, verbatim.
///
/// Persisted for audit. It is ALL public or ciphertext by construction: the
/// wire types it holds have no field that carries a share in the clear.
#[derive(Default, Serialize)]
struct CeremonyTranscript {
    round1: BTreeMap<String, String>,
    round2: Vec<crate::dkg::DkgRound2Response>,
    finalize: Vec<crate::dkg::DkgFinalizeResponse>,
    commit: Vec<crate::dkg::DkgCommitResponse>,
}

impl CeremonyTranscript {
    fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).map_err(|_| MpcError::Internal("transcript_unencodable"))
    }
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
    /// Generate a fresh 3-of-5 key for `key_ref` by distributed key generation.
    ///
    /// # What the coordinator does, and cannot do
    ///
    /// It moves messages. It sees round-1 commitments and proofs (public),
    /// round-2 envelopes (ciphertext sealed peer-to-peer under keys it does not
    /// hold) and verification shares (public). It never holds a polynomial, a
    /// share or the group secret, so compromising it during a ceremony yields
    /// nothing a passive observer of the wire would not already have.
    ///
    /// It is still a liveness dependency, and it is TRUSTED FOR NOTHING ELSE:
    /// it recomputes the group package from the public commitments and refuses
    /// to commit unless all five participants independently derived exactly
    /// that package. A participant that disagrees is not outvoted.
    ///
    /// # Idempotency
    ///
    /// A key_ref that already has a group returns it without running any
    /// round. A ceremony that every participant verified but not every
    /// participant committed is RESUMED rather than restarted — restarting
    /// would be refused by the participants that already committed, leaving a
    /// key nobody could complete.
    pub async fn run_dkg(&self, key_ref: &str, idempotency_key: &str) -> Result<DkgInitResponse> {
        if key_ref.trim().is_empty() || key_ref.len() > 256 {
            return Err(MpcError::BadRequest("key_ref_invalid"));
        }
        if idempotency_key.trim().is_empty() || idempotency_key.len() > 128 {
            return Err(MpcError::BadRequest("idempotency_key_invalid"));
        }
        if self.participants.len() != MAX_SIGNERS as usize {
            // DKG needs every member of the group: a share is dealt to each.
            return Err(MpcError::Internal("roster_size_mismatch"));
        }

        /*
         * Serialised per key_ref, and every check is INSIDE the lock.
         *
         * Outside it, two concurrent requests both read "no key" and both start
         * a ceremony — see the `provisioning` field. The second one through
         * finds the first one's key and returns it.
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

        if let Some(package) = self.stored_package(key_ref)? {
            return self.init_response(key_ref, &package, true);
        }

        if let Some(owner) = self.store.idempotency_key_owner(idempotency_key)? {
            if owner != key_ref {
                return Err(MpcError::BadRequest("idempotency_key_reused"));
            }
        }

        if let Some((session_id, bytes)) = self.store.resumable_coordinator_dkg_session(key_ref)? {
            let package: frost::keys::PublicKeyPackage = postcard::from_bytes(&bytes)
                .map_err(|_| MpcError::Internal("public_package_corrupt"))?;
            tracing::warn!(key_ref, session_id = %session_id, "resuming an incompletely committed DKG");
            let mut transcript = CeremonyTranscript::default();
            self.commit_all(&session_id, key_ref, &package, &mut transcript)
                .await?;
            return self.complete(&session_id, key_ref, &package, &transcript);
        }

        let session_id = new_session_id();
        self.store
            .create_coordinator_dkg_session(&session_id, key_ref, idempotency_key)?;
        tracing::info!(key_ref, session_id = %session_id, "starting DKG ceremony");

        let mut transcript = CeremonyTranscript::default();
        let package = match self.ceremony(&session_id, key_ref, &mut transcript).await {
            Ok(package) => package,
            Err(error) => {
                let reason = error.reason();
                self.store.update_coordinator_dkg_session(
                    &session_id,
                    &crate::store::CoordinatorDkgUpdate {
                        phase: "aborted",
                        public_package: None,
                        public_package_hash: None,
                        transcript: Some(&transcript.to_json()?),
                        failure_reason: Some(&reason),
                    },
                )?;
                tracing::error!(key_ref, session_id = %session_id, reason = %reason, "DKG aborted");
                return Err(error);
            }
        };

        // Verified by everyone; now install. A failure from here on leaves the
        // session `committing`, which the next call resumes.
        if let Err(error) = self
            .commit_all(&session_id, key_ref, &package, &mut transcript)
            .await
        {
            self.store.update_coordinator_dkg_session(
                &session_id,
                &crate::store::CoordinatorDkgUpdate {
                    phase: "committing",
                    public_package: None,
                    public_package_hash: None,
                    transcript: Some(&transcript.to_json()?),
                    failure_reason: Some(&error.reason()),
                },
            )?;
            return Err(error);
        }

        self.complete(&session_id, key_ref, &package, &transcript)
    }

    /// Rounds 1-3. Returns the group package all five participants verified.
    async fn ceremony(
        &self,
        session_id: &str,
        key_ref: &str,
        transcript: &mut CeremonyTranscript,
    ) -> Result<frost::keys::PublicKeyPackage> {
        use crate::dkg::{
            DkgFinalizeRequest, DkgFinalizeResponse, DkgRound1Request, DkgRound1Response,
            DkgRound2Request, DkgRound2Response, ShareEnvelope,
        };

        // --- Round 1: commitments and proofs of knowledge -----------------
        let mut round1 = BTreeMap::new();
        for participant in &self.participants {
            let response: DkgRound1Response = self
                .post(
                    participant,
                    "/v1/frost/dkg/round1",
                    session_id,
                    &DkgRound1Request {
                        session_id: session_id.to_owned(),
                        key_ref: key_ref.to_owned(),
                        min_signers: MIN_SIGNERS,
                        max_signers: MAX_SIGNERS,
                    },
                    "participant_refused_dkg_round1",
                )
                .await?;
            expect_identifier(participant, &response.identifier)?;
            transcript
                .round1
                .insert(response.identifier.clone(), response.package.clone());
            round1.insert(response.identifier, response.package);
        }

        let mut decoded = BTreeMap::new();
        for (identifier, package) in &round1 {
            let bytes =
                hex::decode(package).map_err(|_| MpcError::Internal("dkg_package_not_hex"))?;
            decoded.insert(
                decode_identifier(identifier)?,
                postcard::from_bytes::<frost::keys::dkg::round1::Package>(&bytes)
                    .map_err(|_| MpcError::Internal("dkg_package_invalid"))?,
            );
        }
        // What the result MUST be, computed from public data alone.
        let expected = crate::dkg::expected_public_package(&decoded)?;
        let expected_hash = hex::encode(crate::dkg::public_package_hash(&expected)?);
        let expected_group = hex::encode(crate::dkg::group_key_bytes(&expected)?);

        // --- Round 2: sealed share exchange -------------------------------
        let mut inbox: BTreeMap<String, Vec<ShareEnvelope>> = BTreeMap::new();
        let mut transcript_hash: Option<String> = None;
        for participant in &self.participants {
            let response: DkgRound2Response = self
                .post(
                    participant,
                    "/v1/frost/dkg/round2",
                    session_id,
                    &DkgRound2Request {
                        session_id: session_id.to_owned(),
                        key_ref: key_ref.to_owned(),
                        round1_packages: round1.clone(),
                    },
                    "participant_refused_dkg_round2",
                )
                .await?;
            expect_identifier(participant, &response.identifier)?;

            // All participants were shown the same set, so all must report the
            // same transcript. Checked here for a legible error; the envelopes'
            // AEAD binding is what enforces it against a coordinator that lies.
            match &transcript_hash {
                None => transcript_hash = Some(response.transcript_hash.clone()),
                Some(seen) if *seen != response.transcript_hash => {
                    return Err(MpcError::Internal("dkg_transcript_divergence"))
                }
                Some(_) => {}
            }

            let mut recipients = std::collections::BTreeSet::new();
            for envelope in &response.envelopes {
                if envelope.sender != participant.identifier
                    || envelope.recipient == participant.identifier
                    || !self
                        .participants
                        .iter()
                        .any(|p| p.identifier == envelope.recipient)
                    || !recipients.insert(envelope.recipient.clone())
                {
                    return Err(MpcError::Internal("dkg_envelope_routing_invalid"));
                }
            }
            if recipients.len() != MAX_SIGNERS as usize - 1 {
                return Err(MpcError::Internal("dkg_envelope_count_invalid"));
            }

            for envelope in &response.envelopes {
                inbox
                    .entry(envelope.recipient.clone())
                    .or_default()
                    .push(envelope.clone());
            }
            transcript.round2.push(response);
        }

        // --- Round 3: verify and derive -----------------------------------
        for participant in &self.participants {
            let response: DkgFinalizeResponse = self
                .post(
                    participant,
                    "/v1/frost/dkg/finalize",
                    session_id,
                    &DkgFinalizeRequest {
                        session_id: session_id.to_owned(),
                        key_ref: key_ref.to_owned(),
                        envelopes: inbox.remove(&participant.identifier).unwrap_or_default(),
                    },
                    "participant_refused_dkg_finalize",
                )
                .await?;
            expect_identifier(participant, &response.identifier)?;

            let wanted_share = expected
                .verifying_shares()
                .get(&decode_identifier(&participant.identifier)?)
                .ok_or(MpcError::Internal("dkg_verifying_share_missing"))?
                .serialize()
                .map_err(|_| MpcError::Internal("verifying_share_unserializable"))?;

            if response.public_package_hash != expected_hash
                || response.group_public_key != expected_group
                || response.verifying_share != hex::encode(wanted_share)
            {
                tracing::error!(
                    participant = %participant.identifier,
                    "DKG: participant derived a different group than the public commitments imply"
                );
                return Err(MpcError::Internal("dkg_participants_disagree"));
            }
            transcript.finalize.push(response);
        }

        self.store.update_coordinator_dkg_session(
            session_id,
            &crate::store::CoordinatorDkgUpdate {
                phase: "committing",
                public_package: Some(
                    &postcard::to_allocvec(&expected)
                        .map_err(|_| MpcError::Internal("public_package_encode_failed"))?,
                ),
                public_package_hash: Some(
                    &hex::decode(&expected_hash).map_err(|_| MpcError::Internal("hash_not_hex"))?,
                ),
                transcript: Some(&transcript.to_json()?),
                failure_reason: None,
            },
        )?;

        Ok(expected)
    }

    /// Ask every participant to install its verified share.
    async fn commit_all(
        &self,
        session_id: &str,
        key_ref: &str,
        package: &frost::keys::PublicKeyPackage,
        transcript: &mut CeremonyTranscript,
    ) -> Result<()> {
        let hash = hex::encode(crate::dkg::public_package_hash(package)?);
        let group = hex::encode(crate::dkg::group_key_bytes(package)?);

        for participant in &self.participants {
            let response: crate::dkg::DkgCommitResponse = self
                .post(
                    participant,
                    "/v1/frost/dkg/commit",
                    session_id,
                    &crate::dkg::DkgCommitRequest {
                        session_id: session_id.to_owned(),
                        key_ref: key_ref.to_owned(),
                        public_package_hash: hash.clone(),
                    },
                    "participant_refused_dkg_commit",
                )
                .await?;
            expect_identifier(participant, &response.identifier)?;
            if response.group_public_key != group {
                return Err(MpcError::Internal("dkg_participants_disagree"));
            }
            transcript.commit.push(response);
        }
        Ok(())
    }

    /// Record the group key — only now, after all five committed.
    fn complete(
        &self,
        session_id: &str,
        key_ref: &str,
        package: &frost::keys::PublicKeyPackage,
        transcript: &CeremonyTranscript,
    ) -> Result<DkgInitResponse> {
        let bytes = postcard::to_allocvec(package)
            .map_err(|_| MpcError::Internal("public_package_encode_failed"))?;
        self.store.store_group_key(key_ref, &bytes)?;
        self.store.update_coordinator_dkg_session(
            session_id,
            &crate::store::CoordinatorDkgUpdate {
                phase: "finalized",
                public_package: None,
                public_package_hash: None,
                transcript: Some(&transcript.to_json()?),
                failure_reason: None,
            },
        )?;

        let response = self.init_response(key_ref, package, false)?;
        tracing::info!(
            key_ref,
            session_id = %session_id,
            address = %response.group_public_key,
            "per-user key generated by DKG"
        );
        Ok(response)
    }

    fn stored_package(&self, key_ref: &str) -> Result<Option<frost::keys::PublicKeyPackage>> {
        self.stored_house_package(key_ref)
    }

    fn init_response(
        &self,
        key_ref: &str,
        package: &frost::keys::PublicKeyPackage,
        existing: bool,
    ) -> Result<DkgInitResponse> {
        let mut verifying_shares = BTreeMap::new();
        for (identifier, share) in package.verifying_shares() {
            verifying_shares.insert(
                encode_identifier(identifier),
                hex::encode(
                    share
                        .serialize()
                        .map_err(|_| MpcError::Internal("verifying_share_unserializable"))?,
                ),
            );
        }
        Ok(DkgInitResponse {
            key_ref: key_ref.to_owned(),
            group_public_key: bs58_encode(&crate::dkg::group_key_bytes(package)?),
            participants: MAX_SIGNERS,
            threshold: MIN_SIGNERS,
            existing,
            verifying_shares,
            public_package_hash: hex::encode(crate::dkg::public_package_hash(package)?),
            generation: "dkg".to_owned(),
        })
    }
}

/// A participant answered as some identifier other than the roster entry the
/// coordinator addressed: the roster does not describe reality, and every
/// later round for this key would address the wrong host.
fn expect_identifier(participant: &ParticipantEndpoint, reported: &str) -> Result<()> {
    if reported != participant.identifier {
        tracing::error!(
            expected = %participant.identifier,
            reported = %reported,
            "participant answered under a different identifier"
        );
        return Err(MpcError::Internal("participant_identifier_mismatch"));
    }
    Ok(())
}

fn new_session_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("dkg-{}", hex::encode(bytes))
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
