//! Distributed key generation: 3-of-5 FROST-Ed25519 with no trusted dealer
//! (ADR-0023).
//!
//! # The property
//!
//! **No machine, process or coordinator ever holds or can reconstruct a group
//! private key.** Each participant samples its own secret polynomial; the group
//! secret is the sum of five constant terms nobody ever adds up. The trusted
//! dealer this replaces (ADR-0020's interim) held the whole key by construction.
//!
//! # What is library, and what is ours
//!
//! The protocol mathematics is `frost_core::keys::dkg` — Pedersen DKG with
//! Feldman commitments and a Schnorr proof of knowledge of each constant term,
//! as specified alongside RFC 9591. `part2` verifies every proof of knowledge;
//! `part3` verifies every received share against its sender's commitments
//! (`s_{j,i}·G == Σ_k i^k·C_{j,k}`). Master-prompt rule 106 is why none of that
//! is reimplemented here.
//!
//! The library is explicit about the two things it does NOT provide, and they
//! are what this module owns:
//!
//! 1. **A confidential, authenticated channel for round-2 shares.** Shares
//!    travel through the coordinator. Each is sealed to its recipient with
//!    X25519 + HKDF-SHA256 + ChaCha20-Poly1305, mixing an ephemeral-static DH
//!    (confidentiality, forward secrecy for the sender) with a static-static DH
//!    (sender authentication). The coordinator can therefore neither read a
//!    share nor inject one under another participant's name. Peer public keys
//!    are PINNED in each participant's configuration and never taken from the
//!    coordinator — a coordinator that could substitute keys could read every
//!    share addressed to three participants and recover the key.
//!
//! 2. **A broadcast channel for round 1.** The coordinator could show
//!    different commitments to different participants. Every envelope is
//!    AEAD-bound to a hash of the ENTIRE round-1 transcript as its sender saw
//!    it, so a recipient with a different view cannot open it, and aborts.
//!    Each honest pair cross-checks its view this way, which is echo-broadcast
//!    for the price of a hash.
//!
//! # Two-phase finish
//!
//! `finalize` verifies and seals the final share as PENDING; `commit` installs
//! it as the share for the key. Between the two the coordinator checks that all
//! five participants — and its own recomputation from the public commitments —
//! agree on the group public key package. A single-phase finish would leave some
//! participants holding a share and others not whenever a later participant
//! refused, which is the split key set ADR-0020's provisioning lock exists to
//! prevent.

use std::collections::{BTreeMap, BTreeSet};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{AeadInPlace, ChaCha20Poly1305, KeyInit, Nonce};
use frost::keys::dkg::{round1, round2};
use frost::keys::PublicKeyPackage;
use frost::Identifier;
use frost_ed25519 as frost;
use hkdf::Hkdf;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::error::{MpcError, Result};
use crate::frost::{MAX_SIGNERS, MIN_SIGNERS};
use crate::keystore::Kek;
use crate::store::{DkgCommitOutcome, Store};
use crate::threshold::{decode_identifier, encode_identifier};

/// Domain separator for every hash, KDF and AEAD input in the ceremony.
/// Versioned so a future change cannot be confused with this one on the wire.
pub const DKG_PROTOCOL: &str = "atlas-wallet/frost-ed25519-dkg/v1";

// ---------------------------------------------------------------------------
// Transport identity
// ---------------------------------------------------------------------------

/// A participant's long-term X25519 key for DKG share transport.
///
/// Generated inside the participant on first use and sealed under its KEK —
/// the same at-rest rule as a share (ADR-0014). The secret never leaves this
/// type; the public half is what operators pin in every peer's `MPC_DKG_PEERS`.
pub struct DkgIdentity {
    secret: StaticSecret,
    public: PublicKey,
}

impl std::fmt::Debug for DkgIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DkgIdentity(pub={})", B64.encode(self.public.as_bytes()))
    }
}

impl DkgIdentity {
    /// Load this participant's identity, creating it on first use.
    pub fn load_or_create(store: &Store, kek: &Kek) -> Result<Self> {
        if let Some(existing) = Self::load(store, kek)? {
            return Ok(existing);
        }

        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        let bytes = Zeroizing::new(secret.to_bytes());
        store.store_dkg_identity(public.as_bytes(), &kek.seal(bytes.as_slice())?)?;

        // Re-read rather than returning what was generated: the insert is
        // first-writer-wins, and a concurrent first boot must end up with the
        // identity that was actually persisted.
        Self::load(store, kek)?.ok_or(MpcError::Internal("dkg_identity_not_persisted"))
    }

    fn load(store: &Store, kek: &Kek) -> Result<Option<Self>> {
        let Some((public_bytes, sealed)) = store.load_dkg_identity()? else {
            return Ok(None);
        };
        let opened = Zeroizing::new(kek.open(&sealed)?);
        let bytes: [u8; 32] = opened
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::Internal("dkg_identity_corrupt"))?;
        let secret = StaticSecret::from(bytes);
        let public = PublicKey::from(&secret);

        // A stored public key that does not match the sealed secret means the
        // row was tampered with or the wrong KEK is in use. Either way, peers
        // have pinned something this process cannot answer for.
        if public.as_bytes().as_slice() != public_bytes.as_slice() {
            return Err(MpcError::Internal("dkg_identity_mismatch"));
        }
        Ok(Some(Self { secret, public }))
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.public.to_bytes()
    }

    pub fn public_key_base64(&self) -> String {
        B64.encode(self.public.as_bytes())
    }
}

/// Everything a participant needs to take part in a ceremony: who it is, and
/// the pinned transport key of every member of the roster, itself included.
pub struct DkgContext {
    identity: DkgIdentity,
    identifier: Identifier,
    peers: BTreeMap<Identifier, PublicKey>,
}

impl DkgContext {
    /// Build a context from a pinned roster.
    ///
    /// This participant's identifier is FOUND in the roster by its own public
    /// key rather than told to it by anyone — the coordinator in particular. A
    /// coordinator that could assign identifiers could give two participants
    /// the same one.
    pub fn new(identity: DkgIdentity, peers: BTreeMap<Identifier, [u8; 32]>) -> Result<Self> {
        if peers.len() != MAX_SIGNERS as usize {
            return Err(MpcError::Internal("dkg_roster_wrong_size"));
        }

        let distinct: BTreeSet<[u8; 32]> = peers.values().copied().collect();
        if distinct.len() != peers.len() {
            return Err(MpcError::Internal("dkg_roster_duplicate_key"));
        }

        let own = identity.public_key();
        let mut matching = peers.iter().filter(|(_, key)| **key == own);
        let identifier = match (matching.next(), matching.next()) {
            (Some((identifier, _)), None) => *identifier,
            _ => return Err(MpcError::Internal("dkg_roster_does_not_contain_self")),
        };

        Ok(Self {
            identity,
            identifier,
            peers: peers
                .into_iter()
                .map(|(identifier, key)| (identifier, PublicKey::from(key)))
                .collect(),
        })
    }

    /// Parse `MPC_DKG_PEERS`: comma-separated `identifier_hex=base64_x25519_key`.
    pub fn parse_peers(value: &str) -> Result<BTreeMap<Identifier, [u8; 32]>> {
        let mut peers = BTreeMap::new();
        for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            let (identifier, key) = entry
                .split_once('=')
                .ok_or(MpcError::Internal("dkg_peer_entry_malformed"))?;
            let identifier = decode_identifier(identifier.trim())
                .map_err(|_| MpcError::Internal("dkg_peer_identifier_invalid"))?;
            let key: [u8; 32] = B64
                .decode(key.trim())
                .map_err(|_| MpcError::Internal("dkg_peer_key_not_base64"))?
                .as_slice()
                .try_into()
                .map_err(|_| MpcError::Internal("dkg_peer_key_wrong_length"))?;
            if peers.insert(identifier, key).is_some() {
                return Err(MpcError::Internal("dkg_peer_identifier_duplicated"));
            }
        }
        Ok(peers)
    }

    pub fn identifier(&self) -> Identifier {
        self.identifier
    }

    pub fn identity(&self) -> &DkgIdentity {
        &self.identity
    }

    fn peer_key(&self, identifier: &Identifier) -> Result<&PublicKey> {
        self.peers
            .get(identifier)
            .ok_or(MpcError::BadRequest("dkg_unknown_participant"))
    }

    fn others(&self) -> BTreeSet<Identifier> {
        self.peers
            .keys()
            .copied()
            .filter(|identifier| *identifier != self.identifier)
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Round-1 transcript binding
// ---------------------------------------------------------------------------

/// Hash of the complete round-1 view: every participant's commitments and
/// proof, in identifier order, bound to the session and key.
///
/// Two participants with different views compute different hashes, and every
/// envelope is AEAD-bound to its sender's — so a coordinator that equivocated
/// in round 1 produces envelopes that do not open.
pub fn transcript_hash(
    session_id: &str,
    key_ref: &str,
    packages: &BTreeMap<Identifier, round1::Package>,
) -> Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    absorb(&mut hasher, DKG_PROTOCOL.as_bytes());
    absorb(&mut hasher, b"round1-transcript");
    absorb(&mut hasher, session_id.as_bytes());
    absorb(&mut hasher, key_ref.as_bytes());
    hasher.update(MIN_SIGNERS.to_be_bytes());
    hasher.update(MAX_SIGNERS.to_be_bytes());
    hasher.update((packages.len() as u32).to_be_bytes());
    for (identifier, package) in packages {
        absorb(&mut hasher, &identifier.serialize());
        absorb(&mut hasher, &encode_postcard(package)?);
    }
    Ok(hasher.finalize().into())
}

/// Hash of a group's public key package — what all five participants and the
/// coordinator must agree on before anything is committed.
pub fn public_package_hash(package: &PublicKeyPackage) -> Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    absorb(&mut hasher, DKG_PROTOCOL.as_bytes());
    absorb(&mut hasher, b"public-key-package");
    absorb(&mut hasher, &encode_postcard(package)?);
    Ok(hasher.finalize().into())
}

/// The group package implied by a set of round-1 commitments.
///
/// Public computation: `Y = Σ_j C_{j,0}` and each verifying share from the
/// summed commitment. The coordinator uses it to check participants' results
/// without being trusted with, or able to learn, anything secret.
pub fn expected_public_package(
    packages: &BTreeMap<Identifier, round1::Package>,
) -> Result<PublicKeyPackage> {
    let commitments: BTreeMap<Identifier, _> = packages
        .iter()
        .map(|(identifier, package)| (*identifier, package.commitment()))
        .collect();
    PublicKeyPackage::from_dkg_commitments(&commitments)
        .map_err(|_| MpcError::BadRequest("dkg_commitments_invalid"))
}

fn absorb(hasher: &mut Sha256, part: &[u8]) {
    hasher.update((part.len() as u32).to_be_bytes());
    hasher.update(part);
}

// ---------------------------------------------------------------------------
// Share envelopes
// ---------------------------------------------------------------------------

/// One round-2 share, sealed from one participant to another.
///
/// Everything here is safe for the coordinator to see, route and store.
#[derive(Clone, Serialize, Deserialize)]
pub struct ShareEnvelope {
    pub sender: String,
    pub recipient: String,
    /// Hex X25519 public key, fresh per envelope.
    #[serde(rename = "ephemeralPublicKey")]
    pub ephemeral_public_key: String,
    /// Hex. The sender's round-1 transcript hash; also inside the AEAD's
    /// associated data, so it cannot be edited in transit.
    #[serde(rename = "transcriptHash")]
    pub transcript_hash: String,
    /// Hex ChaCha20-Poly1305 ciphertext of the postcard `round2::Package`.
    pub ciphertext: String,
}

/// Everything an envelope's key and AEAD tag are bound to.
#[allow(clippy::too_many_arguments)]
fn envelope_context(
    session_id: &str,
    key_ref: &str,
    sender: &Identifier,
    recipient: &Identifier,
    sender_static: &PublicKey,
    recipient_static: &PublicKey,
    ephemeral: &PublicKey,
    transcript: &[u8],
) -> Vec<u8> {
    let sender_id = sender.serialize();
    let recipient_id = recipient.serialize();
    let parts: [&[u8]; 10] = [
        DKG_PROTOCOL.as_bytes(),
        b"share-envelope",
        session_id.as_bytes(),
        key_ref.as_bytes(),
        &sender_id,
        &recipient_id,
        sender_static.as_bytes(),
        recipient_static.as_bytes(),
        ephemeral.as_bytes(),
        transcript,
    ];
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(&(part.len() as u32).to_be_bytes());
        out.extend_from_slice(part);
    }
    out
}

/// HKDF-SHA256 over both DH outputs, bound to the full context.
///
/// Both DH results must be contributory: a low-order peer key would make the
/// shared secret predictable, and x25519 would otherwise accept it silently.
fn derive_envelope_key(
    ephemeral_dh: &x25519_dalek::SharedSecret,
    static_dh: &x25519_dalek::SharedSecret,
    context: &[u8],
) -> Result<Zeroizing<[u8; 32]>> {
    if !ephemeral_dh.was_contributory() || !static_dh.was_contributory() {
        return Err(MpcError::BadRequest("dkg_non_contributory_key"));
    }
    let mut ikm = Zeroizing::new([0u8; 64]);
    ikm[..32].copy_from_slice(ephemeral_dh.as_bytes());
    ikm[32..].copy_from_slice(static_dh.as_bytes());

    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(DKG_PROTOCOL.as_bytes()), ikm.as_slice())
        .expand(context, key.as_mut_slice())
        .map_err(|_| MpcError::Crypto("dkg_kdf_failed"))?;
    Ok(key)
}

/// A fixed nonce is correct here, not a shortcut: every envelope key is unique
/// because every envelope has a fresh ephemeral key, so a (key, nonce) pair is
/// never reused. This is HPKE's single-shot construction.
fn envelope_nonce() -> Nonce {
    Nonce::from([0u8; 12])
}

/// Seal one round-2 share from `context`'s participant to `recipient`.
///
/// Public so an integration test can play a MALICIOUS participant — one that
/// seals a forged share correctly — which is the only way to prove recipients
/// reject a share on its mathematics rather than on its encryption.
pub fn seal_share(
    context: &DkgContext,
    recipient: Identifier,
    session_id: &str,
    key_ref: &str,
    transcript: &[u8; 32],
    package: &round2::Package,
) -> Result<ShareEnvelope> {
    if recipient == context.identifier {
        return Err(MpcError::Internal("dkg_envelope_to_self"));
    }
    let recipient_static = context.peer_key(&recipient)?;

    let ephemeral = EphemeralSecret::random_from_rng(OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral);

    let aad = envelope_context(
        session_id,
        key_ref,
        &context.identifier,
        &recipient,
        &context.identity.public,
        recipient_static,
        &ephemeral_public,
        transcript,
    );
    let key = derive_envelope_key(
        &ephemeral.diffie_hellman(recipient_static),
        &context.identity.secret.diffie_hellman(recipient_static),
        &aad,
    )?;

    // Encrypted in place: the buffer holds the plaintext share until this
    // call returns, and only ciphertext afterwards.
    let mut ciphertext = encode_postcard(package)?;
    ChaCha20Poly1305::new(key.as_slice().into())
        .encrypt_in_place(&envelope_nonce(), &aad, &mut ciphertext)
        .map_err(|_| MpcError::Crypto("dkg_seal_failed"))?;

    Ok(ShareEnvelope {
        sender: encode_identifier(&context.identifier),
        recipient: encode_identifier(&recipient),
        ephemeral_public_key: hex::encode(ephemeral_public.as_bytes()),
        transcript_hash: hex::encode(transcript),
        ciphertext: hex::encode(ciphertext),
    })
}

/// Open an envelope addressed to `context`'s participant.
///
/// Fails unless the envelope was sealed by the claimed sender's pinned key,
/// for this recipient, session, key_ref and round-1 transcript.
fn open_share(
    context: &DkgContext,
    envelope: &ShareEnvelope,
    session_id: &str,
    key_ref: &str,
    transcript: &[u8],
) -> Result<(Identifier, round2::Package)> {
    let sender = decode_identifier(&envelope.sender)?;
    let recipient = decode_identifier(&envelope.recipient)?;
    if recipient != context.identifier {
        return Err(MpcError::BadRequest("dkg_envelope_misaddressed"));
    }
    let sender_static = context.peer_key(&sender)?;

    let ephemeral_bytes: [u8; 32] = hex::decode(&envelope.ephemeral_public_key)
        .map_err(|_| MpcError::BadRequest("dkg_envelope_malformed"))?
        .as_slice()
        .try_into()
        .map_err(|_| MpcError::BadRequest("dkg_envelope_malformed"))?;
    let ephemeral_public = PublicKey::from(ephemeral_bytes);
    let ciphertext = hex::decode(&envelope.ciphertext)
        .map_err(|_| MpcError::BadRequest("dkg_envelope_malformed"))?;

    let aad = envelope_context(
        session_id,
        key_ref,
        &sender,
        &context.identifier,
        sender_static,
        &context.identity.public,
        &ephemeral_public,
        transcript,
    );
    let key = derive_envelope_key(
        &context.identity.secret.diffie_hellman(&ephemeral_public),
        &context.identity.secret.diffie_hellman(sender_static),
        &aad,
    )?;

    let mut plaintext = Zeroizing::new(ciphertext);
    ChaCha20Poly1305::new(key.as_slice().into())
        .decrypt_in_place(&envelope_nonce(), &aad, &mut *plaintext)
        .map_err(|_| MpcError::BadRequest("dkg_envelope_rejected"))?;
    let package = postcard::from_bytes(&plaintext)
        .map_err(|_| MpcError::BadRequest("dkg_envelope_malformed"))?;
    Ok((sender, package))
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct DkgRound1Request {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// Stated by the coordinator and CHECKED by the participant: a coordinator
    /// configured for different parameters is refused rather than obeyed.
    #[serde(rename = "minSigners")]
    pub min_signers: u16,
    #[serde(rename = "maxSigners")]
    pub max_signers: u16,
}

#[derive(Serialize, Deserialize)]
pub struct DkgRound1Response {
    pub identifier: String,
    /// Hex postcard `round1::Package`: coefficient commitments + proof of
    /// knowledge of the constant term. Public.
    pub package: String,
}

#[derive(Serialize, Deserialize)]
pub struct DkgRound2Request {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// ALL five round-1 packages, the recipient's own included, so it can
    /// confirm its own commitment is the one everyone else is being shown.
    #[serde(rename = "round1Packages")]
    pub round1_packages: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
pub struct DkgRound2Response {
    pub identifier: String,
    #[serde(rename = "transcriptHash")]
    pub transcript_hash: String,
    /// One per other participant.
    pub envelopes: Vec<ShareEnvelope>,
}

#[derive(Serialize, Deserialize)]
pub struct DkgFinalizeRequest {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// The envelopes addressed to this participant: exactly one per peer.
    pub envelopes: Vec<ShareEnvelope>,
}

#[derive(Serialize, Deserialize)]
pub struct DkgFinalizeResponse {
    pub identifier: String,
    /// Hex, 32 bytes.
    #[serde(rename = "groupPublicKey")]
    pub group_public_key: String,
    /// Hex. `Y_i = s_i·G`, this participant's public verification share.
    #[serde(rename = "verifyingShare")]
    pub verifying_share: String,
    #[serde(rename = "publicPackageHash")]
    pub public_package_hash: String,
}

#[derive(Serialize, Deserialize)]
pub struct DkgCommitRequest {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "keyRef")]
    pub key_ref: String,
    /// The group every participant agreed on. A participant whose own result
    /// differs refuses to install.
    #[serde(rename = "publicPackageHash")]
    pub public_package_hash: String,
}

#[derive(Serialize, Deserialize)]
pub struct DkgCommitResponse {
    pub identifier: String,
    #[serde(rename = "groupPublicKey")]
    pub group_public_key: String,
}

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

/// One participant's side of the ceremony, over its own store and KEK.
///
/// Every transition is a conditional update on the session's phase, so a
/// replayed or reordered request loses to the database rather than re-running
/// a round. Every failure after round 1 wipes the session's secret before it
/// returns: an aborted ceremony leaves nothing behind worth stealing.
pub struct DkgParticipant<'a> {
    pub store: &'a Store,
    pub kek: &'a Kek,
    pub context: &'a DkgContext,
}

impl DkgParticipant<'_> {
    /// Round 1: sample a polynomial, commit to it, prove knowledge of its
    /// constant term.
    pub fn round1(&self, request: &DkgRound1Request) -> Result<DkgRound1Response> {
        validate_session(&request.session_id, &request.key_ref)?;
        if request.min_signers != MIN_SIGNERS || request.max_signers != MAX_SIGNERS {
            return Err(MpcError::BadRequest("dkg_threshold_mismatch"));
        }
        if self.store.load_share(&request.key_ref)?.is_some() {
            return Err(MpcError::BadRequest("share_already_installed"));
        }

        let identifier = self.context.identifier;

        if let Some(existing) = self.store.load_dkg_session(&request.session_id)? {
            // A coordinator retrying a lost response gets the SAME public
            // package; a fresh polynomial under one session id would be two
            // commitments for one ceremony.
            if existing.key_ref == request.key_ref
                && existing.phase == "round1"
                && existing.identifier == identifier.serialize()
            {
                return Ok(DkgRound1Response {
                    identifier: encode_identifier(&identifier),
                    package: hex::encode(existing.round1_package),
                });
            }
            return Err(MpcError::BadRequest("dkg_session_conflict"));
        }

        let (secret, package) =
            frost::keys::dkg::part1(identifier, MAX_SIGNERS, MIN_SIGNERS, OsRng)
                .map_err(|_| MpcError::Internal("dkg_part1_failed"))?;

        let secret_bytes = Zeroizing::new(encode_postcard(&secret)?);
        let package_bytes = encode_postcard(&package)?;

        if !self.store.begin_dkg_session(
            &request.session_id,
            &request.key_ref,
            &identifier.serialize(),
            &self.kek.seal(&secret_bytes)?,
            &package_bytes,
        )? {
            return Err(MpcError::BadRequest("dkg_session_conflict"));
        }

        Ok(DkgRound1Response {
            identifier: encode_identifier(&identifier),
            package: hex::encode(package_bytes),
        })
    }

    /// Round 2: verify every peer's proof of knowledge, evaluate our
    /// polynomial at each peer, and seal each evaluation to its recipient.
    pub fn round2(&self, request: &DkgRound2Request) -> Result<DkgRound2Response> {
        let session = self.session(&request.session_id, &request.key_ref, "round1")?;
        let identifier = self.context.identifier;

        let result = (|| {
            let all = self.decode_round1_set(&request.round1_packages)?;

            // Our own package must be exactly the one we published. Otherwise
            // the coordinator is showing everyone a commitment we never made.
            let ours: round1::Package = postcard::from_bytes(&session.round1_package)
                .map_err(|_| MpcError::Internal("dkg_session_corrupt"))?;
            if all.get(&identifier) != Some(&ours) {
                return Err(MpcError::BadRequest("dkg_own_commitment_substituted"));
            }

            let transcript = transcript_hash(&request.session_id, &request.key_ref, &all)?;
            let others: BTreeMap<_, _> = all
                .iter()
                .filter(|(id, _)| **id != identifier)
                .map(|(id, package)| (*id, package.clone()))
                .collect();

            let secret = self.open_secret::<round1::SecretPackage>(&session)?;
            let (next_secret, shares) =
                frost::keys::dkg::part2(secret, &others).map_err(|error| match error {
                    frost::Error::InvalidProofOfKnowledge { culprit } => {
                        tracing::error!(
                            session_id = %request.session_id,
                            culprit = %encode_identifier(&culprit),
                            "DKG: a participant's proof of knowledge is invalid"
                        );
                        MpcError::BadRequest("dkg_invalid_proof_of_knowledge")
                    }
                    _ => MpcError::BadRequest("dkg_round1_packages_invalid"),
                })?;

            let mut envelopes = Vec::with_capacity(shares.len());
            for (recipient, package) in &shares {
                envelopes.push(seal_share(
                    self.context,
                    *recipient,
                    &request.session_id,
                    &request.key_ref,
                    &transcript,
                    package,
                )?);
            }

            let next_bytes = Zeroizing::new(encode_postcard(&next_secret)?);
            // Persisted BEFORE the envelopes are returned, so the state that
            // produced them survives a crash and a replay cannot re-run part2.
            if !self.store.advance_dkg_to_round2(
                &request.session_id,
                &self.kek.seal(&next_bytes)?,
                &encode_postcard(&all)?,
                &transcript,
            )? {
                return Err(MpcError::BadRequest("dkg_phase_mismatch"));
            }

            Ok(DkgRound2Response {
                identifier: encode_identifier(&identifier),
                transcript_hash: hex::encode(transcript),
                envelopes,
            })
        })();

        self.abort_on_failure(&request.session_id, result)
    }

    /// Round 3: open each share, verify it against its sender's commitments,
    /// and derive `s_i = Σ_j s_{j,i}`. Sealed as PENDING; see `commit`.
    pub fn finalize(&self, request: &DkgFinalizeRequest) -> Result<DkgFinalizeResponse> {
        let session = self.session(&request.session_id, &request.key_ref, "round2")?;
        let identifier = self.context.identifier;

        let result = (|| {
            let all: BTreeMap<Identifier, round1::Package> = postcard::from_bytes(
                session
                    .round1_packages
                    .as_deref()
                    .ok_or(MpcError::Internal("dkg_session_corrupt"))?,
            )
            .map_err(|_| MpcError::Internal("dkg_session_corrupt"))?;
            let transcript = session
                .transcript_hash
                .clone()
                .ok_or(MpcError::Internal("dkg_session_corrupt"))?;

            let expected = self.context.others();
            if request.envelopes.len() != expected.len() {
                return Err(MpcError::BadRequest("dkg_wrong_envelope_count"));
            }

            let mut received = BTreeMap::new();
            for envelope in &request.envelopes {
                // Checked in the clear first only for a legible reason; the
                // AEAD binding below is what actually enforces it.
                if envelope.transcript_hash != hex::encode(&transcript) {
                    tracing::error!(
                        session_id = %request.session_id,
                        sender = %envelope.sender,
                        "DKG: a peer saw a different round-1 transcript — possible coordinator \
                         equivocation"
                    );
                    return Err(MpcError::BadRequest("dkg_transcript_mismatch"));
                }
                let (sender, package) = open_share(
                    self.context,
                    envelope,
                    &request.session_id,
                    &request.key_ref,
                    &transcript,
                )?;
                if !expected.contains(&sender) || received.insert(sender, package).is_some() {
                    return Err(MpcError::BadRequest("dkg_unexpected_envelope_sender"));
                }
            }

            let others: BTreeMap<_, _> = all
                .iter()
                .filter(|(id, _)| **id != identifier)
                .map(|(id, package)| (*id, package.clone()))
                .collect();

            let secret = self.open_secret::<round2::SecretPackage>(&session)?;
            let (key_package, public_package) = frost::keys::dkg::part3(
                &secret, &others, &received,
            )
            .map_err(|error| match error {
                frost::Error::InvalidSecretShare { culprit } => {
                    tracing::error!(
                        session_id = %request.session_id,
                        culprit = %culprit.map(|c| encode_identifier(&c)).unwrap_or_default(),
                        "DKG: a received share does not match its sender's commitments; \
                         aborting before any key state is saved"
                    );
                    MpcError::BadRequest("dkg_invalid_share")
                }
                _ => MpcError::BadRequest("dkg_round2_packages_invalid"),
            })?;
            drop(received);

            // Belt and braces over the library: the result must be the
            // ceremony we were configured for.
            if *key_package.min_signers() != MIN_SIGNERS
                || public_package.verifying_shares().len() != MAX_SIGNERS as usize
                || *key_package.identifier() != identifier
            {
                return Err(MpcError::Internal("dkg_result_shape_invalid"));
            }

            let key_bytes = Zeroizing::new(encode_postcard(&key_package)?);
            if !self.store.advance_dkg_to_verified(
                &request.session_id,
                &self.kek.seal(&key_bytes)?,
                &encode_postcard(&public_package)?,
            )? {
                return Err(MpcError::BadRequest("dkg_phase_mismatch"));
            }

            Ok(DkgFinalizeResponse {
                identifier: encode_identifier(&identifier),
                group_public_key: hex::encode(group_key_bytes(&public_package)?),
                verifying_share: hex::encode(
                    key_package
                        .verifying_share()
                        .serialize()
                        .map_err(|_| MpcError::Internal("verifying_share_unserializable"))?,
                ),
                public_package_hash: hex::encode(public_package_hash(&public_package)?),
            })
        })();

        self.abort_on_failure(&request.session_id, result)
    }

    /// Install the verified share as THE share for this key.
    pub fn commit(&self, request: &DkgCommitRequest) -> Result<DkgCommitResponse> {
        validate_session(&request.session_id, &request.key_ref)?;
        let session = self
            .store
            .load_dkg_session(&request.session_id)?
            .ok_or(MpcError::BadRequest("dkg_unknown_session"))?;
        if session.key_ref != request.key_ref {
            return Err(MpcError::BadRequest("dkg_session_conflict"));
        }

        let public_bytes = session
            .public_package
            .as_deref()
            .ok_or(MpcError::BadRequest("dkg_phase_mismatch"))?;
        let public_package: PublicKeyPackage = postcard::from_bytes(public_bytes)
            .map_err(|_| MpcError::Internal("dkg_session_corrupt"))?;

        // Not an abort: disagreement here is the coordinator's to resolve, and
        // wiping a verified share would turn a bug into data loss.
        if hex::encode(public_package_hash(&public_package)?) != request.public_package_hash {
            return Err(MpcError::BadRequest("dkg_public_package_mismatch"));
        }

        match self
            .store
            .commit_dkg_session(&request.session_id, MIN_SIGNERS, MAX_SIGNERS)?
        {
            DkgCommitOutcome::Committed | DkgCommitOutcome::AlreadyCommitted => {}
            DkgCommitOutcome::NotVerified => {
                return Err(MpcError::BadRequest("dkg_phase_mismatch"))
            }
            DkgCommitOutcome::ShareAlreadyInstalled => {
                return Err(MpcError::BadRequest("share_already_installed"))
            }
        }

        tracing::info!(
            session_id = %request.session_id,
            key_ref = %request.key_ref,
            "DKG share committed"
        );

        Ok(DkgCommitResponse {
            identifier: encode_identifier(&self.context.identifier),
            group_public_key: hex::encode(group_key_bytes(&public_package)?),
        })
    }

    fn session(
        &self,
        session_id: &str,
        key_ref: &str,
        phase: &str,
    ) -> Result<crate::store::DkgSessionRow> {
        validate_session(session_id, key_ref)?;
        let session = self
            .store
            .load_dkg_session(session_id)?
            .ok_or(MpcError::BadRequest("dkg_unknown_session"))?;
        if session.key_ref != key_ref {
            return Err(MpcError::BadRequest("dkg_session_conflict"));
        }
        if session.phase != phase {
            return Err(MpcError::BadRequest("dkg_phase_mismatch"));
        }
        Ok(session)
    }

    fn open_secret<T: serde::de::DeserializeOwned>(
        &self,
        session: &crate::store::DkgSessionRow,
    ) -> Result<T> {
        let sealed = session
            .sealed_secret
            .as_deref()
            .ok_or(MpcError::Internal("dkg_session_secret_missing"))?;
        let bytes = Zeroizing::new(self.kek.open(sealed)?);
        postcard::from_bytes(&bytes).map_err(|_| MpcError::Internal("dkg_session_corrupt"))
    }

    fn decode_round1_set(
        &self,
        encoded: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<Identifier, round1::Package>> {
        let mut all = BTreeMap::new();
        for (identifier, package) in encoded {
            let identifier = decode_identifier(identifier)?;
            let bytes =
                hex::decode(package).map_err(|_| MpcError::BadRequest("dkg_package_not_hex"))?;
            let package: round1::Package = postcard::from_bytes(&bytes)
                .map_err(|_| MpcError::BadRequest("dkg_package_invalid"))?;
            all.insert(identifier, package);
        }
        // Exactly the pinned roster: no extra members, none missing.
        let roster: BTreeSet<_> = self.context.peers.keys().copied().collect();
        if all.keys().copied().collect::<BTreeSet<_>>() != roster {
            return Err(MpcError::BadRequest("dkg_round1_set_not_roster"));
        }
        Ok(all)
    }

    /// Wipe the session's secret on any failure, then return the failure.
    fn abort_on_failure<T>(&self, session_id: &str, result: Result<T>) -> Result<T> {
        if let Err(error) = &result {
            // `dkg_phase_mismatch` from a lost race means another request owns
            // the session; aborting it would sabotage the winner.
            if !matches!(error, MpcError::BadRequest("dkg_phase_mismatch")) {
                self.store.abort_dkg_session(session_id, &error.reason())?;
            }
        }
        result
    }
}

fn validate_session(session_id: &str, key_ref: &str) -> Result<()> {
    let valid_id = !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'));
    if !valid_id {
        return Err(MpcError::BadRequest("dkg_session_id_invalid"));
    }
    if key_ref.trim().is_empty() || key_ref.len() > 256 {
        return Err(MpcError::BadRequest("key_ref_invalid"));
    }
    Ok(())
}

pub fn group_key_bytes(package: &PublicKeyPackage) -> Result<[u8; 32]> {
    package
        .verifying_key()
        .serialize()
        .map_err(|_| MpcError::Internal("group_key_unserializable"))?
        .as_slice()
        .try_into()
        .map_err(|_| MpcError::Internal("group_key_wrong_length"))
}

pub fn encode_postcard<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    postcard::to_allocvec(value).map_err(|_| MpcError::Internal("encode_failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const KEY_REF: &str = "user:dkg-unit";

    struct Node {
        store: Arc<Store>,
        kek: Kek,
        context: DkgContext,
    }

    impl Node {
        fn participant(&self) -> DkgParticipant<'_> {
            DkgParticipant {
                store: &self.store,
                kek: &self.kek,
                context: &self.context,
            }
        }
    }

    fn kek(index: u8) -> Kek {
        Kek::from_base64(&B64.encode([100 + index; 32])).unwrap()
    }

    /// Five participants, each with its own store, KEK and transport identity.
    fn nodes() -> Vec<Node> {
        let stores: Vec<_> = (0..MAX_SIGNERS)
            .map(|_| Arc::new(Store::in_memory().unwrap()))
            .collect();
        let identities: Vec<_> = stores
            .iter()
            .enumerate()
            .map(|(i, store)| DkgIdentity::load_or_create(store, &kek(i as u8)).unwrap())
            .collect();
        let peers: BTreeMap<Identifier, [u8; 32]> = identities
            .iter()
            .enumerate()
            .map(|(i, identity)| {
                (
                    Identifier::try_from(i as u16 + 1).unwrap(),
                    identity.public_key(),
                )
            })
            .collect();

        stores
            .into_iter()
            .zip(identities)
            .enumerate()
            .map(|(i, (store, identity))| Node {
                store,
                kek: kek(i as u8),
                context: DkgContext::new(identity, peers.clone()).unwrap(),
            })
            .collect()
    }

    fn round1_all(nodes: &[Node], session: &str) -> BTreeMap<String, String> {
        nodes
            .iter()
            .map(|node| {
                let response = node
                    .participant()
                    .round1(&DkgRound1Request {
                        session_id: session.into(),
                        key_ref: KEY_REF.into(),
                        min_signers: MIN_SIGNERS,
                        max_signers: MAX_SIGNERS,
                    })
                    .unwrap();
                (response.identifier, response.package)
            })
            .collect()
    }

    fn round2_all(
        nodes: &[Node],
        session: &str,
        round1: &BTreeMap<String, String>,
    ) -> Vec<ShareEnvelope> {
        nodes
            .iter()
            .flat_map(|node| {
                node.participant()
                    .round2(&DkgRound2Request {
                        session_id: session.into(),
                        key_ref: KEY_REF.into(),
                        round1_packages: round1.clone(),
                    })
                    .unwrap()
                    .envelopes
            })
            .collect()
    }

    fn addressed_to(envelopes: &[ShareEnvelope], node: &Node) -> Vec<ShareEnvelope> {
        let me = encode_identifier(&node.context.identifier());
        envelopes
            .iter()
            .filter(|e| e.recipient == me)
            .cloned()
            .collect()
    }

    fn finalize(
        node: &Node,
        session: &str,
        envelopes: &[ShareEnvelope],
    ) -> Result<DkgFinalizeResponse> {
        node.participant().finalize(&DkgFinalizeRequest {
            session_id: session.into(),
            key_ref: KEY_REF.into(),
            envelopes: addressed_to(envelopes, node),
        })
    }

    /// The whole ceremony, played in-process with an honest coordinator.
    fn ceremony(nodes: &[Node], session: &str) -> PublicKeyPackage {
        let round1 = round1_all(nodes, session);
        let envelopes = round2_all(nodes, session, &round1);
        let finals: Vec<_> = nodes
            .iter()
            .map(|node| finalize(node, session, &envelopes).unwrap())
            .collect();
        for node in nodes {
            node.participant()
                .commit(&DkgCommitRequest {
                    session_id: session.into(),
                    key_ref: KEY_REF.into(),
                    public_package_hash: finals[0].public_package_hash.clone(),
                })
                .unwrap();
        }
        let (_, group, _, _) = nodes[0].store.load_share(KEY_REF).unwrap().unwrap();
        postcard::from_bytes(&group).unwrap()
    }

    fn sign_with(nodes: &[&Node], public: &PublicKeyPackage, message: &[u8]) -> frost::Signature {
        let participants: Vec<_> = nodes
            .iter()
            .map(|node| {
                crate::frost::Participant::load(
                    Arc::clone(&node.store),
                    node.kek.duplicate(),
                    KEY_REF,
                )
                .unwrap()
                .unwrap()
            })
            .collect();
        let mut commitments = BTreeMap::new();
        for (i, participant) in participants.iter().enumerate() {
            commitments.insert(
                participant.identifier(),
                participant.commit(&format!("n{i}")).unwrap(),
            );
        }
        let package = crate::frost::signing_package(commitments, message);
        let mut shares = BTreeMap::new();
        for (i, participant) in participants.iter().enumerate() {
            shares.insert(
                participant.identifier(),
                participant.sign(&format!("n{i}"), &package).unwrap(),
            );
        }
        crate::frost::aggregate(&package, &shares, public).unwrap()
    }

    #[test]
    fn a_full_ceremony_yields_one_group_that_any_three_can_sign_for() {
        let nodes = nodes();
        let public = ceremony(&nodes, "s1");

        // Every participant installed the same group.
        for node in &nodes {
            let (_, group, _, _) = node.store.load_share(KEY_REF).unwrap().unwrap();
            let theirs: PublicKeyPackage = postcard::from_bytes(&group).unwrap();
            assert_eq!(theirs, public);
        }

        let message = b"withdrawal";
        let signature = sign_with(&[&nodes[0], &nodes[2], &nodes[4]], &public, message);
        assert!(public.verifying_key().verify(message, &signature).is_ok());
    }

    #[test]
    fn the_group_key_is_the_sum_of_the_public_constant_terms() {
        // Y = Σ C_{j,0}: computable by anyone from public data, which is what
        // lets the coordinator check the participants without trusting them.
        let nodes = nodes();
        let round1 = round1_all(&nodes, "s-sum");
        let decoded: BTreeMap<Identifier, round1::Package> = round1
            .iter()
            .map(|(id, pkg)| {
                (
                    decode_identifier(id).unwrap(),
                    postcard::from_bytes(&hex::decode(pkg).unwrap()).unwrap(),
                )
            })
            .collect();
        let expected = expected_public_package(&decoded).unwrap();

        let envelopes = round2_all(&nodes, "s-sum", &round1);
        let result = finalize(&nodes[3], "s-sum", &envelopes).unwrap();
        assert_eq!(
            result.public_package_hash,
            hex::encode(public_package_hash(&expected).unwrap())
        );
    }

    #[test]
    fn a_forged_share_is_rejected_and_the_recipient_saves_nothing() {
        let nodes = nodes();
        let round1 = round1_all(&nodes, "s-forge");
        let mut envelopes = round2_all(&nodes, "s-forge", &round1);

        // Participant 2 is malicious: it seals, CORRECTLY, a share that is not
        // the evaluation of the polynomial it committed to.
        let victim = nodes[0].context.identifier();
        let forger = &nodes[1];
        let forged = round2::Package::new({
            // A valid scalar (canonical, below the group order) that is not
            // f_2(1): well-formed, correctly encrypted, mathematically wrong.
            let mut bytes = [0u8; 32];
            bytes[0] = 42;
            frost::keys::SigningShare::deserialize(&bytes).unwrap()
        });
        let transcript: [u8; 32] = hex::decode(&envelopes[0].transcript_hash)
            .unwrap()
            .try_into()
            .unwrap();
        let replacement = seal_share(
            &forger.context,
            victim,
            "s-forge",
            KEY_REF,
            &transcript,
            &forged,
        )
        .unwrap();
        let slot = envelopes
            .iter()
            .position(|e| {
                e.sender == encode_identifier(&forger.context.identifier())
                    && e.recipient == encode_identifier(&victim)
            })
            .unwrap();
        envelopes[slot] = replacement;

        match finalize(&nodes[0], "s-forge", &envelopes) {
            Err(MpcError::BadRequest("dkg_invalid_share")) => {}
            Err(other) => panic!("wrong failure: {other:?}"),
            Ok(_) => panic!("a forged share was accepted"),
        }

        let session = nodes[0].store.load_dkg_session("s-forge").unwrap().unwrap();
        assert_eq!(session.phase, "aborted");
        assert!(
            session.sealed_secret.is_none(),
            "the aborted secret must be wiped"
        );
        assert!(nodes[0].store.load_share(KEY_REF).unwrap().is_none());
    }

    #[test]
    fn coordinator_equivocation_in_round_one_is_detected() {
        let nodes = nodes();
        let honest = round1_all(&nodes, "s-eq");

        // The coordinator shows participant 1 a DIFFERENT commitment for
        // participant 3 — one it generated itself — and everyone else the
        // real one.
        let mut forged_view = honest.clone();
        let (_, substitute) = frost::keys::dkg::part1(
            nodes[2].context.identifier(),
            MAX_SIGNERS,
            MIN_SIGNERS,
            OsRng,
        )
        .unwrap();
        forged_view.insert(
            encode_identifier(&nodes[2].context.identifier()),
            hex::encode(encode_postcard(&substitute).unwrap()),
        );

        let mut envelopes = Vec::new();
        for (index, node) in nodes.iter().enumerate() {
            let view = if index == 0 { &forged_view } else { &honest };
            // Participant 3's own view check would catch it too, but only for
            // the participant it is shown to; this is about everyone else.
            let response = node.participant().round2(&DkgRound2Request {
                session_id: "s-eq".into(),
                key_ref: KEY_REF.into(),
                round1_packages: view.clone(),
            });
            envelopes.extend(response.unwrap().envelopes);
        }

        // Participant 1 cannot open anything the others sealed, and they
        // cannot open what it sealed.
        assert!(matches!(
            finalize(&nodes[0], "s-eq", &envelopes),
            Err(MpcError::BadRequest("dkg_transcript_mismatch"))
        ));
        assert!(matches!(
            finalize(&nodes[1], "s-eq", &envelopes),
            Err(MpcError::BadRequest("dkg_transcript_mismatch"))
        ));
    }

    #[test]
    fn a_participant_refuses_a_set_that_substitutes_its_own_commitment() {
        let nodes = nodes();
        let mut round1 = round1_all(&nodes, "s-own");
        let (_, substitute) = frost::keys::dkg::part1(
            nodes[0].context.identifier(),
            MAX_SIGNERS,
            MIN_SIGNERS,
            OsRng,
        )
        .unwrap();
        round1.insert(
            encode_identifier(&nodes[0].context.identifier()),
            hex::encode(encode_postcard(&substitute).unwrap()),
        );
        assert!(matches!(
            nodes[0].participant().round2(&DkgRound2Request {
                session_id: "s-own".into(),
                key_ref: KEY_REF.into(),
                round1_packages: round1,
            }),
            Err(MpcError::BadRequest("dkg_own_commitment_substituted"))
        ));
    }

    #[test]
    fn the_coordinator_cannot_forge_an_envelope_under_a_participants_name() {
        let nodes = nodes();
        let round1 = round1_all(&nodes, "s-mitm");
        let mut envelopes = round2_all(&nodes, "s-mitm", &round1);

        // A coordinator with its own X25519 key, and even the honest transcript
        // hash, sealing an envelope that CLAIMS to be from participant 2. It can
        // pick any ephemeral key it likes; it cannot compute the static-static
        // term without participant 2's secret.
        let impostor_store = Store::in_memory().unwrap();
        let impostor = DkgIdentity::load_or_create(&impostor_store, &kek(99)).unwrap();
        let mut roster: BTreeMap<Identifier, [u8; 32]> = nodes
            .iter()
            .map(|n| (n.context.identifier(), n.context.identity().public_key()))
            .collect();
        roster.insert(nodes[1].context.identifier(), impostor.public_key());
        let coordinator_view = DkgContext::new(impostor, roster).unwrap();

        let victim = nodes[0].context.identifier();
        let transcript: [u8; 32] = hex::decode(&envelopes[0].transcript_hash)
            .unwrap()
            .try_into()
            .unwrap();
        let forged = seal_share(
            &coordinator_view,
            victim,
            "s-mitm",
            KEY_REF,
            &transcript,
            &round2::Package::new(frost::keys::SigningShare::deserialize(&[7u8; 32]).unwrap()),
        )
        .unwrap();
        let slot = envelopes
            .iter()
            .position(|e| e.sender == forged.sender && e.recipient == forged.recipient)
            .unwrap();
        envelopes[slot] = forged;

        assert!(matches!(
            finalize(&nodes[0], "s-mitm", &envelopes),
            Err(MpcError::BadRequest("dkg_envelope_rejected"))
        ));
        assert!(nodes[0].store.load_share(KEY_REF).unwrap().is_none());
    }

    #[test]
    fn an_envelope_from_another_session_does_not_open() {
        // Genuine envelopes from ceremony A, replayed into ceremony B between
        // the same participants for the same key. Both the session id and the
        // transcript are in the AEAD binding, so they must not open.
        let nodes = nodes();
        let round1_a = round1_all(&nodes, "s-a");
        let envelopes_a = round2_all(&nodes, "s-a", &round1_a);

        let round1_b = round1_all(&nodes, "s-b");
        let _ = round2_all(&nodes, "s-b", &round1_b);

        let replay = DkgFinalizeRequest {
            session_id: "s-b".into(),
            key_ref: KEY_REF.into(),
            envelopes: addressed_to(&envelopes_a, &nodes[0]),
        };
        assert!(nodes[0].participant().finalize(&replay).is_err());
        assert!(nodes[0].store.load_share(KEY_REF).unwrap().is_none());
    }

    #[test]
    fn a_new_ceremony_supersedes_an_abandoned_one_and_wipes_its_secret() {
        let nodes = nodes();
        let _ = round1_all(&nodes, "s-old");
        let _ = round1_all(&nodes, "s-new");

        let old = nodes[0].store.load_dkg_session("s-old").unwrap().unwrap();
        assert_eq!(old.phase, "aborted");
        assert!(old.sealed_secret.is_none());
    }

    #[test]
    fn round_one_is_refused_once_a_share_is_installed() {
        let nodes = nodes();
        ceremony(&nodes, "s-done");
        assert!(matches!(
            nodes[0].participant().round1(&DkgRound1Request {
                session_id: "s-again".into(),
                key_ref: KEY_REF.into(),
                min_signers: MIN_SIGNERS,
                max_signers: MAX_SIGNERS,
            }),
            Err(MpcError::BadRequest("share_already_installed"))
        ));
    }

    #[test]
    fn committing_requires_the_agreed_public_package_and_wipes_the_secret() {
        let nodes = nodes();
        let round1 = round1_all(&nodes, "s-c");
        let envelopes = round2_all(&nodes, "s-c", &round1);
        let result = finalize(&nodes[0], "s-c", &envelopes).unwrap();

        let wrong = nodes[0].participant().commit(&DkgCommitRequest {
            session_id: "s-c".into(),
            key_ref: KEY_REF.into(),
            public_package_hash: hex::encode([0u8; 32]),
        });
        assert!(matches!(
            wrong,
            Err(MpcError::BadRequest("dkg_public_package_mismatch"))
        ));
        assert!(nodes[0].store.load_share(KEY_REF).unwrap().is_none());

        let request = DkgCommitRequest {
            session_id: "s-c".into(),
            key_ref: KEY_REF.into(),
            public_package_hash: result.public_package_hash,
        };
        nodes[0].participant().commit(&request).unwrap();
        // Retried commit is a success, not a second install.
        nodes[0].participant().commit(&request).unwrap();

        let session = nodes[0].store.load_dkg_session("s-c").unwrap().unwrap();
        assert_eq!(session.phase, "committed");
        assert!(session.sealed_secret.is_none());
        assert!(nodes[0].store.load_share(KEY_REF).unwrap().is_some());
    }

    #[test]
    fn a_replayed_round_cannot_run_twice() {
        let nodes = nodes();
        let round1 = round1_all(&nodes, "s-r");
        let request = DkgRound2Request {
            session_id: "s-r".into(),
            key_ref: KEY_REF.into(),
            round1_packages: round1,
        };
        nodes[0].participant().round2(&request).unwrap();
        assert!(matches!(
            nodes[0].participant().round2(&request),
            Err(MpcError::BadRequest("dkg_phase_mismatch"))
        ));
        // And the lost race did not abort the session that won it.
        let session = nodes[0].store.load_dkg_session("s-r").unwrap().unwrap();
        assert_eq!(session.phase, "round2");
    }

    #[test]
    fn a_retried_round_one_returns_the_same_commitment() {
        let nodes = nodes();
        let request = DkgRound1Request {
            session_id: "s-retry".into(),
            key_ref: KEY_REF.into(),
            min_signers: MIN_SIGNERS,
            max_signers: MAX_SIGNERS,
        };
        let first = nodes[0].participant().round1(&request).unwrap();
        let second = nodes[0].participant().round1(&request).unwrap();
        assert_eq!(first.package, second.package);
    }

    #[test]
    fn wrong_threshold_parameters_are_refused() {
        let nodes = nodes();
        assert!(nodes[0]
            .participant()
            .round1(&DkgRound1Request {
                session_id: "s-t".into(),
                key_ref: KEY_REF.into(),
                min_signers: 2,
                max_signers: MAX_SIGNERS,
            })
            .is_err());
    }

    #[test]
    fn the_transport_identity_persists_and_is_sealed() {
        let store = Store::in_memory().unwrap();
        let first = DkgIdentity::load_or_create(&store, &kek(1)).unwrap();
        let second = DkgIdentity::load_or_create(&store, &kek(1)).unwrap();
        assert_eq!(first.public_key(), second.public_key());

        // A different KEK cannot open it.
        assert!(DkgIdentity::load_or_create(&store, &kek(2)).is_err());
        // And Debug shows only the public half.
        assert!(!format!("{first:?}").contains(&hex::encode(first.secret.to_bytes())));
    }

    #[test]
    fn the_roster_must_be_complete_and_contain_this_participant() {
        let store = Store::in_memory().unwrap();
        let identity = || DkgIdentity::load_or_create(&store, &kek(1)).unwrap();
        let own = identity().public_key();

        let mut roster: BTreeMap<Identifier, [u8; 32]> = (1..=5u16)
            .map(|i| (Identifier::try_from(i).unwrap(), [i as u8; 32]))
            .collect();
        // Self absent.
        assert!(DkgContext::new(identity(), roster.clone()).is_err());

        roster.insert(Identifier::try_from(3u16).unwrap(), own);
        let context = DkgContext::new(identity(), roster.clone()).unwrap();
        assert_eq!(context.identifier(), Identifier::try_from(3u16).unwrap());

        // Duplicate key.
        let mut duplicated = roster.clone();
        duplicated.insert(Identifier::try_from(4u16).unwrap(), own);
        assert!(DkgContext::new(identity(), duplicated).is_err());

        // Wrong size.
        roster.remove(&Identifier::try_from(5u16).unwrap());
        assert!(DkgContext::new(identity(), roster).is_err());
    }

    #[test]
    fn peers_parse_from_configuration() {
        let id = encode_identifier(&Identifier::try_from(1u16).unwrap());
        let parsed = DkgContext::parse_peers(&format!("{id}={}", B64.encode([9u8; 32]))).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(DkgContext::parse_peers("nonsense").is_err());
        assert!(DkgContext::parse_peers(&format!("{id}={}", B64.encode([9u8; 16]))).is_err());
    }
}
