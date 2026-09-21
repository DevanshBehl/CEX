//! The write-ahead journal (ADR-0028).
//!
//! The order is: assign the sequence, append, **fsync**, then match. The fsync
//! is before matching and is never batched across commands. A fill that exists
//! in memory but not on disk is a fill that can be lost and cannot be replayed,
//! and batching the sync is exactly the optimisation that creates a window of
//! them.
//!
//! # Two kinds of damage, two different answers
//!
//! A **torn tail** — the last record short or failing its checksum, with nothing
//! readable after it — is the expected result of a power loss during an append.
//! There is one correct interpretation: the command was never durable, so it
//! never happened. Truncate, loudly.
//!
//! **Corruption in the middle** is not that. Skipping the record produces a book
//! that never existed, and every event after it is wrong in a way no test will
//! catch, because the engine will be internally consistent about a history that
//! did not happen. Refuse to start.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::error::{MatchingError, Result};
use crate::types::SequencedCommand;

pub const MAGIC: &[u8; 8] = b"ATLASMCH";
pub const FORMAT_VERSION: u16 = 1;
const HEADER_LEN: u64 = 10;

/// A cap on a single record, so a corrupt length field cannot ask for an
/// allocation the size of the address space.
const MAX_RECORD_LEN: u32 = 8 * 1024 * 1024;

pub struct Journal {
    path: PathBuf,
    file: File,
}

impl Journal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)?;

        if file.metadata()?.len() == 0 {
            file.write_all(MAGIC)?;
            file.write_all(&FORMAT_VERSION.to_le_bytes())?;
            file.sync_all()?;
        } else {
            verify_header(&path)?;
        }
        Ok(Self { path, file })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append and fsync. Returns only once the record is durable.
    pub fn append(&mut self, command: &SequencedCommand) -> Result<()> {
        let payload =
            bincode::serialize(command).map_err(|e| MatchingError::Decode(e.to_string()))?;
        let len = u32::try_from(payload.len())
            .map_err(|_| MatchingError::Decode("record exceeds u32".into()))?;
        if len > MAX_RECORD_LEN {
            return Err(MatchingError::Decode("record exceeds the maximum".into()));
        }
        let crc = crc32fast::hash(&payload);

        let mut record = Vec::with_capacity(8 + payload.len());
        record.extend_from_slice(&len.to_le_bytes());
        record.extend_from_slice(&crc.to_le_bytes());
        record.extend_from_slice(&payload);

        self.file.write_all(&record)?;
        // Before matching, never after, and never batched.
        self.file.sync_all()?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replay {
    pub commands: Vec<SequencedCommand>,
    /// Set when a torn tail was found and discarded.
    pub truncated_at_offset: Option<u64>,
    pub last_seq: u64,
}

fn verify_header(path: &Path) -> Result<()> {
    let mut file = File::open(path)?;
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)
        .map_err(|_| MatchingError::BadJournalHeader("file is shorter than a header".into()))?;
    if &magic != MAGIC {
        return Err(MatchingError::BadJournalHeader(format!(
            "magic was {magic:?}"
        )));
    }
    let mut version = [0u8; 2];
    file.read_exact(&mut version)
        .map_err(|_| MatchingError::BadJournalHeader("header is truncated".into()))?;
    let found = u16::from_le_bytes(version);
    if found != FORMAT_VERSION {
        return Err(MatchingError::UnsupportedJournalVersion {
            found,
            expected: FORMAT_VERSION,
        });
    }
    Ok(())
}

/// Read every record after `after_seq`.
///
/// `truncate` decides whether a torn tail is repaired on disk or only reported.
pub fn replay(path: impl AsRef<Path>, after_seq: u64, truncate: bool) -> Result<Replay> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(Replay {
            commands: Vec::new(),
            truncated_at_offset: None,
            last_seq: after_seq,
        });
    }
    verify_header(path)?;

    let file_len = std::fs::metadata(path)?.len();
    let mut reader = BufReader::new(File::open(path)?);
    reader.seek(SeekFrom::Start(HEADER_LEN))?;

    let mut commands: Vec<SequencedCommand> = Vec::new();
    let mut offset = HEADER_LEN;
    let mut last_seq = after_seq;
    let mut bad_offset: Option<u64> = None;

    loop {
        if offset >= file_len {
            break;
        }
        match read_record(&mut reader, offset, file_len) {
            RecordRead::Ok { command, next } => {
                if command.seq <= last_seq && !commands.is_empty() {
                    return Err(MatchingError::SequenceRegression {
                        previous: last_seq,
                        next: command.seq,
                    });
                }
                if command.seq > after_seq {
                    last_seq = command.seq;
                    commands.push(*command);
                } else {
                    last_seq = last_seq.max(command.seq);
                }
                offset = next;
            }
            RecordRead::Bad => {
                bad_offset = Some(offset);
                break;
            }
        }
    }

    if let Some(bad) = bad_offset {
        // Is there anything intact after the damage? If so this is not a torn
        // tail and must not be repaired by skipping.
        if has_valid_record_after(path, bad, file_len)? {
            return Err(MatchingError::JournalCorruption {
                seq: last_seq,
                detail: format!(
                    "a record at offset {bad} failed its checksum with intact records after it"
                ),
            });
        }
        tracing::warn!(
            offset = bad,
            last_seq,
            "torn tail in the journal: discarding the final partial record"
        );
        if truncate {
            let file = OpenOptions::new().write(true).open(path)?;
            file.set_len(bad)?;
            file.sync_all()?;
        }
        return Ok(Replay {
            commands,
            truncated_at_offset: Some(bad),
            last_seq,
        });
    }

    Ok(Replay {
        commands,
        truncated_at_offset: None,
        last_seq,
    })
}

enum RecordRead {
    Ok {
        command: Box<SequencedCommand>,
        next: u64,
    },
    Bad,
}

impl RecordRead {
    fn ok(command: SequencedCommand, next: u64) -> Self {
        RecordRead::Ok {
            command: Box::new(command),
            next,
        }
    }
}

fn read_record<R: Read>(reader: &mut R, offset: u64, file_len: u64) -> RecordRead {
    let mut header = [0u8; 8];
    if reader.read_exact(&mut header).is_err() {
        return RecordRead::Bad;
    }
    let len = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let crc = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    if len == 0 || len > MAX_RECORD_LEN {
        return RecordRead::Bad;
    }
    if offset + 8 + u64::from(len) > file_len {
        return RecordRead::Bad; // short: the append did not finish
    }
    let mut payload = vec![0u8; len as usize];
    if reader.read_exact(&mut payload).is_err() {
        return RecordRead::Bad;
    }
    if crc32fast::hash(&payload) != crc {
        return RecordRead::Bad;
    }
    match bincode::deserialize::<SequencedCommand>(&payload) {
        Ok(command) => RecordRead::ok(command, offset + 8 + u64::from(len)),
        Err(_) => RecordRead::Bad,
    }
}

/// Scan forward from just past the damaged record looking for an intact one.
///
/// Byte-wise rather than record-wise, because a corrupt length field means the
/// next record boundary is not known.
fn has_valid_record_after(path: &Path, bad_offset: u64, file_len: u64) -> Result<bool> {
    let mut file = File::open(path)?;
    let mut probe = bad_offset + 1;
    while probe + 8 < file_len {
        file.seek(SeekFrom::Start(probe))?;
        let mut reader = BufReader::new(&mut file);
        if let RecordRead::Ok { .. } = read_record(&mut reader, probe, file_len) {
            return Ok(true);
        }
        probe += 1;
    }
    Ok(false)
}
