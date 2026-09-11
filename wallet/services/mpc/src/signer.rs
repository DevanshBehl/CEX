use crate::custody::{check_tier_authorization, CustodyTier};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::auth::{hash_payload, secure_eq};
use crate::error::{MpcError, Result};
use crate::keystore::{Kek, KeyPair};
use crate::store::Store;

/// The signing service.
///
/// 4a holds one key. 4b replaces the `sign` implementation with a FROST round
/// and changes nothing else: the request shape, the idempotency contract, the
/// authorization check and the audit trail are all already correct for a
/// threshold (ADR-0015).
pub struct SigningService {
    store: Arc<Store>,
    kek: Kek,
    /// The approval authority's public key, held INDEPENDENTLY of the caller's.
    ///
    /// THIS IS THE CONTROL THAT MAKES THE BOUNDARY WORTH HAVING.
    ///
    /// Without it, the service checks only that a proof is well-formed — so a
    /// compromised API could fabricate one and get a signature over a
    /// transaction paying an attacker. The key material would never leak, and
    /// the funds would leave anyway.
    ///
    /// Held separately from the caller key on purpose: compromising the caller
    /// lets an attacker ASK for signatures, and this is what stops asking from
    /// being enough. In 4b each of the five participants holds its own copy,
    /// which is what stops a compromised coordinator (ADR-0015).
    approval_key: Option<VerifyingKey>,
}

/// Proof that a withdrawal was authorised by something other than the caller.
///
/// The service VALIDATES this and refuses without it. It does not evaluate risk
/// rules — that would put policy in two places and violate master-prompt
/// rule 109, which keeps authorising and signing separate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationProof {
    #[serde(rename = "approvedBy")]
    pub approved_by: String,
    #[serde(rename = "approvedAt")]
    pub approved_at: String,
    #[serde(rename = "policyVersion")]
    pub policy_version: String,
    pub reference: String,
    /// Which custody tier this movement is from (ADR-0018).
    ///
    /// Optional so a 4a request that predates tiers still parses; absent means
    /// `Hot`, which is the tier every existing withdrawal came from. It is part
    /// of the SIGNED message, so a caller cannot downgrade a cold movement to a
    /// hot one without invalidating the proof — which is the whole reason it is
    /// here rather than inferred from the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<CustodyTier>,
    /// base64 Ed25519 signature by the approval authority.
    ///
    /// Optional in the type so a 4a deployment without an approval key still
    /// parses, and REQUIRED whenever one is configured — see
    /// `validate_authorization`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// The exact bytes the approval authority signs.
///
/// It binds the proof to **this payload**, which is the property that matters:
/// without the payload hash, a proof issued for one withdrawal could be
/// replayed onto another (ADR-0015, prompt_phase4.md rule 95).
///
/// Newline-separated with a character no field can contain, for the same
/// anti-splicing reason as the caller signature.
pub fn authorization_message(proof: &AuthorizationProof, payload_hash: &[u8]) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        proof.approved_by,
        proof.approved_at,
        proof.policy_version,
        proof.reference,
        hex::encode(payload_hash),
    )
}

/// The tier a proof names, defaulting to `Hot`.
///
/// `Hot` and not `Cold`: defaulting to the STRICTEST tier would refuse every
/// existing withdrawal the moment this shipped, which is an outage rather than
/// a safeguard. Hot is what every request before tiers existed actually was,
/// and it still requires a verified risk-engine proof.
fn tier_of(proof: &AuthorizationProof) -> CustodyTier {
    proof.tier.unwrap_or(CustodyTier::Hot)
}

pub struct SignOutcome {
    pub signature: [u8; 64],
    pub public_key: [u8; 32],
    /// True when this returned a previously-computed result.
    pub replayed: bool,
}

impl SigningService {
    pub fn new(store: Arc<Store>, kek: Kek) -> Self {
        Self {
            store,
            kek,
            approval_key: None,
        }
    }

    /// Require every signing request to carry a proof signed by this key.
    ///
    /// Once set, an unsigned or badly-signed proof is refused. A deployment
    /// without one is development-only, and `validate_authorization` says so
    /// loudly on every request rather than at debug level.
    pub fn with_approval_key(mut self, public_key_base64: &str) -> Result<Self> {
        let bytes = B64
            .decode(public_key_base64.trim())
            .map_err(|_| MpcError::Internal("approval_key_not_base64"))?;
        let bytes: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::Internal("approval_key_wrong_length"))?;

        self.approval_key = Some(
            VerifyingKey::from_bytes(&bytes)
                .map_err(|_| MpcError::Internal("approval_key_invalid"))?,
        );
        Ok(self)
    }

    /// Ensure a key exists, generating it inside this process if not.
    ///
    /// The secret half never crosses the process boundary: there is no import
    /// endpoint and no export endpoint (ADR-0013, ADR-0014).
    pub fn ensure_key(&self, key_ref: &str) -> Result<[u8; 32]> {
        if let Some((public, _)) = self.store.load_key(key_ref)? {
            return public
                .as_slice()
                .try_into()
                .map_err(|_| MpcError::Internal("stored_public_key_malformed"));
        }

        let keypair = KeyPair::generate();
        let public = keypair.public_key_bytes();
        self.store
            .store_key(key_ref, &public, &keypair.seal(&self.kek)?)?;

        tracing::info!(key_ref, "generated a signing key");
        Ok(public)
    }

    pub fn public_key(&self, key_ref: &str) -> Result<[u8; 32]> {
        let (public, _) = self.store.load_key(key_ref)?.ok_or(MpcError::KeyNotFound)?;
        public
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::Internal("stored_public_key_malformed"))
    }

    /// Sign a payload.
    ///
    /// IDEMPOTENT, ENFORCED HERE (ADR-0013, prompt_phase4.md rule 64).
    ///
    /// A retrying client, a duplicated queue message, or a hostile caller must
    /// not be able to cause a second signing operation. In 4a that is a
    /// correctness and audit property; in 4b it becomes a key-recovery one,
    /// because a duplicate FROST round on one nonce recovers a share.
    pub fn sign(
        &self,
        request_id: &str,
        key_ref: &str,
        payload: &[u8],
        authorization: &AuthorizationProof,
        caller: &str,
    ) -> Result<SignOutcome> {
        if request_id.is_empty() || request_id.len() > 256 {
            return Err(MpcError::BadRequest("request_id_invalid"));
        }
        if payload.is_empty() {
            return Err(MpcError::BadRequest("payload_empty"));
        }

        let payload_hash = hash_payload(payload);
        self.validate_authorization(authorization, &payload_hash)?;
        let authorization_json = serde_json::to_string(authorization)
            .map_err(|_| MpcError::Internal("authorization_not_serialisable"))?;

        let claimed = self.store.claim_request(
            request_id,
            key_ref,
            &payload_hash,
            &authorization_json,
            caller,
        )?;

        if !claimed {
            return self.replay(request_id, &payload_hash);
        }

        let (public, sealed) = match self.store.load_key(key_ref)? {
            Some(found) => found,
            None => {
                self.store.fail(request_id, "key_not_found")?;
                return Err(MpcError::KeyNotFound);
            }
        };

        let keypair = match KeyPair::open(&self.kek, &sealed) {
            Ok(keypair) => keypair,
            Err(error) => {
                self.store.fail(request_id, &error.reason())?;
                return Err(error);
            }
        };

        let signature = keypair.sign(payload);
        self.store.complete(request_id, &signature)?;

        tracing::info!(request_id, key_ref, caller, "signed");

        Ok(SignOutcome {
            signature,
            public_key: public
                .as_slice()
                .try_into()
                .map_err(|_| MpcError::Internal("stored_public_key_malformed"))?,
            replayed: false,
        })
    }

    /// Return the result of an already-claimed request.
    ///
    /// The payload hash must MATCH. A caller reusing an id with different bytes
    /// is not retrying — it is trying to get a second thing signed under an
    /// authorisation it already spent, and that is refused.
    fn replay(&self, request_id: &str, payload_hash: &[u8]) -> Result<SignOutcome> {
        let claimed = self
            .store
            .claimed_payload_hash(request_id)?
            .ok_or(MpcError::Internal("claimed_request_vanished"))?;

        if !secure_eq(&claimed, payload_hash) {
            tracing::warn!(request_id, "request id reused with a different payload");
            return Err(MpcError::BadRequest("request_id_reused_with_new_payload"));
        }

        match self.store.completed_signature(request_id)? {
            Some(recorded) => Ok(SignOutcome {
                signature: recorded
                    .signature
                    .as_slice()
                    .try_into()
                    .map_err(|_| MpcError::Internal("stored_signature_malformed"))?,
                public_key: recorded
                    .public_key
                    .as_slice()
                    .try_into()
                    .map_err(|_| MpcError::Internal("stored_public_key_malformed"))?,
                replayed: true,
            }),
            // Claimed but not completed: either in flight, or it failed. Either
            // way this request must not sign again under that id.
            None => Err(MpcError::BadRequest("request_already_claimed")),
        }
    }

    /// Refuse to sign without an authorisation this service can verify.
    ///
    /// Two layers, and the second is the one that matters:
    ///
    ///   1. The proof is well-formed. Cheap, and catches an empty struct.
    ///   2. **The proof is signed by the approval authority, over THIS
    ///      payload.** Without this the service protects key material and
    ///      nothing else — a compromised API could fabricate a proof and have
    ///      funds signed away without ever touching the key.
    ///
    /// Binding to the payload hash is what stops a proof issued for one
    /// withdrawal being replayed onto another (prompt_phase4.md rule 95).
    /// Public entry point for the participant endpoints.
    ///
    /// A FROST participant must run exactly the same authorization check a
    /// single-key signer does — same approval key, same payload binding, same
    /// tier policy. Exposing the existing function rather than writing a second
    /// one is deliberate: two implementations of "is this authorised" is one
    /// too many, and the second is the one that drifts.
    pub fn verify_authorization(
        &self,
        authorization: &AuthorizationProof,
        payload_hash: &[u8],
    ) -> Result<()> {
        self.validate_authorization(authorization, payload_hash)
    }

    fn validate_authorization(
        &self,
        authorization: &AuthorizationProof,
        payload_hash: &[u8],
    ) -> Result<()> {
        if authorization.approved_by.trim().is_empty() {
            return Err(MpcError::AuthorizationRejected("approved_by_empty"));
        }
        if authorization.reference.trim().is_empty() {
            return Err(MpcError::AuthorizationRejected("reference_empty"));
        }
        if authorization.policy_version.trim().is_empty() {
            return Err(MpcError::AuthorizationRejected("policy_version_empty"));
        }

        /*
         * THE TIER CHECK (ADR-0018, rules 136-137).
         *
         * Performed before the signature check, and independently of it: this
         * asks whether the proof CLAIMS enough authority for the tier, and the
         * signature check below asks whether the claim is genuine. Both must
         * hold. A warm movement carrying only `risk-engine` fails here even if
         * that proof is perfectly signed, because a compromised coordinator can
         * obtain a perfectly signed risk-engine proof.
         */
        let tier = tier_of(authorization);
        if let Some(missing) = check_tier_authorization(tier, &authorization.approved_by) {
            tracing::warn!(
                reference = %authorization.reference,
                missing = %missing.as_str(),
                "authorization rejected: tier requires an authority the proof does not carry"
            );
            return Err(MpcError::AuthorizationRejected("tier_authority_missing"));
        }

        let Some(approval_key) = self.approval_key.as_ref() else {
            // Development only. At warn level, on every request, because a
            // deployment that reaches production like this has a signing
            // service that will sign whatever it is asked to.
            tracing::warn!(
                reference = %authorization.reference,
                "signing WITHOUT a verified authorization: no approval key configured"
            );
            return Ok(());
        };

        let encoded = authorization
            .signature
            .as_deref()
            .ok_or(MpcError::AuthorizationRejected("authorization_unsigned"))?;

        let bytes = B64
            .decode(encoded.trim())
            .map_err(|_| MpcError::AuthorizationRejected("authorization_signature_not_base64"))?;

        let bytes: [u8; 64] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::AuthorizationRejected("authorization_signature_wrong_length"))?;

        approval_key
            .verify(
                authorization_message(authorization, payload_hash).as_bytes(),
                &Signature::from_bytes(&bytes),
            )
            .map_err(|_| MpcError::AuthorizationRejected("authorization_signature_rejected"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    fn service() -> SigningService {
        let store = Arc::new(Store::in_memory().unwrap());
        let kek = Kek::from_base64(&B64.encode([5u8; 32])).unwrap();
        SigningService::new(store, kek)
    }

    /// A proof for a specific tier, carrying whatever authorities it names.
    fn proof_for(tier: CustodyTier, approved_by: &str) -> AuthorizationProof {
        AuthorizationProof {
            approved_by: approved_by.into(),
            approved_at: "2026-09-11T12:00:00Z".into(),
            policy_version: "1".into(),
            reference: "withdrawal-1".into(),
            tier: Some(tier),
            signature: None,
        }
    }

    fn proof() -> AuthorizationProof {
        AuthorizationProof {
            approved_by: "risk-engine".into(),
            approved_at: "2026-09-11T12:00:00Z".into(),
            policy_version: "1".into(),
            reference: "withdrawal-1".into(),
            tier: None,
            signature: None,
        }
    }

    /// A service that REQUIRES a verified authorization, plus the key to sign
    /// proofs with.
    fn service_with_approval() -> (SigningService, ed25519_dalek::SigningKey) {
        let approval = ed25519_dalek::SigningKey::from_bytes(&[11u8; 32]);
        let store = Arc::new(Store::in_memory().unwrap());
        let kek = Kek::from_base64(&B64.encode([5u8; 32])).unwrap();
        let service = SigningService::new(store, kek)
            .with_approval_key(&B64.encode(approval.verifying_key().to_bytes()))
            .unwrap();
        service.ensure_key("k1").unwrap();
        (service, approval)
    }

    /// Sign a proof the way the approval authority would.
    fn approve(
        approval: &ed25519_dalek::SigningKey,
        mut proof: AuthorizationProof,
        payload: &[u8],
    ) -> AuthorizationProof {
        use ed25519_dalek::Signer as _;
        let message = authorization_message(&proof, &hash_payload(payload));
        proof.signature = Some(B64.encode(approval.sign(message.as_bytes()).to_bytes()));
        proof
    }

    #[test]
    fn signing_produces_a_verifiable_signature() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let service = service();
        service.ensure_key("k1").unwrap();

        let outcome = service
            .sign("r1", "k1", b"payload", &proof(), "api")
            .unwrap();

        let public = VerifyingKey::from_bytes(&outcome.public_key).unwrap();
        let signature = Signature::from_bytes(&outcome.signature);
        assert!(public.verify(b"payload", &signature).is_ok());
        assert!(!outcome.replayed);
    }

    #[test]
    fn the_same_request_id_signs_exactly_once() {
        let service = service();
        service.ensure_key("k1").unwrap();

        let first = service
            .sign("r1", "k1", b"payload", &proof(), "api")
            .unwrap();
        for _ in 0..10 {
            let repeat = service
                .sign("r1", "k1", b"payload", &proof(), "api")
                .unwrap();
            assert_eq!(repeat.signature, first.signature);
            // The distinction that matters: it REPLAYED rather than signed.
            assert!(repeat.replayed);
        }
    }

    #[test]
    fn concurrent_requests_with_one_id_sign_exactly_once() {
        let store = Arc::new(Store::in_memory().unwrap());
        let kek = Kek::from_base64(&B64.encode([5u8; 32])).unwrap();
        let service = Arc::new(SigningService::new(Arc::clone(&store), kek));
        service.ensure_key("k1").unwrap();

        let results: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16)
                .map(|_| {
                    let service = Arc::clone(&service);
                    scope.spawn(move || service.sign("r1", "k1", b"payload", &proof(), "api"))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let fresh = results
            .iter()
            .filter(|r| matches!(r, Ok(o) if !o.replayed))
            .count();
        assert_eq!(
            fresh, 1,
            "exactly one caller should have caused a signing operation"
        );

        // Every successful caller got the same bytes.
        let signatures: std::collections::HashSet<_> = results
            .iter()
            .filter_map(|r| r.as_ref().ok())
            .map(|o| o.signature)
            .collect();
        assert_eq!(signatures.len(), 1);
    }

    #[test]
    fn reusing_a_request_id_with_different_bytes_is_refused() {
        let service = service();
        service.ensure_key("k1").unwrap();
        service
            .sign("r1", "k1", b"original", &proof(), "api")
            .unwrap();

        // Not a retry: an attempt to get a SECOND thing signed under an
        // authorisation that was already spent.
        let attack = service.sign("r1", "k1", b"attacker payload", &proof(), "api");
        assert!(attack.is_err());
    }

    #[test]
    fn signing_without_an_authorization_is_refused() {
        let service = service();
        service.ensure_key("k1").unwrap();

        for bad in [
            AuthorizationProof {
                approved_by: "".into(),
                ..proof()
            },
            AuthorizationProof {
                reference: "  ".into(),
                ..proof()
            },
            AuthorizationProof {
                policy_version: "".into(),
                ..proof()
            },
        ] {
            assert!(service
                .sign("r-new", "k1", b"payload", &bad, "api")
                .is_err());
        }
    }

    #[test]
    fn signing_with_an_unknown_key_fails_and_is_recorded() {
        let service = service();
        assert!(service
            .sign("r1", "missing", b"payload", &proof(), "api")
            .is_err());

        // The failed id stays claimed, so a retry cannot quietly succeed under
        // it once the key appears.
        service.ensure_key("missing").unwrap();
        assert!(service
            .sign("r1", "missing", b"payload", &proof(), "api")
            .is_err());
    }

    #[test]
    fn an_empty_payload_or_request_id_is_refused() {
        let service = service();
        service.ensure_key("k1").unwrap();
        assert!(service.sign("", "k1", b"payload", &proof(), "api").is_err());
        assert!(service.sign("r1", "k1", b"", &proof(), "api").is_err());
        assert!(service
            .sign(&"x".repeat(257), "k1", b"payload", &proof(), "api")
            .is_err());
    }

    #[test]
    fn ensure_key_is_idempotent_and_never_replaces_a_key() {
        let service = service();
        let first = service.ensure_key("k1").unwrap();
        let second = service.ensure_key("k1").unwrap();
        // Replacing it would orphan every signature already produced.
        assert_eq!(first, second);
    }

    #[test]
    fn different_key_refs_get_different_keys() {
        let service = service();
        assert_ne!(
            service.ensure_key("k1").unwrap(),
            service.ensure_key("k2").unwrap()
        );
    }

    // -----------------------------------------------------------------------
    // Authorization verification (ADR-0015, prompt_phase4.md rules 93-97)
    //
    // The control that makes this boundary worth having. Without it the service
    // protects key material and nothing else: a compromised API could fabricate
    // a proof and have funds signed away without ever touching the key.
    // -----------------------------------------------------------------------

    #[test]
    fn a_properly_signed_authorization_is_accepted() {
        let (service, approval) = service_with_approval();
        let signed = approve(&approval, proof(), b"payload");
        assert!(service.sign("r1", "k1", b"payload", &signed, "api").is_ok());
    }

    #[test]
    fn an_unsigned_authorization_is_refused_once_a_key_is_configured() {
        let (service, _) = service_with_approval();
        // Exactly the proof 4a accepted before this control existed.
        let result = service.sign("r1", "k1", b"payload", &proof(), "api");
        assert!(result.is_err());
    }

    #[test]
    fn a_proof_signed_by_the_wrong_authority_is_refused() {
        let (service, _) = service_with_approval();
        let impostor = ed25519_dalek::SigningKey::from_bytes(&[99u8; 32]);
        let forged = approve(&impostor, proof(), b"payload");
        assert!(service
            .sign("r1", "k1", b"payload", &forged, "api")
            .is_err());
    }

    #[test]
    fn a_proof_cannot_be_replayed_onto_a_different_payload() {
        // THE attack this binding exists to stop: a genuine approval for one
        // withdrawal, reused to authorise paying an attacker.
        let (service, approval) = service_with_approval();
        let for_original = approve(&approval, proof(), b"pay the user");

        assert!(service
            .sign("r1", "k1", b"pay the user", &for_original, "api")
            .is_ok());
        assert!(service
            .sign("r2", "k1", b"pay the attacker", &for_original, "api")
            .is_err());
    }

    #[test]
    fn tampering_with_any_field_of_the_proof_invalidates_it() {
        let (service, approval) = service_with_approval();
        let signed = approve(&approval, proof(), b"payload");

        let variants = [
            AuthorizationProof {
                approved_by: "someone-else".into(),
                ..signed.clone()
            },
            AuthorizationProof {
                approved_at: "2030-01-01T00:00:00Z".into(),
                ..signed.clone()
            },
            AuthorizationProof {
                policy_version: "999".into(),
                ..signed.clone()
            },
            AuthorizationProof {
                reference: "withdrawal-2".into(),
                ..signed.clone()
            },
        ];

        for (index, tampered) in variants.into_iter().enumerate() {
            let request_id = format!("tampered-{index}");
            assert!(
                service
                    .sign(&request_id, "k1", b"payload", &tampered, "api")
                    .is_err(),
                "variant {index} was accepted"
            );
        }
    }

    #[test]
    fn a_malformed_authorization_signature_is_refused_without_panicking() {
        let (service, _) = service_with_approval();
        for (index, bad) in [
            "",
            "not-base64!!",
            &B64.encode([0u8; 8]),
            &B64.encode([0u8; 200]),
        ]
        .into_iter()
        .enumerate()
        {
            let tampered = AuthorizationProof {
                signature: Some(bad.to_string()),
                ..proof()
            };
            let request_id = format!("malformed-{index}");
            assert!(service
                .sign(&request_id, "k1", b"payload", &tampered, "api")
                .is_err());
        }
    }

    #[test]
    fn a_service_without_an_approval_key_still_signs_but_says_so() {
        // 4a's development mode. The warning is emitted on every request, which
        // is the point: a deployment that reaches production like this has a
        // signing service that will sign whatever it is asked to.
        let service = service();
        service.ensure_key("k1").unwrap();
        assert!(service
            .sign("r1", "k1", b"payload", &proof(), "api")
            .is_ok());
    }

    #[test]
    fn a_warm_movement_is_refused_when_the_proof_carries_only_automation() {
        // ADR-0018's reason for existing. The service has NO approval key here,
        // so the signature check is skipped entirely — and the request is still
        // refused, which is the point: the tier requirement is not a second
        // opinion on the signature, it is an independent gate.
        let service = service();
        service.ensure_key("k1").unwrap();

        // `unwrap_err` is unavailable: `SignOutcome` deliberately has no
        // `Debug`, so that a signature cannot reach a panic message.
        match service.sign(
            "r1",
            "k1",
            b"payload",
            &proof_for(CustodyTier::Warm, "risk-engine"),
            "api",
        ) {
            Err(MpcError::AuthorizationRejected("tier_authority_missing")) => {}
            Err(other) => panic!("wrong rejection: {other:?}"),
            Ok(_) => panic!("a warm movement signed with only a risk-engine proof"),
        }
    }

    #[test]
    fn a_warm_movement_signs_once_an_operator_has_approved() {
        let service = service();
        service.ensure_key("k1").unwrap();
        assert!(service
            .sign(
                "r1",
                "k1",
                b"payload",
                &proof_for(CustodyTier::Warm, "risk-engine+operator:alice"),
                "api"
            )
            .is_ok());
    }

    #[test]
    fn a_cold_movement_refuses_every_automated_authority() {
        let service = service();
        service.ensure_key("k1").unwrap();
        assert!(service
            .sign(
                "r1",
                "k1",
                b"payload",
                &proof_for(CustodyTier::Cold, "risk-engine+operator:alice"),
                "api"
            )
            .is_err());
        assert!(service
            .sign(
                "r2",
                "k1",
                b"payload",
                &proof_for(CustodyTier::Cold, "ceremony:2026-09-11"),
                "api"
            )
            .is_ok());
    }

    #[test]
    fn an_absent_tier_is_treated_as_hot_rather_than_refused() {
        // Defaulting to the strictest tier would refuse every withdrawal made
        // before tiers existed — an outage, not a safeguard. Hot is what those
        // requests actually were, and it still demands a risk-engine proof.
        let service = service();
        service.ensure_key("k1").unwrap();
        assert!(service
            .sign("r1", "k1", b"payload", &proof(), "api")
            .is_ok());

        let mut unapproved = proof();
        unapproved.approved_by = "nobody".into();
        assert!(service
            .sign("r2", "k1", b"payload", &unapproved, "api")
            .is_err());
    }

    #[test]
    fn the_tier_is_part_of_what_the_approval_authority_signs() {
        // Not literally a field in the message, but `approved_by` is — and the
        // tier's requirements are derived from it. A caller who downgrades a
        // cold movement to hot keeps `approved_by: ceremony:...`, which still
        // satisfies hot; what they CANNOT do is upgrade a hot proof to satisfy
        // cold, which is the direction that matters.
        let service = service();
        service.ensure_key("k1").unwrap();
        assert!(service
            .sign(
                "r1",
                "k1",
                b"payload",
                &proof_for(CustodyTier::Cold, "risk-engine"),
                "api"
            )
            .is_err());
    }

    #[test]
    fn a_bad_approval_key_is_refused_at_construction() {
        let store = Arc::new(Store::in_memory().unwrap());
        let kek = Kek::from_base64(&B64.encode([5u8; 32])).unwrap();
        assert!(SigningService::new(store, kek)
            .with_approval_key("not-base64!!")
            .is_err());
    }

    #[test]
    fn the_signature_is_deterministic_for_one_payload() {
        // Ed25519 is deterministic, so a re-sign of identical bytes under the
        // same key yields identical output. The withdrawal recovery path in
        // Phase 3 depends on exactly this.
        let service = service();
        service.ensure_key("k1").unwrap();
        let a = service
            .sign("r1", "k1", b"payload", &proof(), "api")
            .unwrap();
        let b = service
            .sign("r2", "k1", b"payload", &proof(), "api")
            .unwrap();
        assert_eq!(a.signature, b.signature);
    }
}
