use thiserror::Error;

/// Typed errors.
///
/// Nothing here is reachable from an ordinary order: a malformed order is a
/// `RejectReason` event, not an error. These are failures of the process — a
/// journal that will not open, a snapshot that will not decode — and every one
/// of them is a reason to stop rather than to continue.
#[derive(Debug, Error)]
pub enum MatchingError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("journal header is not this format: {0}")]
    BadJournalHeader(String),

    #[error("journal format version {found} is not supported (expected {expected})")]
    UnsupportedJournalVersion { found: u16, expected: u16 },

    /// A record failed its checksum with intact records after it.
    ///
    /// This is NOT a torn tail and is never repaired by skipping. Skipping
    /// produces a book that never existed, and every event after it is wrong in
    /// a way no test will catch, because the engine will be internally
    /// consistent about a history that did not happen (ADR-0028).
    #[error("journal corruption at sequence {seq}: {detail}. Refusing to start.")]
    JournalCorruption { seq: u64, detail: String },

    #[error("snapshot failed its checksum")]
    SnapshotChecksum,

    #[error("decode: {0}")]
    Decode(String),

    #[error("sequence went backwards: {previous} then {next}")]
    SequenceRegression { previous: u64, next: u64 },

    #[error("configuration: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, MatchingError>;
