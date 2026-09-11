use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer as _, SigningKey, VerifyingKey};
use rand::RngCore;

use crate::error::{MpcError, Result};

/// Key material, and the only place in this system that holds any.
///
/// ADR-0014. Two properties this module exists to guarantee:
///
///   1. The secret half never leaves this process. There is no accessor that
///      returns it, no `Debug` that prints it, and no serialisation path.
///   2. At rest it is AES-256-GCM ciphertext under a key that lives in a secret
///      manager, never beside it. A database compromise yields ciphertext.
///
/// GCM rather than CBC because it is authenticated: a tampered ciphertext fails
/// loudly instead of decrypting to a *different key*, which for signing
/// material would be catastrophic and silent.
const NONCE_BYTES: usize = 12;
const KEK_BYTES: usize = 32;

/// The key-encryption key. Wrapped so it cannot be logged or serialised.
pub struct Kek(Aes256Gcm);

impl std::fmt::Debug for Kek {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the key. This impl exists so a struct containing a Kek
        // can derive Debug without leaking it.
        f.write_str("Kek(<redacted>)")
    }
}

impl Kek {
    /// Build from a base64-encoded 32-byte key.
    ///
    /// Fails at construction rather than at first use: a service that starts
    /// with a bad KEK and discovers it mid-signature is worse than one that
    /// does not start.
    pub fn from_base64(encoded: &str) -> Result<Self> {
        let bytes = B64
            .decode(encoded.trim())
            .map_err(|_| MpcError::Internal("kek_not_base64"))?;

        if bytes.len() != KEK_BYTES {
            return Err(MpcError::Internal("kek_wrong_length"));
        }

        Aes256Gcm::new_from_slice(&bytes)
            .map(Kek)
            .map_err(|_| MpcError::Internal("kek_rejected"))
    }

    /// Seal arbitrary bytes under this KEK.
    ///
    /// `pub` because 4b's key shares and signing nonces are sealed with the
    /// same primitive as a single key (ADR-0014) — a second encryption path
    /// for share material would be a second thing to get wrong.
    pub fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut nonce_bytes = [0u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .0
            .encrypt(nonce, plaintext)
            .map_err(|_| MpcError::Crypto("seal_failed"))?;

        // nonce || ciphertext+tag — self-describing, so no second column.
        let mut out = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    pub fn open(&self, sealed: &[u8]) -> Result<Vec<u8>> {
        if sealed.len() <= NONCE_BYTES {
            return Err(MpcError::Crypto("ciphertext_truncated"));
        }
        let (nonce_bytes, ciphertext) = sealed.split_at(NONCE_BYTES);

        self.0
            .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
            .map_err(|_| MpcError::Crypto("open_failed"))
    }
}

/// A key pair whose secret half is never exposed.
///
/// No `Debug`, no `Clone`, no `Serialize`, and no accessor returning the secret
/// bytes. `ed25519_dalek::SigningKey` zeroises on drop.
pub struct KeyPair {
    signing: SigningKey,
}

impl KeyPair {
    /// Generate from the OS CSPRNG, inside this process (ADR-0014).
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self {
            signing: SigningKey::from_bytes(&seed),
        }
    }

    pub fn public_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    /// Sign arbitrary bytes.
    ///
    /// The service does not parse the payload (prompt_phase4.md rule 133 in
    /// Phase 3's numbering: the signer signs bytes). Keeping it opaque is what
    /// lets a second chain reuse this service unchanged.
    pub fn sign(&self, payload: &[u8]) -> [u8; 64] {
        self.signing.sign(payload).to_bytes()
    }

    /// Encrypt for storage. The ONLY path out of this type for the secret.
    pub fn seal(&self, kek: &Kek) -> Result<Vec<u8>> {
        kek.seal(&self.signing.to_bytes())
    }

    pub fn open(kek: &Kek, sealed: &[u8]) -> Result<Self> {
        let bytes = kek.open(sealed)?;
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| MpcError::Crypto("sealed_key_wrong_length"))?;
        Ok(Self {
            signing: SigningKey::from_bytes(&seed),
        })
    }
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Public half only. A KeyPair inside a logged struct must not leak.
        write!(f, "KeyPair(pub={})", hex::encode(self.public_key_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kek() -> Kek {
        Kek::from_base64(&B64.encode([7u8; 32])).unwrap()
    }

    #[test]
    fn kek_requires_exactly_32_bytes() {
        assert!(Kek::from_base64(&B64.encode([1u8; 16])).is_err());
        assert!(Kek::from_base64(&B64.encode([1u8; 64])).is_err());
        assert!(Kek::from_base64("not base64!!").is_err());
        assert!(Kek::from_base64(&B64.encode([1u8; 32])).is_ok());
    }

    #[test]
    fn sealed_keys_round_trip() {
        let kek = kek();
        let original = KeyPair::generate();
        let sealed = original.seal(&kek).unwrap();

        let reopened = KeyPair::open(&kek, &sealed).unwrap();
        assert_eq!(original.public_key_bytes(), reopened.public_key_bytes());
        assert_eq!(original.sign(b"message"), reopened.sign(b"message"));
    }

    #[test]
    fn sealing_is_randomised() {
        let kek = kek();
        let key = KeyPair::generate();
        // Distinct nonces, so identical plaintext seals differently.
        assert_ne!(key.seal(&kek).unwrap(), key.seal(&kek).unwrap());
    }

    #[test]
    fn tampering_is_detected_rather_than_silently_decrypting() {
        let kek = kek();
        let mut sealed = KeyPair::generate().seal(&kek).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;

        // GCM is authenticated. Without it this would yield a DIFFERENT key,
        // silently, and every signature after would be worthless.
        assert!(KeyPair::open(&kek, &sealed).is_err());
    }

    #[test]
    fn a_different_kek_cannot_open_it() {
        let sealed = KeyPair::generate().seal(&kek()).unwrap();
        let other = Kek::from_base64(&B64.encode([9u8; 32])).unwrap();
        assert!(KeyPair::open(&other, &sealed).is_err());
    }

    #[test]
    fn truncated_ciphertext_is_rejected() {
        assert!(KeyPair::open(&kek(), &[0u8; 4]).is_err());
        assert!(KeyPair::open(&kek(), &[]).is_err());
    }

    #[test]
    fn debug_never_prints_the_secret() {
        let kek = kek();
        let key = KeyPair::generate();
        let sealed = key.seal(&kek).unwrap();

        let rendered = format!("{key:?} {kek:?}");
        assert!(rendered.contains("<redacted>"));
        // The public half is fine; the sealed bytes must not appear either.
        assert!(!rendered.contains(&hex::encode(&sealed)));
    }

    #[test]
    fn signatures_verify_against_the_public_key() {
        use ed25519_dalek::{Signature, Verifier};
        let key = KeyPair::generate();
        let signature = Signature::from_bytes(&key.sign(b"payload"));
        assert!(key.public_key().verify(b"payload", &signature).is_ok());
        assert!(key.public_key().verify(b"different", &signature).is_err());
    }
}
