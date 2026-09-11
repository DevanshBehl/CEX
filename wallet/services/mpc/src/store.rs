use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

use crate::error::{MpcError, Result};

/// The MPC service's own datastore (ADR-0014).
///
/// Separate from the application database, so a dump of that database contains
/// no key material — a property that has to be true by construction rather than
/// by remembering not to write it (prompt_phase4.md rule 56).
///
/// SQLite because this store holds a handful of rows, must be trivial to run on
/// five separate hosts in 4b, and benefits from having no network surface of
/// its own. The application's PostgreSQL is emphatically not reused: sharing it
/// would defeat the entire point.
pub struct Store {
    connection: Mutex<Connection>,
}

/// A completed signing request. Never contains the payload or the key.
pub struct RecordedSignature {
    pub signature: Vec<u8>,
    pub public_key: Vec<u8>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        Self::migrate(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// An ephemeral store.
    ///
    /// Not `#[cfg(test)]`: the integration suite exercises the real HTTP layer
    /// through the library, and a boundary whose value is what it REFUSES can
    /// only be tested by making actual requests to it.
    pub fn in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        Self::migrate(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn migrate(connection: &Connection) -> Result<()> {
        connection.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            -- A signature that is reported as written must be durable: the
            -- caller may act on it by broadcasting a transaction.
            PRAGMA synchronous = FULL;

            CREATE TABLE IF NOT EXISTS keys (
                key_ref          TEXT PRIMARY KEY,
                public_key       BLOB NOT NULL,
                -- AES-256-GCM ciphertext. The KEK is never stored here.
                encrypted_secret BLOB NOT NULL,
                created_at       TEXT NOT NULL
            );

            -- The audit trail (master-prompt rule 110): what was asked, by whom,
            -- under what authorization, and what happened. Never the secret.
            --
            -- It is also the idempotency mechanism: request_id is the primary
            -- key, so a duplicate request cannot start a second signing
            -- operation (ADR-0013).
            CREATE TABLE IF NOT EXISTS signing_requests (
                request_id    TEXT PRIMARY KEY,
                key_ref       TEXT NOT NULL,
                -- The payload is hashed, never stored. It is the caller's data.
                payload_hash  BLOB NOT NULL,
                signature     BLOB,
                outcome       TEXT NOT NULL,
                failure_reason TEXT,
                authorization TEXT NOT NULL,
                caller        TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                completed_at  TEXT
            );

            CREATE INDEX IF NOT EXISTS signing_requests_created
                ON signing_requests (created_at);
            "#,
        )?;
        Ok(())
    }

    pub fn store_key(&self, key_ref: &str, public_key: &[u8], sealed: &[u8]) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO keys (key_ref, public_key, encrypted_secret, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (key_ref) DO NOTHING",
            params![key_ref, public_key, sealed, now()],
        )?;
        Ok(())
    }

    pub fn load_key(&self, key_ref: &str) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT public_key, encrypted_secret FROM keys WHERE key_ref = ?1",
                params![key_ref],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(MpcError::from)
    }

    /// Claim a request id, or report that it is already taken.
    ///
    /// `INSERT ... ON CONFLICT DO NOTHING` and a row count, never a
    /// read-then-write: two concurrent requests with one id must produce one
    /// winner, and the uniqueness constraint is what decides rather than a
    /// check with a race inside it.
    ///
    /// This is the same shape the TypeScript side has used for deposit and
    /// withdrawal idempotency since Phase 2, for the same reason.
    pub fn claim_request(
        &self,
        request_id: &str,
        key_ref: &str,
        payload_hash: &[u8],
        authorization: &str,
        caller: &str,
    ) -> Result<bool> {
        let connection = self.lock()?;
        let inserted = connection.execute(
            "INSERT INTO signing_requests
               (request_id, key_ref, payload_hash, outcome, authorization, caller, created_at)
             VALUES (?1, ?2, ?3, 'requested', ?4, ?5, ?6)
             ON CONFLICT (request_id) DO NOTHING",
            params![
                request_id,
                key_ref,
                payload_hash,
                authorization,
                caller,
                now()
            ],
        )?;
        Ok(inserted == 1)
    }

    /// The stored result for an already-claimed request, if it succeeded.
    pub fn completed_signature(&self, request_id: &str) -> Result<Option<RecordedSignature>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT s.signature, k.public_key
                 FROM signing_requests s JOIN keys k ON k.key_ref = s.key_ref
                 WHERE s.request_id = ?1 AND s.outcome = 'succeeded'",
                params![request_id],
                |row| {
                    Ok(RecordedSignature {
                        signature: row.get(0)?,
                        public_key: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(MpcError::from)
    }

    /// The payload hash a request was claimed with.
    ///
    /// Used to refuse a replay that reuses an id with DIFFERENT bytes — which
    /// is not a retry, it is an attempt to get a second thing signed under a
    /// key the caller already spent.
    pub fn claimed_payload_hash(&self, request_id: &str) -> Result<Option<Vec<u8>>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT payload_hash FROM signing_requests WHERE request_id = ?1",
                params![request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(MpcError::from)
    }

    pub fn complete(&self, request_id: &str, signature: &[u8]) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE signing_requests
             SET signature = ?2, outcome = 'succeeded', completed_at = ?3
             WHERE request_id = ?1",
            params![request_id, signature, now()],
        )?;
        Ok(())
    }

    pub fn fail(&self, request_id: &str, reason: &str) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE signing_requests
             SET outcome = 'failed', failure_reason = ?2, completed_at = ?3
             WHERE request_id = ?1",
            params![request_id, reason, now()],
        )?;
        Ok(())
    }

    pub fn is_healthy(&self) -> bool {
        self.lock()
            .and_then(|c| {
                c.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                    .map_err(MpcError::from)
            })
            .is_ok()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| MpcError::Internal("store_lock_poisoned"))
    }
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_id_can_be_claimed_once() {
        let store = Store::in_memory().unwrap();
        assert!(store
            .claim_request("r1", "k1", b"hash", "{}", "api")
            .unwrap());
        // The second caller loses, and learns so without a race.
        assert!(!store
            .claim_request("r1", "k1", b"hash", "{}", "api")
            .unwrap());
    }

    #[test]
    fn concurrent_claims_produce_exactly_one_winner() {
        use std::sync::Arc;
        let store = Arc::new(Store::in_memory().unwrap());

        let winners: usize = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16)
                .map(|_| {
                    let store = Arc::clone(&store);
                    scope.spawn(move || store.claim_request("r1", "k1", b"h", "{}", "api").unwrap())
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|won| *won)
                .count()
        });

        assert_eq!(winners, 1);
    }

    #[test]
    fn a_completed_signature_is_returned_for_a_repeat_request() {
        let store = Store::in_memory().unwrap();
        store.store_key("k1", b"pub", b"sealed").unwrap();
        store
            .claim_request("r1", "k1", b"hash", "{}", "api")
            .unwrap();
        store.complete("r1", b"signature-bytes").unwrap();

        let recorded = store.completed_signature("r1").unwrap().unwrap();
        assert_eq!(recorded.signature, b"signature-bytes");
        assert_eq!(recorded.public_key, b"pub");
    }

    #[test]
    fn a_failed_request_has_no_signature_to_replay() {
        let store = Store::in_memory().unwrap();
        store.store_key("k1", b"pub", b"sealed").unwrap();
        store
            .claim_request("r1", "k1", b"hash", "{}", "api")
            .unwrap();
        store.fail("r1", "injected").unwrap();

        assert!(store.completed_signature("r1").unwrap().is_none());
    }

    #[test]
    fn the_claimed_payload_hash_is_recoverable() {
        let store = Store::in_memory().unwrap();
        store
            .claim_request("r1", "k1", b"original", "{}", "api")
            .unwrap();
        assert_eq!(
            store.claimed_payload_hash("r1").unwrap().unwrap(),
            b"original".to_vec()
        );
    }

    #[test]
    fn storing_a_key_twice_is_a_no_op_rather_than_an_error() {
        let store = Store::in_memory().unwrap();
        store.store_key("k1", b"pub-1", b"sealed-1").unwrap();
        store.store_key("k1", b"pub-2", b"sealed-2").unwrap();

        // The first wins. Overwriting would silently orphan every signature
        // already produced under the original key.
        let (public, _) = store.load_key("k1").unwrap().unwrap();
        assert_eq!(public, b"pub-1");
    }

    #[test]
    fn an_unknown_key_is_absent_rather_than_an_error() {
        let store = Store::in_memory().unwrap();
        assert!(store.load_key("nope").unwrap().is_none());
    }
}
