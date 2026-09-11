//! The wallet's signing boundary.
//!
//! This process holds key material. Nothing else in the system does, and that
//! property is the entire reason it exists as a separate process rather than a
//! library (master-prompt rules 21, 24, 167; ADR-0013).
//!
//! Phase 4a: one key. Phase 4b replaces `SigningService::sign` with a 3-of-5
//! FROST round and changes nothing above it — the request shape, the
//! idempotency contract, the authorization check and the audit trail are
//! already the right shape for a threshold (ADR-0015).

use wallet_mpc::{auth, error, http, keystore, signer, store};

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use auth::CallerVerifier;
use error::MpcError;
use keystore::Kek;
use signer::SigningService;
use store::Store;

/// Configuration, validated at boot.
///
/// The same rule the TypeScript side has followed since Phase 1: a missing or
/// malformed value stops the process here, naming the variable and never
/// printing its value — a config error is frequently the first thing pasted
/// into a chat, and it must be safe to paste.
struct Config {
    bind: SocketAddr,
    database_path: PathBuf,
    kek: String,
    caller_public_key: String,
    timestamp_tolerance_seconds: i64,
    /// Generated on boot if absent, so a fresh environment works.
    bootstrap_key_ref: Option<String>,
    /// The approval authority's public key.
    ///
    /// Absent means the service signs whatever it is asked to, which is
    /// development-only and is warned about on every request.
    approval_public_key: Option<String>,
    /// TLS certificate and key paths.
    ///
    /// Both or neither. Absent means plaintext, which is acceptable ONLY when
    /// the service is bound to loopback and fronted by a proxy that terminates
    /// TLS — and the service says so loudly at boot either way
    /// (master-prompt rule 160, prompt_phase4.md rules 138, 202).
    tls: Option<TlsConfig>,
}

struct TlsConfig {
    certificate_path: PathBuf,
    key_path: PathBuf,
}

fn load_config() -> std::result::Result<Config, Vec<String>> {
    let mut missing = Vec::new();

    fn required(name: &str, missing: &mut Vec<String>) -> String {
        match std::env::var(name) {
            Ok(value) if !value.trim().is_empty() => value,
            _ => {
                missing.push(format!("{name}: is required but was not set"));
                String::new()
            }
        }
    }

    let kek = required("MPC_KEK", &mut missing);
    let caller_public_key = required("MPC_CALLER_PUBLIC_KEY", &mut missing);

    let bind = std::env::var("MPC_BIND")
        .unwrap_or_else(|_| "127.0.0.1:7070".to_string())
        .parse()
        .unwrap_or_else(|_| {
            missing.push("MPC_BIND: must be host:port".to_string());
            "127.0.0.1:7070".parse().expect("literal is valid")
        });

    let database_path = PathBuf::from(
        std::env::var("MPC_DATABASE_PATH").unwrap_or_else(|_| "./mpc.sqlite".to_string()),
    );

    let timestamp_tolerance_seconds = std::env::var("MPC_TIMESTAMP_TOLERANCE_SECONDS")
        .unwrap_or_else(|_| "60".to_string())
        .parse()
        .unwrap_or(60);

    let certificate_path = std::env::var("MPC_TLS_CERT")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let key_path = std::env::var("MPC_TLS_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty());

    let tls = match (certificate_path, key_path) {
        (Some(certificate_path), Some(key_path)) => Some(TlsConfig {
            certificate_path: PathBuf::from(certificate_path),
            key_path: PathBuf::from(key_path),
        }),
        (None, None) => None,
        // One without the other is a misconfiguration that would silently
        // serve plaintext, which is the failure worth refusing to start over.
        _ => {
            missing.push("MPC_TLS_CERT and MPC_TLS_KEY: set both or neither".to_string());
            None
        }
    };

    if !missing.is_empty() {
        return Err(missing);
    }

    Ok(Config {
        bind,
        database_path,
        kek,
        caller_public_key,
        timestamp_tolerance_seconds,
        tls,
        bootstrap_key_ref: std::env::var("MPC_BOOTSTRAP_KEY_REF").ok(),
        approval_public_key: std::env::var("MPC_APPROVAL_PUBLIC_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty()),
    })
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("MPC_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = match load_config() {
        Ok(config) => config,
        Err(problems) => {
            eprintln!("\n  ✗ Configuration is invalid. The process cannot start.\n");
            for problem in &problems {
                eprintln!("    {problem}");
            }
            eprintln!("\n  (Values are never printed here — only names and reasons.)\n");
            std::process::exit(1);
        }
    };

    if let Err(error) = run(config).await {
        eprintln!("\n  ✗ Failed to start: {}\n", error.reason());
        std::process::exit(1);
    }
}

async fn run(config: Config) -> std::result::Result<(), MpcError> {
    let store = Arc::new(Store::open(&config.database_path)?);
    let kek = Kek::from_base64(&config.kek)?;
    let caller = CallerVerifier::new(
        &config.caller_public_key,
        config.timestamp_tolerance_seconds,
    )?;

    let signer = match &config.approval_public_key {
        Some(key) => SigningService::new(Arc::clone(&store), kek).with_approval_key(key)?,
        None => {
            tracing::warn!(
                "MPC_APPROVAL_PUBLIC_KEY is not set: this service will sign any well-formed \
                 request. Development only — see ADR-0015."
            );
            SigningService::new(Arc::clone(&store), kek)
        }
    };

    if let Some(key_ref) = &config.bootstrap_key_ref {
        let public = signer.ensure_key(key_ref)?;
        tracing::info!(
            key_ref,
            public_key = %base64::Engine::encode(&base64::engine::general_purpose::STANDARD, public),
            "signing key ready"
        );
    }

    let state = Arc::new(http::AppState {
        signer,
        store,
        caller,
    });

    let router = http::router(state);

    match &config.tls {
        Some(tls) => {
            // rustls will not pick a backend for you when more than one is
            // compiled in, and the failure is a panic deep inside the TLS
            // handshake rather than anything legible. Choose it explicitly.
            rustls::crypto::ring::default_provider()
                .install_default()
                .map_err(|_| MpcError::Internal("tls_provider_already_installed"))?;

            let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(
                &tls.certificate_path,
                &tls.key_path,
            )
            .await
            .map_err(|_| MpcError::Internal("tls_certificate_unreadable"))?;

            tracing::info!(bind = %config.bind, "mpc service listening over TLS");

            axum_server::bind_rustls(config.bind, tls_config)
                .serve(router.into_make_service())
                .await
                .map_err(|_| MpcError::Internal("serve_failed"))?;
        }
        None => {
            // Plaintext is acceptable only behind a proxy that terminates TLS,
            // and only when this socket is not reachable beyond it. Anything
            // else sends authorization proofs and payloads in the clear.
            if !is_loopback(&config.bind) {
                tracing::error!(
                    bind = %config.bind,
                    "refusing to serve plaintext on a non-loopback address"
                );
                return Err(MpcError::Internal("plaintext_on_public_bind"));
            }

            tracing::warn!(
                bind = %config.bind,
                "serving PLAINTEXT on loopback: acceptable only behind a TLS-terminating \
                 proxy (master-prompt rule 160)"
            );

            let listener = tokio::net::TcpListener::bind(config.bind)
                .await
                .map_err(|_| MpcError::Internal("bind_failed"))?;

            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown_signal())
                .await
                .map_err(|_| MpcError::Internal("serve_failed"))?;
        }
    }

    Ok(())
}

/// Is this address only reachable from the same host?
///
/// The guard that turns "we meant to put a proxy in front of it" from an
/// intention into something the process enforces.
fn is_loopback(address: &SocketAddr) -> bool {
    address.ip().is_loopback()
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
