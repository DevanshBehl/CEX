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
}

const DEFAULT_SNAPSHOT_EVERY_N: u64 = 10_000;

impl Config {
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

        if !problems.is_empty() {
            return Err(MatchingError::Config(problems.join("; ")));
        }

        Ok(Self {
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
