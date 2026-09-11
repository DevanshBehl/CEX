use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::error::{MpcError, Result};

/// Caller authentication (ADR-0013).
///
/// Every request carries an Ed25519 signature over a canonical string built
/// from the request. The service holds only the caller's PUBLIC key, so a
/// compromise of this service does not yield the ability to impersonate the
/// caller — which matters in 4b, where five participants each hold one.
///
/// TLS protects the channel; this proves who is on the other end of it. They
/// are not alternatives: the transport can be terminated by a proxy, and then
/// the signature is the only thing that still says who called.
pub struct CallerVerifier {
    public_key: VerifyingKey,
    /// How far a timestamp may be from now. A window, because clocks differ.
    tolerance_seconds: i64,
}

/// The fields a signature covers.
///
/// The payload is covered by its HASH rather than its bytes, so the canonical
/// string stays bounded — and so nothing tempts a future maintainer to log it.
pub struct SignedRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub request_id: &'a str,
    pub payload_hash: &'a [u8],
    pub timestamp: i64,
}

impl CallerVerifier {
    pub fn new(public_key_base64: &str, tolerance_seconds: i64) -> Result<Self> {
        let bytes = B64
            .decode(public_key_base64.trim())
            .map_err(|_| MpcError::Internal("caller_key_not_base64"))?;

        let bytes: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::Internal("caller_key_wrong_length"))?;

        let public_key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| MpcError::Internal("caller_key_invalid"))?;

        Ok(Self {
            public_key,
            tolerance_seconds,
        })
    }

    /// Verify a request, or reject it with a reason for the audit log.
    ///
    /// Order matters: the timestamp is checked BEFORE the signature so a replay
    /// of a genuinely-signed old request is rejected on the cheap check, and so
    /// the reason recorded is the accurate one.
    pub fn verify(
        &self,
        request: &SignedRequest<'_>,
        signature_base64: &str,
        now: i64,
    ) -> Result<()> {
        let age = now - request.timestamp;
        if age.abs() > self.tolerance_seconds {
            return Err(MpcError::Unauthenticated("timestamp_outside_window"));
        }

        let signature_bytes = B64
            .decode(signature_base64.trim())
            .map_err(|_| MpcError::Unauthenticated("signature_not_base64"))?;

        let signature_bytes: [u8; 64] = signature_bytes
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::Unauthenticated("signature_wrong_length"))?;

        let signature = Signature::from_bytes(&signature_bytes);

        self.public_key
            .verify(canonical_string(request).as_bytes(), &signature)
            .map_err(|_| MpcError::Unauthenticated("signature_rejected"))
    }
}

/// The exact bytes a caller signs.
///
/// Field-separated with a character that cannot appear in any field, so
/// `("ab", "c")` and `("a", "bc")` cannot produce the same string. Without that
/// the scheme has a splicing weakness that is easy to miss and hard to notice.
pub fn canonical_string(request: &SignedRequest<'_>) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        request.method,
        request.path,
        request.request_id,
        hex::encode(request.payload_hash),
        request.timestamp,
    )
}

pub fn hash_payload(payload: &[u8]) -> Vec<u8> {
    Sha256::digest(payload).to_vec()
}

/// Constant-time comparison, for anything an attacker can submit repeatedly.
pub fn secure_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn caller() -> (SigningKey, CallerVerifier) {
        let signing = SigningKey::from_bytes(&[3u8; 32]);
        let verifier =
            CallerVerifier::new(&B64.encode(signing.verifying_key().to_bytes()), 60).unwrap();
        (signing, verifier)
    }

    fn request<'a>(request_id: &'a str, hash: &'a [u8], timestamp: i64) -> SignedRequest<'a> {
        SignedRequest {
            method: "POST",
            path: "/v1/sign",
            request_id,
            payload_hash: hash,
            timestamp,
        }
    }

    fn sign(signing: &SigningKey, request: &SignedRequest<'_>) -> String {
        B64.encode(
            signing
                .sign(canonical_string(request).as_bytes())
                .to_bytes(),
        )
    }

    #[test]
    fn a_correctly_signed_request_is_accepted() {
        let (signing, verifier) = caller();
        let hash = hash_payload(b"payload");
        let req = request("r1", &hash, 1000);
        assert!(verifier.verify(&req, &sign(&signing, &req), 1000).is_ok());
    }

    #[test]
    fn a_request_signed_by_the_wrong_key_is_rejected() {
        let (_, verifier) = caller();
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let hash = hash_payload(b"payload");
        let req = request("r1", &hash, 1000);
        assert!(verifier.verify(&req, &sign(&attacker, &req), 1000).is_err());
    }

    #[test]
    fn tampering_with_any_covered_field_invalidates_the_signature() {
        let (signing, verifier) = caller();
        let hash = hash_payload(b"payload");
        let original = request("r1", &hash, 1000);
        let signature = sign(&signing, &original);

        // A different request id — the attack that would let one authorised
        // signature be reused for a second signing operation.
        let swapped_id = request("r2", &hash, 1000);
        assert!(verifier.verify(&swapped_id, &signature, 1000).is_err());

        // Different payload bytes under the same id.
        let other_hash = hash_payload(b"different payload");
        let swapped_payload = request("r1", &other_hash, 1000);
        assert!(verifier.verify(&swapped_payload, &signature, 1000).is_err());

        // A different path.
        let mut swapped_path = request("r1", &hash, 1000);
        swapped_path.path = "/v1/public-key";
        assert!(verifier.verify(&swapped_path, &signature, 1000).is_err());
    }

    #[test]
    fn an_old_request_is_rejected_even_though_it_is_genuinely_signed() {
        let (signing, verifier) = caller();
        let hash = hash_payload(b"payload");
        let req = request("r1", &hash, 1000);
        let signature = sign(&signing, &req);

        assert!(verifier.verify(&req, &signature, 1000 + 61).is_err());
        // Clock skew in the other direction too.
        assert!(verifier.verify(&req, &signature, 1000 - 61).is_err());
        // Within tolerance is fine.
        assert!(verifier.verify(&req, &signature, 1000 + 59).is_ok());
    }

    #[test]
    fn a_malformed_signature_is_rejected_without_panicking() {
        let (_, verifier) = caller();
        let hash = hash_payload(b"payload");
        let req = request("r1", &hash, 1000);

        for bad in [
            "",
            "not-base64!!",
            &B64.encode([0u8; 8]),
            &B64.encode([0u8; 128]),
        ] {
            assert!(
                verifier.verify(&req, bad, 1000).is_err(),
                "accepted {bad:?}"
            );
        }
    }

    #[test]
    fn the_canonical_string_cannot_be_spliced() {
        // Without a separator absent from every field, these two would produce
        // the same signing input and one signature would cover both.
        let hash = hash_payload(b"x");
        let a = canonical_string(&request("ab", &hash, 1));
        let b = canonical_string(&request("a", &hash, 1));
        assert_ne!(a, b);
    }

    #[test]
    fn a_bad_caller_key_is_refused_at_construction() {
        assert!(CallerVerifier::new("not-base64!!", 60).is_err());
        assert!(CallerVerifier::new(&B64.encode([0u8; 16]), 60).is_err());
    }
}
