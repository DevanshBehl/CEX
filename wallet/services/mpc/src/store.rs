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
/// A participant's stored share, as it comes back from the database.
///
/// A named type rather than a four-element tuple: `(Vec<u8>, Vec<u8>, Vec<u8>,
/// u16)` gives the caller three indistinguishable byte vectors to get in the
/// wrong order, and two of them are key material.
pub type StoredShare = (Vec<u8>, Vec<u8>, Vec<u8>, u16);

pub struct RecordedSignature {
    pub signature: Vec<u8>,
    pub public_key: Vec<u8>,
}

/// A participant's DKG session row (ADR-0023).
///
/// `sealed_secret` is KEK ciphertext and is `None` once the session is
/// committed or aborted.
pub struct DkgSessionRow {
    pub session_id: String,
    pub key_ref: String,
    pub identifier: Vec<u8>,
    pub phase: String,
    pub sealed_secret: Option<Vec<u8>>,
    pub round1_package: Vec<u8>,
    pub round1_packages: Option<Vec<u8>>,
    pub transcript_hash: Option<Vec<u8>>,
    pub public_package: Option<Vec<u8>>,
    pub failure_reason: Option<String>,
}

/// `(key_ref, identifier, phase, sealed_secret, public_package)` as read inside
/// the commit transaction.
type CommitCandidate = (String, Vec<u8>, String, Option<Vec<u8>>, Option<Vec<u8>>);

pub enum DkgCommitOutcome {
    Committed,
    /// This session was already committed; a retried commit is a success.
    AlreadyCommitted,
    /// The session is not in `verified` (or does not exist).
    NotVerified,
    /// A share for the key_ref exists from some OTHER ceremony.
    ShareAlreadyInstalled,
}

/// A coordinator session update. `None` fields keep their stored value, except
/// `failure_reason`, which is always written.
pub struct CoordinatorDkgUpdate<'a> {
    pub phase: &'a str,
    pub public_package: Option<&'a [u8]>,
    pub public_package_hash: Option<&'a [u8]>,
    pub transcript: Option<&'a str>,
    pub failure_reason: Option<&'a str>,
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

            -- ---------------------------------------------------------------
            -- 4b: threshold signing (ADR-0015)
            -- ---------------------------------------------------------------

            -- One participant's FROST key share, sealed under this host's KEK.
            --
            -- `identifier` is the participant's FROST identifier; `group_public`
            -- is the verifying key the whole group shares, which is also the
            -- treasury address. Storing the group key beside the share means a
            -- participant can verify what it is part of without asking the
            -- coordinator.
            CREATE TABLE IF NOT EXISTS frost_shares (
                key_ref         TEXT PRIMARY KEY,
                identifier      BLOB NOT NULL,
                group_public    BLOB NOT NULL,
                encrypted_share BLOB NOT NULL,
                min_signers     INTEGER NOT NULL,
                max_signers     INTEGER NOT NULL,
                created_at      TEXT NOT NULL
            );

            -- Group PUBLIC keys, as the coordinator knows them.
            --
            -- Separate from `frost_shares` because the coordinator holds NO key
            -- material — only the public package it needs to aggregate and the
            -- address it needs to report. Storing it in `frost_shares` would
            -- mean inventing an identifier and an empty encrypted share for a
            -- process that has neither, and a nullable `encrypted_share` is an
            -- invitation to read one that is not there.
            CREATE TABLE IF NOT EXISTS frost_group_keys (
                key_ref        TEXT PRIMARY KEY,
                public_package BLOB NOT NULL,
                created_at     TEXT NOT NULL
            );

            -- THE NONCE LEDGER. The single most important table in 4b.
            --
            -- In FROST, reusing a signing nonce across rounds does not weaken
            -- the scheme — it RECOVERS the participant's secret share. So a
            -- participant must never produce two signature shares for one
            -- nonce, and 'must never' has to mean 'cannot', not 'takes care
            -- not to'.
            --
            -- The commitment is written BEFORE it is published, and
            -- `used_at` is set when a share is produced. A second attempt
            -- against a row that already has `used_at` is refused. Because
            -- `nonce_id` is the primary key and the store is synchronous=FULL,
            -- this survives a crash between publishing and signing — which is
            -- exactly the window a retrying coordinator would hit.
            CREATE TABLE IF NOT EXISTS frost_nonces (
                nonce_id     TEXT PRIMARY KEY,
                key_ref      TEXT NOT NULL,
                encrypted_nonces BLOB NOT NULL,
                commitments  BLOB NOT NULL,
                created_at   TEXT NOT NULL,
                used_at      TEXT
            );

            -- ---------------------------------------------------------------
            -- Distributed key generation (ADR-0023)
            -- ---------------------------------------------------------------

            -- This participant's long-term X25519 transport identity.
            --
            -- Round-2 shares are routed through the coordinator, so each one is
            -- encrypted to the recipient's key AND authenticated by the
            -- sender's. The public half is pinned in every peer's
            -- MPC_DKG_PEERS; the secret half is sealed under the KEK like any
            -- share. One row, enforced by the CHECK.
            CREATE TABLE IF NOT EXISTS dkg_identity (
                id            INTEGER PRIMARY KEY CHECK (id = 1),
                public_key    BLOB NOT NULL,
                sealed_secret BLOB NOT NULL,
                created_at    TEXT NOT NULL
            );

            -- A participant's side of one DKG ceremony.
            --
            -- `sealed_secret` holds whichever secret the current phase needs —
            -- the round-1 polynomial, then the round-2 package, then the final
            -- KeyPackage awaiting commit — always under the KEK, and set to NULL
            -- the moment the session is committed or aborted. A secret that
            -- outlives its ceremony is a secret that can leak later.
            --
            -- phase: round1 -> round2 -> verified -> committed, or aborted.
            CREATE TABLE IF NOT EXISTS frost_dkg_sessions (
                session_id      TEXT PRIMARY KEY,
                key_ref         TEXT NOT NULL,
                identifier      BLOB NOT NULL,
                phase           TEXT NOT NULL,
                sealed_secret   BLOB,
                round1_package  BLOB NOT NULL,
                round1_packages BLOB,
                transcript_hash BLOB,
                public_package  BLOB,
                failure_reason  TEXT,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS frost_dkg_sessions_key_ref
                ON frost_dkg_sessions (key_ref);

            -- The coordinator's side of a ceremony. PUBLIC MATERIAL ONLY.
            --
            -- `transcript` is every response the coordinator received, verbatim:
            -- commitments, proofs of knowledge, ciphertext envelopes and
            -- verification shares. It is kept so an audit can replay what the
            -- coordinator saw — and so a test can prove that everything it saw
            -- is useless for recovering a key.
            CREATE TABLE IF NOT EXISTS frost_dkg_coordinator_sessions (
                session_id          TEXT PRIMARY KEY,
                key_ref             TEXT NOT NULL,
                idempotency_key     TEXT NOT NULL,
                phase               TEXT NOT NULL,
                public_package      BLOB,
                public_package_hash BLOB,
                transcript          TEXT NOT NULL DEFAULT '{}',
                failure_reason      TEXT,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS frost_dkg_coordinator_sessions_key_ref
                ON frost_dkg_coordinator_sessions (key_ref);
            CREATE INDEX IF NOT EXISTS frost_dkg_coordinator_sessions_idempotency
                ON frost_dkg_coordinator_sessions (idempotency_key);
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
    /// The stored signature for a completed request, with no key join.
    ///
    /// `completed_signature` joins `keys`, which a COORDINATOR has no row in —
    /// it holds a group public key in `frost_shares` and no private key
    /// anywhere. That join returning nothing would have looked like "this
    /// request never completed" and started a second set of signing rounds,
    /// which under FROST is a nonce-reuse hazard rather than a wasted call.
    pub fn completed_signature_only(&self, request_id: &str) -> Result<Option<Vec<u8>>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT signature FROM signing_requests
             WHERE request_id = ?1 AND outcome = 'succeeded'",
        )?;
        let mut rows = statement.query(params![request_id])?;
        match rows.next()? {
            Some(row) => Ok(row.get(0)?),
            None => Ok(None),
        }
    }

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

    // -----------------------------------------------------------------------
    // FROST share storage (ADR-0015)
    // -----------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn store_share(
        &self,
        key_ref: &str,
        identifier: &[u8],
        group_public: &[u8],
        sealed_share: &[u8],
        min_signers: u16,
        max_signers: u16,
    ) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO frost_shares
                (key_ref, identifier, group_public, encrypted_share, min_signers, max_signers, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (key_ref) DO NOTHING",
            params![
                key_ref,
                identifier,
                group_public,
                sealed_share,
                min_signers,
                max_signers,
                now()
            ],
        )?;
        Ok(())
    }

    /// Returns `(identifier, group_public, sealed_share, min_signers)`.
    pub fn load_share(&self, key_ref: &str) -> Result<Option<StoredShare>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT identifier, group_public, encrypted_share, min_signers
             FROM frost_shares WHERE key_ref = ?1",
        )?;
        let mut rows = statement.query(params![key_ref])?;
        match rows.next()? {
            Some(row) => Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))),
            None => Ok(None),
        }
    }

    /// Replace a share in place, preserving the group key (share refresh).
    pub fn replace_share(&self, key_ref: &str, sealed_share: &[u8]) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE frost_shares SET encrypted_share = ?2 WHERE key_ref = ?1",
            params![key_ref, sealed_share],
        )?;
        Ok(())
    }

    /// Remember a group's public package. Public material only.
    pub fn store_group_key(&self, key_ref: &str, public_package: &[u8]) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO frost_group_keys (key_ref, public_package, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (key_ref) DO NOTHING",
            params![key_ref, public_package, now()],
        )?;
        Ok(())
    }

    pub fn load_group_key(&self, key_ref: &str) -> Result<Option<Vec<u8>>> {
        let connection = self.lock()?;
        let mut statement =
            connection.prepare("SELECT public_package FROM frost_group_keys WHERE key_ref = ?1")?;
        let mut rows = statement.query(params![key_ref])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    // -----------------------------------------------------------------------
    // The nonce ledger — see the schema comment on `frost_nonces`
    // -----------------------------------------------------------------------

    /// Record a freshly generated nonce BEFORE its commitment is published.
    ///
    /// Returns false when the id already exists, which means a commitment for
    /// it has already been published and this is a replay.
    pub fn record_nonce(
        &self,
        nonce_id: &str,
        key_ref: &str,
        sealed_nonces: &[u8],
        commitments: &[u8],
    ) -> Result<bool> {
        let connection = self.lock()?;
        let inserted = connection.execute(
            "INSERT INTO frost_nonces
                (nonce_id, key_ref, encrypted_nonces, commitments, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (nonce_id) DO NOTHING",
            params![nonce_id, key_ref, sealed_nonces, commitments, now()],
        )?;
        Ok(inserted == 1)
    }

    /// Take a nonce for signing, marking it used in the same statement.
    ///
    /// The UPDATE ... WHERE used_at IS NULL is what makes this safe: two
    /// concurrent requests for one nonce produce one winner, decided by the
    /// database rather than by application-level care.
    pub fn consume_nonce(&self, nonce_id: &str) -> Result<Option<Vec<u8>>> {
        let connection = self.lock()?;

        let changed = connection.execute(
            "UPDATE frost_nonces SET used_at = ?2 WHERE nonce_id = ?1 AND used_at IS NULL",
            params![nonce_id, now()],
        )?;
        if changed == 0 {
            return Ok(None);
        }

        let mut statement =
            connection.prepare("SELECT encrypted_nonces FROM frost_nonces WHERE nonce_id = ?1")?;
        let mut rows = statement.query(params![nonce_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn nonce_was_used(&self, nonce_id: &str) -> Result<bool> {
        let connection = self.lock()?;
        let mut statement =
            connection.prepare("SELECT used_at FROM frost_nonces WHERE nonce_id = ?1")?;
        let mut rows = statement.query(params![nonce_id])?;
        match rows.next()? {
            Some(row) => {
                let used: Option<String> = row.get(0)?;
                Ok(used.is_some())
            }
            None => Ok(false),
        }
    }

    // -----------------------------------------------------------------------
    // DKG (ADR-0023) — participant side
    // -----------------------------------------------------------------------

    /// Store the transport identity. First writer wins: an identity that
    /// changed after peers pinned it would make this participant unreachable
    /// for every future ceremony.
    pub fn store_dkg_identity(&self, public_key: &[u8], sealed_secret: &[u8]) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO dkg_identity (id, public_key, sealed_secret, created_at)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT (id) DO NOTHING",
            params![public_key, sealed_secret, now()],
        )?;
        Ok(())
    }

    /// `(public_key, sealed_secret)`.
    pub fn load_dkg_identity(&self) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT public_key, sealed_secret FROM dkg_identity WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(MpcError::from)
    }

    /// Open a participant session, superseding any unfinished one for the
    /// same key.
    ///
    /// Returns false when `session_id` already exists. Superseded sessions have
    /// their secrets wiped in the same transaction: a coordinator that
    /// abandoned a ceremony and started another must not leave a live round-1
    /// polynomial behind.
    pub fn begin_dkg_session(
        &self,
        session_id: &str,
        key_ref: &str,
        identifier: &[u8],
        sealed_secret: &[u8],
        round1_package: &[u8],
    ) -> Result<bool> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;

        let inserted = transaction.execute(
            "INSERT INTO frost_dkg_sessions
                (session_id, key_ref, identifier, phase, sealed_secret, round1_package,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, 'round1', ?4, ?5, ?6, ?6)
             ON CONFLICT (session_id) DO NOTHING",
            params![
                session_id,
                key_ref,
                identifier,
                sealed_secret,
                round1_package,
                now()
            ],
        )?;

        if inserted == 1 {
            transaction.execute(
                "UPDATE frost_dkg_sessions
                 SET phase = 'aborted', sealed_secret = NULL,
                     failure_reason = 'superseded', updated_at = ?3
                 WHERE key_ref = ?1 AND session_id != ?2
                   AND phase IN ('round1', 'round2', 'verified')",
                params![key_ref, session_id, now()],
            )?;
        }

        transaction.commit()?;
        Ok(inserted == 1)
    }

    pub fn load_dkg_session(&self, session_id: &str) -> Result<Option<DkgSessionRow>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT session_id, key_ref, identifier, phase, sealed_secret, round1_package,
                        round1_packages, transcript_hash, public_package, failure_reason
                 FROM frost_dkg_sessions WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(DkgSessionRow {
                        session_id: row.get(0)?,
                        key_ref: row.get(1)?,
                        identifier: row.get(2)?,
                        phase: row.get(3)?,
                        sealed_secret: row.get(4)?,
                        round1_package: row.get(5)?,
                        round1_packages: row.get(6)?,
                        transcript_hash: row.get(7)?,
                        public_package: row.get(8)?,
                        failure_reason: row.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(MpcError::from)
    }

    /// The most recently started session for a key, for operators diagnosing
    /// a failed ceremony. Never includes the plaintext of anything.
    pub fn latest_dkg_session(&self, key_ref: &str) -> Result<Option<DkgSessionRow>> {
        let session_id: Option<String> = {
            let connection = self.lock()?;
            connection
                .query_row(
                    "SELECT session_id FROM frost_dkg_sessions WHERE key_ref = ?1
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    params![key_ref],
                    |row| row.get(0),
                )
                .optional()?
        };
        match session_id {
            Some(id) => self.load_dkg_session(&id),
            None => Ok(None),
        }
    }

    /// round1 -> round2. Conditional on the phase, so a replayed round-2
    /// request loses the race instead of re-running the round.
    pub fn advance_dkg_to_round2(
        &self,
        session_id: &str,
        sealed_secret: &[u8],
        round1_packages: &[u8],
        transcript_hash: &[u8],
    ) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE frost_dkg_sessions
             SET phase = 'round2', sealed_secret = ?2, round1_packages = ?3,
                 transcript_hash = ?4, updated_at = ?5
             WHERE session_id = ?1 AND phase = 'round1'",
            params![
                session_id,
                sealed_secret,
                round1_packages,
                transcript_hash,
                now()
            ],
        )?;
        Ok(changed == 1)
    }

    /// round2 -> verified: every share checked, final share sealed, NOT yet
    /// installed. Installation is `commit_dkg_session`.
    pub fn advance_dkg_to_verified(
        &self,
        session_id: &str,
        sealed_key_package: &[u8],
        public_package: &[u8],
    ) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE frost_dkg_sessions
             SET phase = 'verified', sealed_secret = ?2, public_package = ?3, updated_at = ?4
             WHERE session_id = ?1 AND phase = 'round2'",
            params![session_id, sealed_key_package, public_package, now()],
        )?;
        Ok(changed == 1)
    }

    /// Abort a session and wipe its secret. A committed session is final and
    /// is never touched.
    pub fn abort_dkg_session(&self, session_id: &str, reason: &str) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE frost_dkg_sessions
             SET phase = 'aborted', sealed_secret = NULL, failure_reason = ?2, updated_at = ?3
             WHERE session_id = ?1 AND phase != 'committed'",
            params![session_id, reason, now()],
        )?;
        Ok(())
    }

    /// Install a verified session's share as THE share for its key_ref.
    ///
    /// One transaction: the share row is inserted and the session marked
    /// committed together, or neither happens. The insert refuses to replace
    /// an existing share for the key — the same never-overwrite rule the
    /// signing path has always relied on (ADR-0020).
    pub fn commit_dkg_session(
        &self,
        session_id: &str,
        min_signers: u16,
        max_signers: u16,
    ) -> Result<DkgCommitOutcome> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;

        let row: Option<CommitCandidate> = transaction
            .query_row(
                "SELECT key_ref, identifier, phase, sealed_secret, public_package
                 FROM frost_dkg_sessions WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;

        let Some((key_ref, identifier, phase, sealed, public_package)) = row else {
            return Ok(DkgCommitOutcome::NotVerified);
        };

        match phase.as_str() {
            "committed" => return Ok(DkgCommitOutcome::AlreadyCommitted),
            "verified" => {}
            _ => return Ok(DkgCommitOutcome::NotVerified),
        }

        let (Some(sealed), Some(public_package)) = (sealed, public_package) else {
            return Err(MpcError::Internal("verified_session_incomplete"));
        };

        let inserted = transaction.execute(
            "INSERT INTO frost_shares
                (key_ref, identifier, group_public, encrypted_share, min_signers, max_signers, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (key_ref) DO NOTHING",
            params![
                key_ref,
                identifier,
                public_package,
                sealed,
                min_signers,
                max_signers,
                now()
            ],
        )?;

        if inserted == 0 {
            // Dropping the transaction rolls it back; the session stays
            // `verified` and the existing share is untouched.
            return Ok(DkgCommitOutcome::ShareAlreadyInstalled);
        }

        transaction.execute(
            "UPDATE frost_dkg_sessions
             SET phase = 'committed', sealed_secret = NULL, updated_at = ?2
             WHERE session_id = ?1",
            params![session_id, now()],
        )?;
        transaction.commit()?;
        Ok(DkgCommitOutcome::Committed)
    }

    // -----------------------------------------------------------------------
    // DKG (ADR-0023) — coordinator side. Public material only.
    // -----------------------------------------------------------------------

    pub fn create_coordinator_dkg_session(
        &self,
        session_id: &str,
        key_ref: &str,
        idempotency_key: &str,
    ) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO frost_dkg_coordinator_sessions
                (session_id, key_ref, idempotency_key, phase, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'round1', ?4, ?4)",
            params![session_id, key_ref, idempotency_key, now()],
        )?;
        Ok(())
    }

    /// The key_ref an idempotency key was first used for, if any.
    pub fn idempotency_key_owner(&self, idempotency_key: &str) -> Result<Option<String>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT key_ref FROM frost_dkg_coordinator_sessions
                 WHERE idempotency_key = ?1 ORDER BY created_at LIMIT 1",
                params![idempotency_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(MpcError::from)
    }

    /// A ceremony every participant verified but not every participant
    /// committed. `(session_id, public_package)`.
    pub fn resumable_coordinator_dkg_session(
        &self,
        key_ref: &str,
    ) -> Result<Option<(String, Vec<u8>)>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT session_id, public_package FROM frost_dkg_coordinator_sessions
                 WHERE key_ref = ?1 AND phase = 'committing' AND public_package IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1",
                params![key_ref],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(MpcError::from)
    }

    pub fn update_coordinator_dkg_session(
        &self,
        session_id: &str,
        update: &CoordinatorDkgUpdate<'_>,
    ) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE frost_dkg_coordinator_sessions
             SET phase = ?2,
                 public_package = COALESCE(?3, public_package),
                 public_package_hash = COALESCE(?4, public_package_hash),
                 transcript = COALESCE(?5, transcript),
                 failure_reason = ?6,
                 updated_at = ?7
             WHERE session_id = ?1",
            params![
                session_id,
                update.phase,
                update.public_package,
                update.public_package_hash,
                update.transcript,
                update.failure_reason,
                now()
            ],
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
