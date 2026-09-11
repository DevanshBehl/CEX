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

use std::collections::BTreeMap;
use std::time::Duration;

use frost::round1::SigningCommitments;
use frost::round2::SignatureShare;
use frost::{Identifier, Signature};
use frost_ed25519 as frost;
use serde::{Deserialize, Serialize};

use crate::error::{MpcError, Result};
use crate::frost::{aggregate, signing_package, MIN_SIGNERS};
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
    public_package: frost::keys::PublicKeyPackage,
}

impl Coordinator {
    pub fn new(
        participants: Vec<ParticipantEndpoint>,
        public_package: frost::keys::PublicKeyPackage,
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
        })
    }

    /// The group verifying key — the treasury's public key.
    pub fn group_public_key(&self) -> Result<Vec<u8>> {
        self.public_package
            .verifying_key()
            .serialize()
            .map_err(|_| MpcError::Internal("group_key_unserializable"))
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

        aggregate(&package, &shares, &self.public_package)
    }

    async fn commit(
        &self,
        participant: &ParticipantEndpoint,
        nonce_id: &str,
        key_ref: &str,
    ) -> Result<CommitResponse> {
        let url = format!("{}/v1/frost/commit", participant.url);
        let response = self
            .client
            .post(&url)
            .json(&CommitRequest {
                nonce_id: nonce_id.to_owned(),
                key_ref: key_ref.to_owned(),
            })
            .send()
            .await
            .map_err(|_| MpcError::Internal("participant_unreachable"))?;

        if !response.status().is_success() {
            return Err(MpcError::Internal("participant_refused_commit"));
        }

        response
            .json()
            .await
            .map_err(|_| MpcError::Internal("participant_response_invalid"))
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
        let url = format!("{}/v1/frost/share", participant.url);
        let response = self
            .client
            .post(&url)
            .json(&ShareRequest {
                nonce_id: nonce_id.to_owned(),
                key_ref: key_ref.to_owned(),
                payload: hex::encode(payload),
                commitments: commitments.clone(),
                authorization: authorization.clone(),
            })
            .send()
            .await
            .map_err(|_| MpcError::Internal("participant_unreachable"))?;

        if !response.status().is_success() {
            // A participant refusing round 2 after committing in round 1 is
            // the interesting failure: it means it verified the authorization
            // and did not like it. Logged at error level, because a
            // compromised coordinator proposing bad transactions looks exactly
            // like this.
            tracing::error!(
                participant = %participant.identifier,
                status = %response.status(),
                "participant refused to contribute a signature share"
            );
            return Err(MpcError::Internal("participant_refused_share"));
        }

        response
            .json()
            .await
            .map_err(|_| MpcError::Internal("participant_response_invalid"))
    }
}
