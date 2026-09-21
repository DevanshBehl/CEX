//! Golden vectors.
//!
//! A checked-in command stream and the exact events it must produce, so any
//! behavioural change shows up as a reviewable diff rather than as a green test
//! suite (prompt_phase_s1.md rule 135).
//!
//! Regeneration is a DELIBERATE ACT: `MATCHING_REGENERATE_GOLDEN=1 cargo test
//! --test golden`. A regeneration is reviewed as a behaviour change, never
//! waved through as a test fix (rule 136, rule 194).

mod common;

use common::{market, place, request};
use wallet_matching::types::{Command, Event, SequencedCommand, Side, StpMode, TimeInForce};
use wallet_matching::Engine;

const COMMANDS: &str = include_str!("golden/commands.json");
const EVENTS: &str = include_str!("golden/events.json");

/// The stream is built in code rather than read, so the checked-in
/// `commands.json` is itself covered: if this drifts from the file, the test
/// fails before it even reaches the events.
fn stream() -> Vec<SequencedCommand> {
    let mut out = Vec::new();
    let mut push = |command: Command| {
        let seq = out.len() as u64 + 1;
        out.push(SequencedCommand {
            seq,
            timestamp_ms: 1_700_000_000_000 + seq as i64,
            command,
        });
    };

    // Build a two-sided book.
    push(place(
        "mk-1",
        request(
            "alice",
            Side::Sell,
            Some(11_000_000),
            2_000_000,
            TimeInForce::GTC,
        ),
    ));
    push(place(
        "mk-2",
        request(
            "bob",
            Side::Sell,
            Some(12_000_000),
            3_000_000,
            TimeInForce::GTC,
        ),
    ));
    push(place(
        "mk-3",
        request(
            "carol",
            Side::Buy,
            Some(10_000_000),
            2_000_000,
            TimeInForce::GTC,
        ),
    ));

    // A taker that partially fills across one level.
    push(place(
        "tk-1",
        request(
            "dave",
            Side::Buy,
            Some(11_000_000),
            1_000_000,
            TimeInForce::GTC,
        ),
    ));

    // A taker that sweeps a level and rests the remainder.
    push(place(
        "tk-2",
        request(
            "dave",
            Side::Buy,
            Some(12_000_000),
            5_000_000,
            TimeInForce::GTC,
        ),
    ));

    // An IOC whose remainder expires.
    push(place(
        "ioc-1",
        request(
            "erin",
            Side::Sell,
            Some(10_000_000),
            9_000_000,
            TimeInForce::IOC,
        ),
    ));

    // A FOK that cannot fill and must touch nothing.
    push(place(
        "fok-1",
        request(
            "erin",
            Side::Buy,
            Some(12_000_000),
            99_000_000,
            TimeInForce::FOK,
        ),
    ));

    // Post-only that would cross.
    let mut po = request(
        "frank",
        Side::Sell,
        Some(10_000_000),
        1_000_000,
        TimeInForce::GTC,
    );
    po.post_only = true;
    push(place("po-1", po));

    // Self-trade prevention, cancel-maker.
    let mut stp = request(
        "carol",
        Side::Sell,
        Some(10_000_000),
        1_000_000,
        TimeInForce::GTC,
    );
    stp.stp_mode = StpMode::CancelMaker;
    push(place("stp-1", stp));

    // A cancel, and a cancel of something already gone.
    push(Command::Cancel {
        order_id: "mk-2".into(),
    });
    push(Command::Cancel {
        order_id: "mk-2".into(),
    });

    // An amend, which loses time priority.
    push(Command::Amend {
        order_id: "tk-2".into(),
        new_order_id: "tk-2-v2".into(),
        price: 10_000_000,
        qty: 1_000_000,
    });

    out
}

fn run(commands: &[SequencedCommand]) -> Vec<Event> {
    let mut engine = Engine::new(market());
    let mut events = Vec::new();
    for command in commands {
        events.extend(engine.apply(command.clone()));
    }
    events
}

#[test]
fn the_golden_stream_produces_exactly_the_golden_events() {
    let commands = stream();
    let events = run(&commands);

    if std::env::var("MATCHING_REGENERATE_GOLDEN").is_ok() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
        std::fs::write(
            dir.join("commands.json"),
            serde_json::to_string_pretty(&commands).expect("encode") + "\n",
        )
        .expect("write commands");
        std::fs::write(
            dir.join("events.json"),
            serde_json::to_string_pretty(&events).expect("encode") + "\n",
        )
        .expect("write events");
        eprintln!("golden vectors regenerated — review the diff as a behaviour change");
        return;
    }

    let expected_commands: Vec<SequencedCommand> =
        serde_json::from_str(COMMANDS).expect("decode commands");
    assert_eq!(
        commands, expected_commands,
        "the checked-in command stream drifted from the one this test builds"
    );

    let expected_events: Vec<Event> = serde_json::from_str(EVENTS).expect("decode events");
    assert_eq!(
        events, expected_events,
        "the engine's behaviour changed; regenerate deliberately if that was intended"
    );
}

/// The golden stream is also a determinism vector: the same input, twice.
#[test]
fn the_golden_stream_is_reproducible() {
    let commands = stream();
    assert_eq!(
        bincode::serialize(&run(&commands)).unwrap(),
        bincode::serialize(&run(&commands)).unwrap()
    );
}
