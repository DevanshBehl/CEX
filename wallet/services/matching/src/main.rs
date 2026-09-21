//! The engine process.
//!
//! S1's binary was a CLI only. S2 adds `serve`, which is the first time
//! anything outside this process can reach the book — so most of what this file
//! does is refuse to make that easy.

use std::process::ExitCode;
use std::sync::Arc;

use tokio::sync::Mutex;
use wallet_matching::auth::{CallerVerifier, ReplayCache};
use wallet_matching::config::Config;
use wallet_matching::egress::{EventSink, MemorySink, RedisSink};
use wallet_matching::http::{router, AppState};
use wallet_matching::runtime::{journal_path, Runtime};
use wallet_matching::service::Service;
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

    if matches!(command, "help" | "--help" | "-h") {
        print_help();
        return ExitCode::SUCCESS;
    }

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
        "serve" => serve(config),
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
         serve    run the control plane\n\
         replay   replay the journal into a fresh book and report the result\n\
         verify   recover normally and check every book invariant\n\
         stats    print journal and snapshot statistics\n\
         \n\
         Configuration comes from the environment; see .env.example."
    );
}

fn serve(config: Config) -> wallet_matching::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| wallet_matching::MatchingError::Config(e.to_string()))?;

    runtime.block_on(async move {
        let sink = match config.redis_url.as_deref() {
            Some(url) => {
                let sink = RedisSink::connect_with_timeout(
                    url,
                    config.stream_max_len,
                    std::time::Duration::from_millis(config.publish_timeout_ms),
                )
                .await?;
                EventSink::Redis(Box::new(sink))
            }
            None => {
                // ADR-0030's contract is that a 2xx means the event is in the
                // stream. Without a stream there is nothing to be in, so say so
                // loudly rather than letting a deployment believe otherwise.
                tracing::warn!(
                    "MATCHING_REDIS_URL is unset: events go nowhere and a 2xx \
                     means only that the book changed"
                );
                EventSink::Memory(MemorySink::new())
            }
        };

        let service = Service::recover(&config, sink).await?;
        let verifier = match config.caller_public_key.as_deref() {
            Some(key) => Some(
                CallerVerifier::new(key, config.tolerance_seconds)
                    .map_err(wallet_matching::MatchingError::Config)?,
            ),
            None => {
                // The config layer already refused this off loopback.
                tracing::warn!(
                    "MATCHING_CALLER_PUBLIC_KEY is unset: requests are not authenticated, \
                     which is permitted only because the bind is loopback"
                );
                None
            }
        };

        let state = Arc::new(AppState {
            service: service.clone(),
            verifier,
            replay: Mutex::new(ReplayCache::new(
                config.tolerance_seconds,
                config.replay_cache_capacity,
            )),
            now: Box::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0)
            }),
        });

        tracing::info!(
            listen = %config.listen,
            market = %config.market.id,
            authenticated = state.verifier.is_some(),
            sink = state.service.market().id.as_str(),
            last_seq = service.last_seq().await,
            "matching engine listening"
        );

        let address: std::net::SocketAddr = config.listen.parse().map_err(|_| {
            wallet_matching::MatchingError::Config(format!(
                "MATCHING_LISTEN is not a socket address: {}",
                config.listen
            ))
        })?;

        let app = router(state);
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(wallet_matching::MatchingError::Io)?;

        let shutdown = async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        };

        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown)
            .await
            .map_err(wallet_matching::MatchingError::Io)?;

        // A clean stop flushes the watermark, so the next boot does not
        // republish work the stream already has.
        service.flush_watermark().await?;
        Ok(())
    })
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
    let watermark = wallet_matching::egress::Watermark::load(&config.data_dir, 1)?;
    println!("market              {}", config.market.id);
    println!("journal             {}", path.display());
    println!("journal records     {}", replayed.commands.len());
    println!("journal last seq    {}", replayed.last_seq);
    println!("published watermark {}", watermark.value());
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
