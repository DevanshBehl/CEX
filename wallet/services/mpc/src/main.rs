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

use wallet_mpc::{auth, dkg, error, frost, http, keystore, signer, store, threshold};

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
/// What this process is (ADR-0015).
///
/// One binary, three roles, chosen at boot. Separate binaries would duplicate
/// the config validation, the authentication and the audit trail — and a
/// participant that authenticated differently from the single-key service is a
/// participant whose security is a different, less-reviewed thing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    /// 4a: one key in one process. The default, so an existing deployment is
    /// unchanged by this code shipping.
    SingleKey,
    /// 4b: holds one FROST share and answers the round endpoints.
    Participant,
    /// 4b: holds no key material; runs rounds against the participants.
    Coordinator,
}

struct Config {
    role: Role,
    /// `role = Participant`: the roster entry this host is.
    participant_identifier: Option<String>,
    /// `role = Coordinator`: `identifier@url` for each participant.
    roster: Vec<String>,
    /// `role = Participant`: `identifier=base64_x25519_key` for all five
    /// members, this one included (ADR-0023). Pinned out of band — never
    /// learned from the coordinator. Absent means DKG rounds are refused.
    dkg_peers: Option<String>,
    /// `role = Coordinator`: the key it authenticates to participants with.
    ///
    /// A participant's only legitimate caller is the coordinator, so each
    /// participant's `MPC_CALLER_PUBLIC_KEY` must be this key's public half —
    /// which the coordinator prints at boot so it need not be derived by hand.
    coordinator_key: Option<String>,
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

    let role = match std::env::var("MPC_ROLE").as_deref() {
        Ok("participant") => Role::Participant,
        Ok("coordinator") => Role::Coordinator,
        Ok("single-key") | Err(_) => Role::SingleKey,
        Ok(other) => {
            missing.push(format!(
                "MPC_ROLE: expected single-key, participant or coordinator, got \"{other}\""
            ));
            Role::SingleKey
        }
    };

    let participant_identifier = std::env::var("MPC_PARTICIPANT_IDENTIFIER").ok();
    let roster: Vec<String> = std::env::var("MPC_PARTICIPANTS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();

    // Fail at boot, not at the first withdrawal. A coordinator with three
    // participants configured cannot ever reach a 3-of-5 threshold if one is
    // down, and discovering that when someone is trying to move money is the
    // worst possible time.
    if role == Role::Coordinator && roster.len() < usize::from(wallet_mpc::frost::MAX_SIGNERS) {
        missing.push(format!(
            "MPC_PARTICIPANTS: a coordinator needs {} entries (identifier@url), found {}",
            wallet_mpc::frost::MAX_SIGNERS,
            roster.len()
        ));
    }
    if role == Role::Participant && participant_identifier.is_none() {
        missing.push("MPC_PARTICIPANT_IDENTIFIER: required when MPC_ROLE is participant".into());
    }

    let coordinator_key = std::env::var("MPC_COORDINATOR_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty());
    // Without it the coordinator's requests to participants are unsigned, and
    // every participant rejects them — a deployment that starts cleanly and
    // then fails on the first withdrawal. Refuse at boot instead.
    if role == Role::Coordinator && coordinator_key.is_none() {
        missing.push(
            "MPC_COORDINATOR_KEY: required when MPC_ROLE is coordinator (base64 32-byte Ed25519 \
             seed); participants must trust its public half"
                .into(),
        );
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
        role,
        participant_identifier,
        roster,
        dkg_peers: std::env::var("MPC_DKG_PEERS")
            .ok()
            .filter(|value| !value.trim().is_empty()),
        coordinator_key,
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

    /*
     * `wallet-mpc dkg-identity`: print this participant's DKG transport public
     * key and exit (ADR-0023).
     *
     * Every participant's MPC_DKG_PEERS pins every other participant's key, so
     * the keys must exist before any participant can be fully configured. The
     * key is generated inside the store, sealed under MPC_KEK, and only its
     * public half is printed — the same "generated here, never exported" rule
     * as a share.
     */
    if std::env::args().nth(1).as_deref() == Some("dkg-identity") {
        match print_dkg_identity() {
            Ok(public) => {
                println!("{public}");
                return;
            }
            Err(error) => {
                eprintln!(
                    "\n  ✗ Could not load the DKG identity: {}\n",
                    error.reason()
                );
                std::process::exit(1);
            }
        }
    }

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

fn print_dkg_identity() -> std::result::Result<String, MpcError> {
    let kek = std::env::var("MPC_KEK").map_err(|_| MpcError::Internal("MPC_KEK_not_set"))?;
    let path = PathBuf::from(
        std::env::var("MPC_DATABASE_PATH").unwrap_or_else(|_| "./mpc.sqlite".to_string()),
    );
    let store = Store::open(&path)?;
    Ok(dkg::DkgIdentity::load_or_create(&store, &Kek::from_base64(&kek)?)?.public_key_base64())
}

async fn run(config: Config) -> std::result::Result<(), MpcError> {
    let store = Arc::new(Store::open(&config.database_path)?);
    let kek = Kek::from_base64(&config.kek)?;
    let caller = CallerVerifier::new(
        &config.caller_public_key,
        config.timestamp_tolerance_seconds,
    )?;

    // The KEK is consumed by the signing service; a participant needs its own
    // handle to seal shares and nonces with the same key.
    let kek_for_frost = Kek::from_base64(&config.kek)?;

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

    // -----------------------------------------------------------------------
    // Role wiring (ADR-0015)
    // -----------------------------------------------------------------------
    let mut coordinator = None;
    // Kept so shares provisioned AFTER boot can be sealed (ADR-0020). A
    // participant no longer receives its share only at startup.
    let mut participant_kek: Option<Kek> = None;
    let mut dkg_context: Option<dkg::DkgContext> = None;

    match config.role {
        Role::SingleKey => {
            if let Some(key_ref) = &config.bootstrap_key_ref {
                let public = signer.ensure_key(key_ref)?;
                tracing::info!(
                    key_ref,
                    public_key = %base64::Engine::encode(&base64::engine::general_purpose::STANDARD, public),
                    "signing key ready"
                );
            }
            tracing::warn!(
                "role=single-key: ONE key in one process. A compromise of this host yields the \
                 treasury key. Threshold signing is MPC_ROLE=participant/coordinator (ADR-0015)."
            );
        }

        Role::Participant => {
            let identity = dkg::DkgIdentity::load_or_create(&store, &kek_for_frost)?;
            tracing::info!(
                dkg_public_key = %identity.public_key_base64(),
                "DKG transport identity: pin this value for this participant in every peer's \
                 MPC_DKG_PEERS"
            );
            match &config.dkg_peers {
                Some(peers) => {
                    let context =
                        dkg::DkgContext::new(identity, dkg::DkgContext::parse_peers(peers)?)?;
                    let own = threshold::encode_identifier(&context.identifier());
                    // Two sources for "who am I" must agree, or the coordinator's
                    // roster and the DKG roster describe different deployments.
                    if let Some(configured) = &config.participant_identifier {
                        if configured.trim() != own {
                            tracing::error!(
                                configured = %configured,
                                from_roster = %own,
                                "MPC_PARTICIPANT_IDENTIFIER does not match this participant's \
                                 entry in MPC_DKG_PEERS"
                            );
                            return Err(MpcError::Internal("participant_identifier_mismatch"));
                        }
                    }
                    dkg_context = Some(context);
                }
                None => tracing::warn!(
                    "MPC_DKG_PEERS is not set: this participant will refuse DKG rounds and so \
                     cannot receive new keys (ADR-0023)"
                ),
            }

            let key_ref = config
                .bootstrap_key_ref
                .clone()
                .unwrap_or_else(|| "treasury".to_string());

            match frost::Participant::load(Arc::clone(&store), kek_for_frost, &key_ref)? {
                Some(loaded) => {
                    tracing::info!(
                        key_ref = %key_ref,
                        identifier = %config.participant_identifier.clone().unwrap_or_default(),
                        group_public_key = %base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            loaded.group_public_key()?,
                        ),
                        "participant ready"
                    );
                    participant_kek = Some(Kek::from_base64(&config.kek)?);
                    drop(loaded);
                }
                None => {
                    /*
                     * No longer fatal (ADR-0020).
                     *
                     * Under per-user keys a participant legitimately starts
                     * with no share for the house key_ref and receives shares
                     * as users are provisioned. Refusing to boot would make
                     * signup impossible on a fresh deployment.
                     *
                     * The old reasoning still applies to a participant that
                     * has no share for a key it is ASKED to sign with — and
                     * that is refused per request, which is where it belongs.
                     */
                    tracing::warn!(
                        key_ref = %key_ref,
                        "participant has no share for this key_ref yet; it will receive shares \
                         as users are provisioned"
                    );
                    participant_kek = Some(Kek::from_base64(&config.kek)?);
                }
            }
        }

        Role::Coordinator => {
            let participants = parse_roster(&config.roster)?;
            tracing::info!(
                participants = participants.len(),
                threshold = frost::MIN_SIGNERS,
                "coordinator ready"
            );
            let key_ref = config
                .bootstrap_key_ref
                .clone()
                .unwrap_or_else(|| "treasury".to_string());
            /*
             * The HOUSE group: what pays every user's fee and authorises every
             * nonce (ADR-0020).
             *
             * Read from `frost_group_keys`, which holds PUBLIC material only.
             * It used to be read from `frost_shares` — which meant the
             * coordinator could not start until someone had handed it a
             * SHARE, contradicting the one property a coordinator is supposed
             * to have. If it is absent the coordinator starts without a house
             * key and provisions one below, exactly as it does for a user.
             */
            let public_package: Option<frost_ed25519::keys::PublicKeyPackage> =
                match store.load_group_key(&key_ref)? {
                    Some(bytes) => Some(
                        postcard::from_bytes(&bytes)
                            .map_err(|_| MpcError::Internal("public_package_corrupt"))?,
                    ),
                    None => None,
                };

            let caller_signer = auth::CallerSigner::from_base64(
                config
                    .coordinator_key
                    .as_deref()
                    .ok_or(MpcError::Internal("coordinator_key_missing"))?,
            )?;
            // Printed so a roster misconfiguration is visible here rather than
            // as an opaque 401 during the first signing round.
            tracing::info!(
                caller_public_key = %caller_signer.public_key_base64(),
                "participants must be configured with MPC_CALLER_PUBLIC_KEY set to this value"
            );

            let mut built = threshold::Coordinator::new(
                participants,
                public_package.clone(),
                caller_signer,
                Arc::clone(&store),
                std::time::Duration::from_secs(20),
            )?;

            /*
             * FIRST BOOT: generate the house key.
             *
             * By DKG, exactly as every user key is (ADR-0023): the coordinator
             * routes the ceremony and holds only the resulting public package.
             * The single-key service has always generated its key on first
             * boot; this is the threshold equivalent, and doing it here rather
             * than by hand means the house key cannot be created by a
             * procedure nobody wrote down.
             *
             * Idempotent: a coordinator that already has one does nothing.
             */
            if public_package.is_none() {
                let generated = built.run_dkg(&key_ref, &format!("boot:{key_ref}")).await?;
                tracing::warn!(
                    key_ref = %key_ref,
                    address = %generated.group_public_key,
                    "generated the HOUSE key by DKG. Fund TREASURY_ADDRESS with exactly this \
                     address (ADR-0020, ADR-0023)."
                );

                let adopted = built
                    .stored_house_package(&key_ref)?
                    .ok_or(MpcError::Internal("house_key_not_stored"))?;
                built.adopt_house_key(adopted);
            }

            coordinator = Some(Arc::new(built));
        }
    }

    let state = Arc::new(http::AppState {
        signer,
        store,
        caller,
        participant_kek,
        dkg: dkg_context,
        coordinator,
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

/// Parse `identifier@url` roster entries.
///
/// The identifier is required rather than inferred from position: a roster
/// reordered in an environment variable would otherwise silently address the
/// wrong participant, and the symptom would be an aggregation failure with no
/// indication of the cause.
fn parse_roster(
    entries: &[String],
) -> std::result::Result<Vec<threshold::ParticipantEndpoint>, MpcError> {
    entries
        .iter()
        .map(|entry| {
            let (identifier, url) = entry
                .split_once('@')
                .ok_or(MpcError::Internal("roster_entry_malformed"))?;
            if identifier.trim().is_empty() || url.trim().is_empty() {
                return Err(MpcError::Internal("roster_entry_malformed"));
            }
            Ok(threshold::ParticipantEndpoint {
                identifier: identifier.trim().to_owned(),
                url: url.trim().trim_end_matches('/').to_owned(),
            })
        })
        .collect()
}
