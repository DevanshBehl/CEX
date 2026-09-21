//! Journal, snapshots and recovery (ADR-0028).

mod common;

use common::{market, place, request};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use wallet_matching::config::Config;
use wallet_matching::error::MatchingError;
use wallet_matching::runtime::{journal_path, Runtime};
use wallet_matching::types::{Event, Side, TimeInForce};
use wallet_matching::{journal, snapshot};

fn config(dir: &std::path::Path, snapshot_every_n: u64) -> Config {
    Config {
        snapshot_every_n,
        ..Config::local(dir, market())
    }
}

/// A deterministic, crossing stream: makers on both sides, then takers.
fn drive(runtime: &mut Runtime, count: u64) -> Vec<Event> {
    let mut events = Vec::new();
    for i in 0..count {
        let side = if i % 2 == 0 { Side::Sell } else { Side::Buy };
        let price = if side == Side::Sell {
            10_000_000 + (i % 5) * 1_000_000
        } else {
            10_000_000 - (i % 3) * 1_000_000
        };
        let command = place(
            &format!("o-{i}"),
            request(
                &format!("acct-{}", i % 3),
                side,
                Some(price),
                1_000_000 * ((i % 4) + 1),
                TimeInForce::GTC,
            ),
        );
        events.extend(
            runtime
                .submit(1_700_000_000_000 + i as i64, command)
                .expect("submit"),
        );
    }
    events
}

#[test]
fn a_command_is_durable_before_submit_returns() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), 1_000_000);
    let mut runtime = Runtime::recover(&config).expect("recover");

    runtime
        .submit(
            1_700_000_000_000,
            place(
                "o-1",
                request(
                    "a",
                    Side::Buy,
                    Some(10_000_000),
                    1_000_000,
                    TimeInForce::GTC,
                ),
            ),
        )
        .expect("submit");

    // Read the journal through a completely independent handle. If the fsync
    // happened after matching, or not at all, this is empty.
    let replayed = journal::replay(journal_path(dir.path()), 0, false).expect("replay");
    assert_eq!(replayed.commands.len(), 1);
    assert_eq!(replayed.last_seq, 1);
}

#[test]
fn replay_reproduces_the_exact_event_stream() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), 1_000_000);

    let original = {
        let mut runtime = Runtime::recover(&config).expect("recover");
        drive(&mut runtime, 40)
    };

    let (engine, replayed) =
        Runtime::replay_from_scratch(market(), journal_path(dir.path())).expect("replay");

    // Byte-identical, not merely equal-looking.
    assert_eq!(
        bincode::serialize(&original).unwrap(),
        bincode::serialize(&replayed).unwrap()
    );
    assert_eq!(engine.last_seq(), 40);
}

#[test]
fn a_restart_rebuilds_an_identical_book() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), 1_000_000);

    let before = {
        let mut runtime = Runtime::recover(&config).expect("recover");
        drive(&mut runtime, 40);
        runtime.engine().book().clone()
    };

    // A new process, same directory.
    let after = Runtime::recover(&config)
        .expect("recover")
        .engine()
        .book()
        .clone();
    assert_eq!(before, after);
    assert!(after.invariants_hold());
}

/// A snapshot is an optimisation over a correct baseline, so the baseline is
/// still asserted.
#[test]
fn snapshot_plus_tail_equals_a_full_replay() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Snapshot every 10 commands, so recovery genuinely uses one plus a tail.
    let config = config(dir.path(), 10);

    let expected = {
        let mut runtime = Runtime::recover(&config).expect("recover");
        drive(&mut runtime, 47);
        runtime.engine().book().clone()
    };
    assert!(
        snapshot::load(dir.path()).expect("load").is_some(),
        "the run should have written a snapshot"
    );

    let recovered = Runtime::recover(&config).expect("recover");
    assert_eq!(recovered.engine().book(), &expected);
    assert_eq!(recovered.engine().last_seq(), 47);

    let (from_scratch, _) =
        Runtime::replay_from_scratch(market(), journal_path(dir.path())).expect("replay");
    assert_eq!(from_scratch.book(), &expected);
}

#[test]
fn sequences_are_monotonic_across_a_restart_and_never_repeat() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), 1_000_000);

    {
        let mut runtime = Runtime::recover(&config).expect("recover");
        drive(&mut runtime, 5);
    }
    let mut runtime = Runtime::recover(&config).expect("recover");
    assert_eq!(runtime.next_seq(), 6, "sequencing must not restart at zero");

    let events = runtime
        .submit(
            1_700_000_000_999,
            place(
                "after-restart",
                request("a", Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
            ),
        )
        .expect("submit");
    assert_eq!(events[0].seq(), 6);
}

/// The expected result of a power loss during an append. There is one correct
/// interpretation: the command was never durable, so it never happened.
#[test]
fn a_torn_tail_is_truncated_and_recovery_stops_at_the_last_durable_sequence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), 1_000_000);
    {
        let mut runtime = Runtime::recover(&config).expect("recover");
        drive(&mut runtime, 10);
    }

    let path = journal_path(dir.path());
    let full_len = fs::metadata(&path).expect("metadata").len();

    // Chop the final record in half: a write that did not finish.
    let file = OpenOptions::new().write(true).open(&path).expect("open");
    file.set_len(full_len - 12).expect("truncate");
    file.sync_all().expect("sync");

    let replayed = journal::replay(&path, 0, true).expect("a torn tail is recoverable");
    assert!(replayed.truncated_at_offset.is_some());
    assert_eq!(replayed.last_seq, 9, "the torn command never happened");

    // Truncation was applied, so the next append starts from a clean boundary.
    let mut runtime = Runtime::recover(&config).expect("recover");
    assert_eq!(runtime.next_seq(), 10);
    let events = runtime
        .submit(
            1_700_000_000_999,
            place(
                "resumed",
                request("a", Side::Buy, Some(9_000_000), 1_000_000, TimeInForce::GTC),
            ),
        )
        .expect("submit");
    assert_eq!(events[0].seq(), 10);

    let again = journal::replay(&path, 0, false).expect("replay");
    assert!(
        again.truncated_at_offset.is_none(),
        "the journal is clean again"
    );
}

/// Skipping a record in the middle produces a book that never existed, and
/// every event after it is wrong in a way no test will catch — because the
/// engine will be internally consistent about a history that did not happen.
#[test]
fn mid_journal_corruption_refuses_to_start_rather_than_skipping() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), 1_000_000);
    {
        let mut runtime = Runtime::recover(&config).expect("recover");
        drive(&mut runtime, 20);
    }

    let path = journal_path(dir.path());
    // Flip a byte inside the FIRST record's payload, leaving 19 intact after it.
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .expect("open");
    file.seek(SeekFrom::Start(10 + 8 + 2)).expect("seek");
    let mut byte = [0u8; 1];
    file.read_exact(&mut byte).expect("read");
    file.seek(SeekFrom::Start(10 + 8 + 2)).expect("seek");
    file.write_all(&[byte[0] ^ 0xFF]).expect("write");
    file.sync_all().expect("sync");

    match journal::replay(&path, 0, true) {
        Err(MatchingError::JournalCorruption { .. }) => {}
        Err(other) => panic!("wrong error: {other:?}"),
        Ok(replay) => panic!(
            "corruption was silently accepted: {} commands recovered",
            replay.commands.len()
        ),
    }

    // And the whole runtime refuses, rather than starting on a partial history.
    assert!(matches!(
        Runtime::recover(&config),
        Err(MatchingError::JournalCorruption { .. })
    ));
}

#[test]
fn a_snapshot_that_fails_its_checksum_is_ignored_and_replay_still_recovers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), 5);

    let expected = {
        let mut runtime = Runtime::recover(&config).expect("recover");
        drive(&mut runtime, 20);
        runtime.engine().book().clone()
    };

    // Corrupt the snapshot payload. Recovery must fall back to a full replay,
    // which is always correct.
    let path = snapshot::snapshot_path(dir.path());
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .expect("open");
    file.seek(SeekFrom::Start(20)).expect("seek");
    let mut byte = [0u8; 1];
    file.read_exact(&mut byte).expect("read");
    file.seek(SeekFrom::Start(20)).expect("seek");
    file.write_all(&[byte[0] ^ 0xFF]).expect("write");
    file.sync_all().expect("sync");

    assert!(snapshot::load(dir.path()).expect("load").is_none());
    let recovered = Runtime::recover(&config).expect("recover");
    assert_eq!(recovered.engine().book(), &expected);
}

#[test]
fn a_journal_with_a_foreign_header_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path()).expect("mkdir");
    let path = journal_path(dir.path());
    fs::write(&path, b"NOTATLAS\x01\x00").expect("write");
    assert!(matches!(
        journal::replay(&path, 0, false),
        Err(MatchingError::BadJournalHeader(_))
    ));
}

#[test]
fn an_empty_data_directory_recovers_to_an_empty_book() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = Runtime::recover(&config(dir.path(), 10)).expect("recover");
    assert_eq!(runtime.engine().last_seq(), 0);
    assert_eq!(runtime.engine().book().open_order_count(), 0);
    assert_eq!(runtime.next_seq(), 1);
}
