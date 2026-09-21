//! The S1 binary is a CLI, not a server.
//!
//! No port, no listener, no HTTP. Making the engine reachable is S2's job, and
//! an endpoint added early is a second way into the book — anything that can
//! reach it can trade without a hold.

use std::process::ExitCode;

use wallet_matching::config::Config;
use wallet_matching::runtime::{journal_path, Runtime};
use wallet_matching::{journal, snapshot};

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or("help");

    let config = match Config::from_env(|name| std::env::var(name).ok()) {
        Ok(config) => config,
        Err(error) => {
            // Every problem at once, named, never valued.
            eprintln!("configuration refused: {error}");
            return ExitCode::FAILURE;
        }
    };

    let result = match command {
        "replay" => replay(&config),
        "verify" => verify(&config),
        "stats" => stats(&config),
        "help" | "--help" | "-h" => {
            print_help();
            return ExitCode::SUCCESS;
        }
        other => {
            eprintln!("unknown command: {other}");
            print_help();
            return ExitCode::FAILURE;
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn print_help() {
    eprintln!(
        "wallet-matching <command>\n\
         \n\
         replay   replay the journal into a fresh book and report the result\n\
         verify   recover normally and check every book invariant\n\
         stats    print journal and snapshot statistics\n\
         \n\
         Configuration comes from the environment; see .env.example."
    );
}

fn replay(config: &Config) -> wallet_matching::Result<()> {
    let path = journal_path(&config.data_dir);
    let (engine, events) = Runtime::replay_from_scratch(config.market.clone(), &path)?;
    println!(
        "replayed to sequence {} — {} events, {} resting orders, {} bid levels, {} ask levels",
        engine.last_seq(),
        events.len(),
        engine.book().open_order_count(),
        engine.book().bids().depth(),
        engine.book().asks().depth(),
    );
    if !engine.book().invariants_hold() {
        return Err(wallet_matching::MatchingError::Decode(
            "the replayed book violates its own invariants".into(),
        ));
    }
    Ok(())
}

fn verify(config: &Config) -> wallet_matching::Result<()> {
    let recovered = Runtime::recover_with(config, false)?;
    let book = recovered.engine().book();

    // The baseline a snapshot is only ever an optimisation over.
    let (from_scratch, _) =
        Runtime::replay_from_scratch(config.market.clone(), journal_path(&config.data_dir))?;

    if from_scratch.book() != book {
        return Err(wallet_matching::MatchingError::Decode(
            "snapshot-plus-tail disagrees with a full replay".into(),
        ));
    }
    if !book.invariants_hold() {
        return Err(wallet_matching::MatchingError::Decode(
            "the recovered book violates its own invariants".into(),
        ));
    }
    println!(
        "verified at sequence {}: snapshot-plus-tail equals a full replay, invariants hold",
        recovered.engine().last_seq()
    );
    Ok(())
}

fn stats(config: &Config) -> wallet_matching::Result<()> {
    let path = journal_path(&config.data_dir);
    let replayed = journal::replay(&path, 0, false)?;
    let snapshot = snapshot::load(&config.data_dir)?;
    println!("market              {}", config.market.id);
    println!("journal             {}", path.display());
    println!("journal records     {}", replayed.commands.len());
    println!("journal last seq    {}", replayed.last_seq);
    match replayed.truncated_at_offset {
        Some(offset) => println!("torn tail           at offset {offset}"),
        None => println!("torn tail           none"),
    }
    match snapshot {
        Some(s) => println!("snapshot            sequence {}", s.last_seq),
        None => println!("snapshot            none or unreadable"),
    }
    Ok(())
}
