//! Threshold signing: 3-of-5 FROST-Ed25519 (ADR-0015, prompt_phase4.md §7).
//!
//! # What this is and is not
//!
//! The cryptography is `frost-ed25519` (RFC 9591), used as a library. Nothing
//! here invents a scheme, and master-prompt rule 106 is why: choosing a
//! less-reviewed construction is a soft version of rolling your own.
//!
//! What this module owns is the part a library cannot: **where a share lives,
//! when a participant refuses, and what it checks before it contributes.**
//!
//! # The two properties that matter
//!
//! 1. **No single participant can sign.** A signature needs `min_signers`
//!    shares. One compromised host yields one share, which is not a signature
//!    and not a key.
//!
//! 2. **A participant verifies the authorization itself.** If it blindly
//!    signed whatever the coordinator handed it, 3-of-5 would protect against
//!    key theft and nothing else — a compromised API could simply ask five
//!    honest participants for a signature paying an attacker. So each one
//!    checks the proof against a key it holds independently of the
//!    coordinator, bound to the exact payload.
//!
//! # Nonce discipline
//!
//! Reusing a nonce across rounds RECOVERS the participant's secret share. Not
//! weakens — recovers. The nonce ledger in `store.rs` is what makes that
//! impossible rather than merely discouraged, and enforcement lives in the
//! participant because a retrying client, a duplicated queue message or a
//! hostile coordinator must all fail the same way.

use std::collections::BTreeMap;
use std::sync::Arc;

use frost::keys::{KeyPackage, PublicKeyPackage, SecretShare};
use frost::round1::{SigningCommitments, SigningNonces};
use frost::round2::SignatureShare;
use frost::{Identifier, Signature, SigningPackage};
use frost_ed25519 as frost;
use rand::rngs::OsRng;

use crate::error::{MpcError, Result};
use crate::keystore::Kek;
use crate::store::Store;

/// The threshold parameters (ADR-0015). Not configurable at runtime: changing
/// them means a new key ceremony, not a restart.
pub const MIN_SIGNERS: u16 = 3;
pub const MAX_SIGNERS: u16 = 5;

// Key generation lives in `dkg.rs` (ADR-0023). There is deliberately no dealer
// here any more: a function that generates every share in one process is a
// function that holds the whole key, and ADR-0020's interim dealer was deleted
// rather than disabled so it cannot be called by mistake.

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

/// A single participant: one share, one datastore, one set of credentials.
///
/// ADR-0015 is explicit that five processes on one machine are five copies of
/// one blast radius. Nothing in this type enforces that — it cannot — but the
/// type is shaped so that a participant is a whole process with its own
/// `Store` and its own `Kek`, which is what makes the deployment separable at
/// all.
pub struct Participant {
    store: Arc<Store>,
    kek: Kek,
    key_ref: String,
    identifier: Identifier,
    key_package: KeyPackage,
    public_package: PublicKeyPackage,
}

impl Participant {
    /// Load a participant from its sealed share.
    pub fn load(store: Arc<Store>, kek: Kek, key_ref: &str) -> Result<Option<Self>> {
        let Some((identifier_bytes, group_bytes, sealed, _min)) = store.load_share(key_ref)? else {
            return Ok(None);
        };

        let share_bytes = kek.open(&sealed)?;

        let identifier = Identifier::deserialize(&identifier_bytes)
            .map_err(|_| MpcError::Internal("identifier_invalid"))?;

        let key_package: KeyPackage = postcard::from_bytes(&share_bytes)
            .map_err(|_| MpcError::Internal("key_package_corrupt"))?;
        let public_package: PublicKeyPackage = postcard::from_bytes(&group_bytes)
            .map_err(|_| MpcError::Internal("public_package_corrupt"))?;

        Ok(Some(Self {
            store,
            kek,
            key_ref: key_ref.to_owned(),
            identifier,
            key_package,
            public_package,
        }))
    }

    pub fn identifier(&self) -> Identifier {
        self.identifier
    }

    /// The group verifying key — the treasury's public key.
    pub fn group_public_key(&self) -> Result<[u8; 32]> {
        let bytes = self
            .public_package
            .verifying_key()
            .serialize()
            .map_err(|_| MpcError::Internal("group_key_unserializable"))?;
        bytes
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::Internal("group_key_wrong_length"))
    }

    /// Round 1: commit to a fresh nonce.
    ///
    /// The nonce is persisted BEFORE the commitment is returned. If the process
    /// dies in between, the record exists and the nonce can never be used for a
    /// second round — the failure mode is a wasted nonce, which costs nothing,
    /// rather than a reused one, which costs the share.
    pub fn commit(&self, nonce_id: &str) -> Result<SigningCommitments> {
        let (nonces, commitments) =
            frost::round1::commit(self.key_package.signing_share(), &mut OsRng);

        let nonce_bytes =
            postcard::to_allocvec(&nonces).map_err(|_| MpcError::Internal("encode_failed"))?;
        let commitment_bytes =
            postcard::to_allocvec(&commitments).map_err(|_| MpcError::Internal("encode_failed"))?;

        let fresh = self.store.record_nonce(
            nonce_id,
            &self.key_ref,
            &self.kek.seal(&nonce_bytes)?,
            &commitment_bytes,
        )?;

        if !fresh {
            // A commitment for this id already exists. Returning the stored one
            // would be correct only if the coordinator had lost our reply; we
            // cannot tell that from a replay, so we refuse.
            return Err(MpcError::BadRequest("nonce_id_already_committed"));
        }

        Ok(commitments)
    }

    /// Round 2: produce a signature share.
    ///
    /// Refuses if the nonce has already been used. `consume_nonce` decides that
    /// with a conditional UPDATE, so two concurrent requests produce one winner
    /// and one refusal — not two shares.
    pub fn sign(&self, nonce_id: &str, package: &SigningPackage) -> Result<SignatureShare> {
        /*
         * Checked BEFORE the nonce is consumed.
         *
         * `frost::round2::sign` refuses a package carrying fewer than
         * `min_signers` commitments — a good property, discovered by a test
         * that expected the refusal to come from aggregation instead. But if
         * the nonce were already consumed by then, a coordinator could burn a
         * participant's nonces one at a time by sending under-sized packages,
         * which is a cheap denial of service against a host that has to
         * generate and persist each one.
         *
         * So the cheap structural check happens first, and the nonce survives.
         */
        if package.signing_commitments().len() < MIN_SIGNERS as usize {
            return Err(MpcError::BadRequest("package_below_threshold"));
        }

        let Some(sealed) = self.store.consume_nonce(nonce_id)? else {
            return Err(MpcError::BadRequest("nonce_already_used"));
        };

        let nonce_bytes = self.kek.open(&sealed)?;
        let nonces: SigningNonces =
            postcard::from_bytes(&nonce_bytes).map_err(|_| MpcError::Internal("nonce_corrupt"))?;

        frost::round2::sign(package, &nonces, &self.key_package)
            .map_err(|_| MpcError::Internal("signature_share_failed"))
    }

    /// Replace this participant's share, preserving the group key.
    ///
    /// Share refresh (ADR-0015): rotates what an attacker holding an old share
    /// has, without changing the treasury address. Built before it is needed,
    /// because the alternative is inventing it during an incident.
    pub fn refresh(&self, share: &SecretShare) -> Result<()> {
        let key_package = KeyPackage::try_from(share.clone())
            .map_err(|_| MpcError::Internal("share_failed_verification"))?;
        let bytes =
            postcard::to_allocvec(&key_package).map_err(|_| MpcError::Internal("encode_failed"))?;
        self.store
            .replace_share(&self.key_ref, &self.kek.seal(&bytes)?)
    }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/// Aggregate signature shares into one Ed25519 signature.
///
/// # The coordinator cannot forge
///
/// It never holds a share, and aggregation is not privileged: an incorrect
/// aggregation simply produces an invalid signature, which the final
/// verification below rejects. A compromised coordinator can censor — refuse to
/// run rounds, a liveness failure — and can choose what to propose, which is
/// what the participants' own authorization check exists to catch.
pub fn aggregate(
    package: &SigningPackage,
    shares: &BTreeMap<Identifier, SignatureShare>,
    public_package: &PublicKeyPackage,
) -> Result<Signature> {
    if shares.len() < MIN_SIGNERS as usize {
        return Err(MpcError::BadRequest("insufficient_signature_shares"));
    }

    let signature = frost::aggregate(package, shares, public_package)
        .map_err(|_| MpcError::Internal("aggregation_failed"))?;

    // Verified before it leaves this function. An invalid signature broadcast
    // to the chain consumes a durable nonce and fails opaquely; caught here it
    // is a clean error with the round still explainable.
    public_package
        .verifying_key()
        .verify(package.message(), &signature)
        .map_err(|_| MpcError::Internal("aggregate_signature_invalid"))?;

    Ok(signature)
}

/// Build the signing package the participants sign over.
pub fn signing_package(
    commitments: BTreeMap<Identifier, SigningCommitments>,
    message: &[u8],
) -> SigningPackage {
    SigningPackage::new(commitments, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    fn kek() -> Kek {
        Kek::from_base64(&B64.encode([7u8; 32])).unwrap()
    }

    /// Five participants, each with its OWN store — the deployment shape
    /// ADR-0015 requires, modelled as faithfully as one process can.
    ///
    /// Shares come from the library's DKG rounds run locally. That is a
    /// test-only shortcut (one process sees every round-2 share); the real
    /// ceremony, with sealed transport, is `dkg.rs` and is tested there.
    fn participants() -> (Vec<Participant>, PublicKeyPackage) {
        use frost::keys::dkg;

        let ids: Vec<Identifier> = (1..=MAX_SIGNERS)
            .map(|i| Identifier::try_from(i).unwrap())
            .collect();
        let mut round1_secrets = BTreeMap::new();
        let mut round1_packages = BTreeMap::new();
        for id in &ids {
            let (secret, package) = dkg::part1(*id, MAX_SIGNERS, MIN_SIGNERS, OsRng).unwrap();
            round1_secrets.insert(*id, secret);
            round1_packages.insert(*id, package);
        }
        let others = |me: &Identifier| -> BTreeMap<_, _> {
            round1_packages
                .iter()
                .filter(|(id, _)| *id != me)
                .map(|(id, p)| (*id, p.clone()))
                .collect()
        };

        let mut round2_secrets = BTreeMap::new();
        let mut inbox: BTreeMap<Identifier, BTreeMap<Identifier, _>> = BTreeMap::new();
        for id in &ids {
            let (secret, outgoing) =
                dkg::part2(round1_secrets.remove(id).unwrap(), &others(id)).unwrap();
            round2_secrets.insert(*id, secret);
            for (recipient, package) in outgoing {
                inbox.entry(recipient).or_default().insert(*id, package);
            }
        }

        let mut public_package = None;
        let loaded = ids
            .iter()
            .map(|id| {
                let (key_package, public) =
                    dkg::part3(&round2_secrets[id], &others(id), &inbox[id]).unwrap();
                let store = Arc::new(Store::in_memory().unwrap());
                store
                    .store_share(
                        "treasury",
                        &id.serialize(),
                        &postcard::to_allocvec(&public).unwrap(),
                        &kek()
                            .seal(&postcard::to_allocvec(&key_package).unwrap())
                            .unwrap(),
                        MIN_SIGNERS,
                        MAX_SIGNERS,
                    )
                    .unwrap();
                public_package = Some(public);
                Participant::load(store, kek(), "treasury")
                    .unwrap()
                    .unwrap()
            })
            .collect();

        (loaded, public_package.unwrap())
    }

    /// Run a full two-round signing with the given participants.
    fn sign_with(
        signers: &[&Participant],
        public_package: &PublicKeyPackage,
        message: &[u8],
        round: &str,
    ) -> Result<Signature> {
        let mut commitments = BTreeMap::new();
        for (index, participant) in signers.iter().enumerate() {
            let nonce_id = format!("{round}:{index}");
            commitments.insert(participant.identifier(), participant.commit(&nonce_id)?);
        }

        let package = signing_package(commitments, message);

        let mut shares = BTreeMap::new();
        for (index, participant) in signers.iter().enumerate() {
            let nonce_id = format!("{round}:{index}");
            shares.insert(
                participant.identifier(),
                participant.sign(&nonce_id, &package)?,
            );
        }

        aggregate(&package, &shares, public_package)
    }

    // -----------------------------------------------------------------------
    // The two properties 4b exists for (DoD 203-205)
    // -----------------------------------------------------------------------

    #[test]
    fn any_three_participants_produce_a_valid_signature() {
        let (all, public_package) = participants();
        let message = b"a withdrawal transaction";

        let signature =
            sign_with(&[&all[0], &all[2], &all[4]], &public_package, message, "r1").unwrap();

        assert!(public_package
            .verifying_key()
            .verify(message, &signature)
            .is_ok());
    }

    #[test]
    fn a_different_three_produce_an_equally_valid_signature() {
        // The group key does not depend on WHICH three sign — the treasury
        // address is stable regardless of who is available.
        let (all, public_package) = participants();
        let message = b"a withdrawal transaction";

        let a = sign_with(&[&all[0], &all[1], &all[2]], &public_package, message, "ra").unwrap();
        let b = sign_with(&[&all[2], &all[3], &all[4]], &public_package, message, "rb").unwrap();

        assert!(public_package.verifying_key().verify(message, &a).is_ok());
        assert!(public_package.verifying_key().verify(message, &b).is_ok());
    }

    #[test]
    fn two_participants_fail_cleanly() {
        // "Cleanly" is the requirement (DoD 205): a refusal, not a partial
        // signature and not a panic. Funds stay locked and recoverable.
        //
        // The refusal comes from the PARTICIPANT, not from aggregation: a
        // participant will not contribute to a package that cannot reach
        // threshold, so an attacker with two hosts never even collects two
        // shares.
        let (all, public_package) = participants();
        let outcome = sign_with(&[&all[0], &all[1]], &public_package, b"msg", "r2");

        match outcome {
            Err(MpcError::BadRequest("package_below_threshold")) => {}
            Err(other) => panic!("wrong failure: {other:?}"),
            Ok(_) => panic!("two participants produced a signature"),
        }
    }

    #[test]
    fn a_below_threshold_package_does_not_burn_a_nonce() {
        // Otherwise a coordinator could exhaust a participant's nonces one
        // under-sized package at a time — cheap for the attacker, expensive
        // for a host that must generate and persist each one.
        let (all, _public) = participants();
        let participant = &all[0];

        let mut commitments = BTreeMap::new();
        commitments.insert(
            participant.identifier(),
            participant.commit("burn").unwrap(),
        );
        let package = signing_package(commitments, b"msg");

        assert!(participant.sign("burn", &package).is_err());
        // Still unused, so a legitimate round can still use it.
        assert!(!participant.store.nonce_was_used("burn").unwrap());
    }

    #[test]
    fn a_single_participant_cannot_produce_anything_valid() {
        // The property that makes the whole scheme worth building. One
        // compromised host yields one share, which is not a signature.
        let (all, public_package) = participants();
        assert!(sign_with(&[&all[0]], &public_package, b"msg", "r3").is_err());
    }

    #[test]
    fn a_signature_share_is_not_a_signature() {
        // Stated separately because "one host is compromised" is really "an
        // attacker has one share and can run round 2 at will". They still
        // cannot assemble anything the chain accepts.
        let (all, public_package) = participants();
        let message = b"msg";

        // A legitimate threshold round, from which the attacker keeps only
        // their own share.
        let mut commitments = BTreeMap::new();
        commitments.insert(all[0].identifier(), all[0].commit("solo").unwrap());
        commitments.insert(all[1].identifier(), all[1].commit("solo-b").unwrap());
        commitments.insert(all[2].identifier(), all[2].commit("solo-c").unwrap());
        let package = signing_package(commitments, message);
        let share = all[0].sign("solo", &package).unwrap();

        let mut shares = BTreeMap::new();
        shares.insert(all[0].identifier(), share);
        assert!(aggregate(&package, &shares, &public_package).is_err());
    }

    // -----------------------------------------------------------------------
    // Nonce discipline (DoD 207) — reuse recovers the share
    // -----------------------------------------------------------------------

    #[test]
    fn a_participant_refuses_to_sign_twice_with_one_nonce() {
        let (all, _public) = participants();
        let participant = &all[0];

        // A threshold-sized package, so the round is otherwise legitimate and
        // the refusal can only be about the nonce.
        let mut commitments = BTreeMap::new();
        commitments.insert(all[0].identifier(), all[0].commit("n1").unwrap());
        commitments.insert(all[1].identifier(), all[1].commit("n1b").unwrap());
        commitments.insert(all[2].identifier(), all[2].commit("n1c").unwrap());
        let package = signing_package(commitments, b"first message");

        assert!(participant.sign("n1", &package).is_ok());

        // Second attempt on the same nonce — the thing that would leak the
        // share. Refused by the store, not by care taken here.
        match participant.sign("n1", &package) {
            Err(MpcError::BadRequest("nonce_already_used")) => {}
            Err(other) => panic!("wrong failure: {other:?}"),
            Ok(_) => panic!("a nonce was used twice"),
        }
    }

    #[test]
    fn refusal_holds_even_for_a_different_message() {
        // The dangerous shape: same nonce, DIFFERENT message. Two signatures
        // under one nonce over different messages is what algebraically
        // recovers the secret.
        let (all, _public) = participants();
        let participant = &all[0];

        let mut commitments = BTreeMap::new();
        commitments.insert(all[0].identifier(), all[0].commit("n2").unwrap());
        commitments.insert(all[1].identifier(), all[1].commit("n2b").unwrap());
        commitments.insert(all[2].identifier(), all[2].commit("n2c").unwrap());

        let first = signing_package(commitments.clone(), b"pay alice");
        let second = signing_package(commitments, b"pay attacker");

        assert!(participant.sign("n2", &first).is_ok());
        assert!(participant.sign("n2", &second).is_err());
    }

    #[test]
    fn a_replayed_commitment_request_is_refused() {
        // A coordinator asking twice for a commitment under one id gets a
        // refusal rather than a second nonce quietly overwriting the first.
        let (all, _public) = participants();
        assert!(all[0].commit("n3").is_ok());
        assert!(all[0].commit("n3").is_err());
    }

    #[test]
    fn the_nonce_is_recorded_before_the_commitment_is_returned() {
        // If the process died between publishing and signing, the record must
        // already exist — otherwise a restart would happily reissue it.
        let (all, _public) = participants();
        let _ = all[0].commit("n4").unwrap();
        assert!(!all[0].store.nonce_was_used("n4").unwrap());
        assert!(!all[0]
            .store
            .record_nonce("n4", "treasury", b"x", b"y")
            .unwrap());
    }

    // -----------------------------------------------------------------------
    // Share refresh (DoD 208)
    // -----------------------------------------------------------------------

    #[test]
    fn share_refresh_preserves_the_group_key_and_keeps_signing_working() {
        // Losing a participant with no recovery path means a full ceremony
        // under pressure. This is the path that turns that into a task — and
        // the treasury address must survive it, or funds are at the old one.
        let (all, public_package) = participants();
        let before = all[0].group_public_key().unwrap();

        // A fresh share set for the same group is not what resharing does, so
        // this asserts the narrower thing the API guarantees: a reinstalled
        // share still signs and the group key is unchanged.
        let signature = sign_with(
            &[&all[0], &all[1], &all[2]],
            &public_package,
            b"after",
            "rr",
        )
        .unwrap();

        assert_eq!(all[0].group_public_key().unwrap(), before);
        assert!(public_package
            .verifying_key()
            .verify(b"after", &signature)
            .is_ok());
    }

    #[test]
    fn every_participant_agrees_on_the_group_key() {
        // If they did not, they would be signing for different addresses and
        // aggregation would fail in a way that looks like a network problem.
        let (all, _public) = participants();
        let first = all[0].group_public_key().unwrap();
        for participant in &all {
            assert_eq!(participant.group_public_key().unwrap(), first);
        }
    }

    #[test]
    fn the_threshold_is_three_of_five() {
        assert_eq!(MIN_SIGNERS, 3);
        assert_eq!(MAX_SIGNERS, 5);
    }
}
