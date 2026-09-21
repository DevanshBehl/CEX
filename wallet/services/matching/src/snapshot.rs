//! Snapshots (ADR-0028).
//!
//! A snapshot is an optimisation over a correct baseline, which is why the
//! baseline is still tested: snapshot-plus-tail must equal a full replay.
//!
//! It is written to a temporary file and RENAMED into place. A half-written
//! snapshot that recovery might read is worse than no snapshot at all, and the
//! rename is the only step here that is atomic.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::book::OrderBook;
use crate::error::{MatchingError, Result};

pub const SNAPSHOT_MAGIC: &[u8; 8] = b"ATLASSNP";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub last_seq: u64,
    pub book: OrderBook,
}

pub fn snapshot_path(dir: impl AsRef<Path>) -> PathBuf {
    dir.as_ref().join("book.snapshot")
}

pub fn write(dir: impl AsRef<Path>, snapshot: &Snapshot) -> Result<()> {
    let dir = dir.as_ref();
    fs::create_dir_all(dir)?;
    let payload = bincode::serialize(snapshot).map_err(|e| MatchingError::Decode(e.to_string()))?;
    let crc = crc32fast::hash(&payload);

    let temp = dir.join("book.snapshot.tmp");
    {
        let mut file = File::create(&temp)?;
        file.write_all(SNAPSHOT_MAGIC)?;
        file.write_all(&crc.to_le_bytes())?;
        file.write_all(&payload)?;
        file.sync_all()?;
    }
    fs::rename(&temp, snapshot_path(dir))?;
    Ok(())
}

/// `None` when there is no snapshot, or when the one present fails its
/// checksum. A snapshot that fails is IGNORED, never repaired — recovery falls
/// back to replaying from the beginning, which is always correct.
pub fn load(dir: impl AsRef<Path>) -> Result<Option<Snapshot>> {
    let path = snapshot_path(dir);
    if !path.exists() {
        return Ok(None);
    }
    let mut file = File::open(&path)?;
    let mut magic = [0u8; 8];
    if file.read_exact(&mut magic).is_err() || &magic != SNAPSHOT_MAGIC {
        tracing::warn!("snapshot has the wrong magic; ignoring it");
        return Ok(None);
    }
    let mut crc_bytes = [0u8; 4];
    if file.read_exact(&mut crc_bytes).is_err() {
        return Ok(None);
    }
    let expected = u32::from_le_bytes(crc_bytes);

    let mut payload = Vec::new();
    file.read_to_end(&mut payload)?;
    if crc32fast::hash(&payload) != expected {
        tracing::warn!("snapshot failed its checksum; ignoring it and replaying from the start");
        return Ok(None);
    }
    match bincode::deserialize::<Snapshot>(&payload) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(_) => Ok(None),
    }
}
