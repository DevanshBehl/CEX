//! Boot configuration.
//!
//! Read once, validated once, with EVERY missing or invalid value collected and
//! reported together before exiting — naming the variables but never their
//! values, as `services/mpc` does. A process that reports one problem per
//! restart makes an operator discover its requirements one restart at a time.

use std::path::PathBuf;

use crate::error::{MatchingError, Result};
use crate::types::{MarketConfig, MarketStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub data_dir: PathBuf,
    pub snapshot_every_n: u64,
    pub market: MarketConfig,

    // --- S2: transport ---
    pub listen: String,
    /// Base64 Ed25519 public key of the one legitimate caller, the gateway.
    pub caller_public_key: Option<String>,
    pub tolerance_seconds: i64,
    pub replay_cache_capacity: usize,
    pub redis_url: Option<String>,
    pub stream_name: String,
    pub stream_max_len: usize,
    pub watermark_sync_every: u64,
    pub event_ring_capacity: usize,
    pub publish_timeout_ms: u64,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
}

const DEFAULT_SNAPSHOT_EVERY_N: u64 = 10_000;
const DEFAULT_LISTEN: &str = "127.0.0.1:8080";
const DEFAULT_STREAM_MAX_LEN: usize = 100_000;
const DEFAULT_WATERMARK_SYNC_EVERY: u64 = 64;
const DEFAULT_EVENT_RING_CAPACITY: usize = 50_000;
const DEFAULT_REPLAY_CACHE_CAPACITY: usize = 250_000;
/// A publish that hangs holds the egress lock and stalls every command behind
/// it. Bounded, so an unreachable Redis is a fast 503 rather than an outage.
const DEFAULT_PUBLISH_TIMEOUT_MS: u64 = 2_000;

impl Config {
    /// A loopback, unauthenticated, no-Redis configuration.
    ///
    /// For tests and local development only. It is reachable from nowhere but
    /// this machine, which is the only reason it is allowed to have no caller
    /// key — `from_env` refuses that combination off loopback.
    pub fn local(data_dir: impl Into<PathBuf>, market: MarketConfig) -> Self {
        Self {
            data_dir: data_dir.into(),
            snapshot_every_n: DEFAULT_SNAPSHOT_EVERY_N,
            stream_name: format!("orders:events:{}", market.id),
            market,
            listen: DEFAULT_LISTEN.to_string(),
            caller_public_key: None,
            tolerance_seconds: crate::auth::DEFAULT_TOLERANCE_SECONDS,
            replay_cache_capacity: DEFAULT_REPLAY_CACHE_CAPACITY,
            redis_url: None,
            stream_max_len: DEFAULT_STREAM_MAX_LEN,
            watermark_sync_every: DEFAULT_WATERMARK_SYNC_EVERY,
            event_ring_capacity: DEFAULT_EVENT_RING_CAPACITY,
            publish_timeout_ms: DEFAULT_PUBLISH_TIMEOUT_MS,
            tls_cert: None,
            tls_key: None,
        }
    }

    /// Deliberately takes the environment as an argument rather than reading it.
    ///
    /// `process.env` is read in exactly one place in the TypeScript side of this
    /// repo for the same reason: a function that reaches for the environment
    /// cannot be tested without mutating global state.
    pub fn from_env<F>(get: F) -> Result<Self>
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut problems: Vec<String> = Vec::new();

        let data_dir = match get("MATCHING_DATA_DIR") {
            Some(value) if !value.trim().is_empty() => Some(PathBuf::from(value)),
            _ => {
                problems.push("MATCHING_DATA_DIR is required".into());
                None
            }
        };

        let snapshot_every_n = match get("MATCHING_SNAPSHOT_EVERY_N") {
            None => Some(DEFAULT_SNAPSHOT_EVERY_N),
            Some(value) => match value.parse::<u64>() {
                Ok(parsed) if parsed > 0 => Some(parsed),
                _ => {
                    problems.push("MATCHING_SNAPSHOT_EVERY_N must be a positive integer".into());
                    None
                }
            },
        };

        let market_id = match get("MATCHING_MARKET_ID") {
            Some(value) if value.contains(':') && value.contains('-') => Some(value),
            Some(_) => {
                problems.push(
                    "MATCHING_MARKET_ID must be cluster-qualified, e.g. devnet:SOL-USDC".into(),
                );
                None
            }
            None => {
                problems.push("MATCHING_MARKET_ID is required".into());
                None
            }
        };

        let tick_size = positive_u64(&get, "MATCHING_TICK_SIZE", &mut problems);
        let lot_size = positive_u64(&get, "MATCHING_LOT_SIZE", &mut problems);
        let min_notional = positive_u64(&get, "MATCHING_MIN_NOTIONAL", &mut problems);

        let collar_bps = match get("MATCHING_COLLAR_BPS") {
            Some(value) => match value.parse::<u32>() {
                Ok(parsed) if parsed > 0 => Some(parsed),
                _ => {
                    problems.push("MATCHING_COLLAR_BPS must be a positive integer".into());
                    None
                }
            },
            None => {
                problems.push("MATCHING_COLLAR_BPS is required".into());
                None
            }
        };

        let status = match get("MATCHING_MARKET_STATUS").as_deref() {
            None | Some("pre_open") => Some(MarketStatus::PreOpen),
            Some("open") => Some(MarketStatus::Open),
            Some("post_only") => Some(MarketStatus::PostOnly),
            Some("halted") => Some(MarketStatus::Halted),
            Some(_) => {
                problems.push(
                    "MATCHING_MARKET_STATUS must be pre_open, open, post_only or halted".into(),
                );
                None
            }
        };

        // --- S2: transport ---
        let listen = get("MATCHING_LISTEN").unwrap_or_else(|| DEFAULT_LISTEN.to_string());
        let caller_public_key = get("MATCHING_CALLER_PUBLIC_KEY").filter(|v| !v.trim().is_empty());

        // An open port with no authentication is the failure S2 exists to
        // avoid. Make it impossible rather than discouraged.
        if !is_loopback(&listen) && caller_public_key.is_none() {
            problems.push(
                "MATCHING_LISTEN is not loopback and MATCHING_CALLER_PUBLIC_KEY is unset: \
                 an open port with no authentication is refused"
                    .into(),
            );
        }

        let tolerance_seconds = match get("MATCHING_TOLERANCE_SECONDS") {
            None => Some(crate::auth::DEFAULT_TOLERANCE_SECONDS),
            Some(value) => match value.parse::<i64>() {
                Ok(parsed) if parsed > 0 => Some(parsed),
                _ => {
                    problems.push("MATCHING_TOLERANCE_SECONDS must be a positive integer".into());
                    None
                }
            },
        };

        let stream_name = get("MATCHING_STREAM_NAME").unwrap_or_else(|| {
            format!(
                "orders:events:{}",
                market_id.clone().unwrap_or_else(|| "unknown".into())
            )
        });

        if !problems.is_empty() {
            return Err(MatchingError::Config(problems.join("; ")));
        }

        Ok(Self {
            listen,
            caller_public_key,
            tolerance_seconds: tolerance_seconds.expect("checked above"),
            replay_cache_capacity: usize_or(
                &get,
                "MATCHING_REPLAY_CACHE_CAPACITY",
                DEFAULT_REPLAY_CACHE_CAPACITY,
            ),
            redis_url: get("MATCHING_REDIS_URL").filter(|v| !v.trim().is_empty()),
            stream_name,
            stream_max_len: usize_or(&get, "MATCHING_STREAM_MAX_LEN", DEFAULT_STREAM_MAX_LEN),
            watermark_sync_every: u64_or(
                &get,
                "MATCHING_WATERMARK_SYNC_EVERY",
                DEFAULT_WATERMARK_SYNC_EVERY,
            ),
            event_ring_capacity: usize_or(
                &get,
                "MATCHING_EVENT_RING_CAPACITY",
                DEFAULT_EVENT_RING_CAPACITY,
            ),
            publish_timeout_ms: u64_or(
                &get,
                "MATCHING_PUBLISH_TIMEOUT_MS",
                DEFAULT_PUBLISH_TIMEOUT_MS,
            ),
            tls_cert: get("MATCHING_TLS_CERT").filter(|v| !v.trim().is_empty()),
            tls_key: get("MATCHING_TLS_KEY").filter(|v| !v.trim().is_empty()),
            data_dir: data_dir.expect("checked above"),
            snapshot_every_n: snapshot_every_n.expect("checked above"),
            market: MarketConfig {
                id: market_id.expect("checked above"),
                tick_size: tick_size.expect("checked above"),
                lot_size: lot_size.expect("checked above"),
                min_notional: min_notional.expect("checked above"),
                collar_bps: collar_bps.expect("checked above"),
                status: status.expect("checked above"),
            },
        })
    }
}

fn positive_u64<F>(get: &F, name: &str, problems: &mut Vec<String>) -> Option<u64>
where
    F: Fn(&str) -> Option<String>,
{
    match get(name) {
        Some(value) => match value.parse::<u64>() {
            Ok(parsed) if parsed > 0 => Some(parsed),
            _ => {
                problems.push(format!("{name} must be a positive integer"));
                None
            }
        },
        None => {
            problems.push(format!("{name} is required"));
            None
        }
    }
}

/// Loopback by default, and a non-loopback bind must carry a caller key.
///
/// A default of `0.0.0.0` is a production incident waiting for a misconfigured
/// firewall, and a firewall is not the control that makes an unauthenticated
/// port safe.
fn is_loopback(listen: &str) -> bool {
    let host = match listen.rsplit_once(':') {
        Some((host, _)) => host,
        None => listen,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "127.0.0.1" || host == "localhost" || host == "::1"
}

fn usize_or<F>(get: &F, name: &str, default: usize) -> usize
where
    F: Fn(&str) -> Option<String>,
{
    get(name)
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn u64_or<F>(get: &F, name: &str, default: u64) -> u64
where
    F: Fn(&str) -> Option<String>,
{
    get(name)
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}
