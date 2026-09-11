use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::{hash_payload, CallerVerifier, SignedRequest};
use crate::error::{MpcError, Result};
use crate::signer::{AuthorizationProof, SigningService};
use crate::store::Store;

/// The service's entire vocabulary (ADR-0013).
///
/// Three endpoints. There is deliberately NO way to export a key, list keys,
/// import key material, or change authorisation policy — the absence is the
/// design, because an operation that does not exist cannot be called by a
/// compromised API.
pub struct AppState {
    pub signer: SigningService,
    pub store: Arc<Store>,
    pub caller: CallerVerifier,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/sign", post(sign))
        .route("/v1/public-key", get(public_key))
        .route("/v1/health", get(health))
        .with_state(state)
}

#[derive(Deserialize)]
pub struct SignBody {
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "keyRef")]
    key_ref: String,
    /// base64. The service does not parse it — it signs bytes.
    payload: String,
    authorization: AuthorizationProof,
}

#[derive(Serialize)]
pub struct SignResponse {
    #[serde(rename = "requestId")]
    request_id: String,
    /// base64.
    signature: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    /// True when a previously-computed result was returned.
    replayed: bool,
}

async fn sign(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<SignResponse>> {
    // Parsed from the raw string so the signature covers exactly what arrived,
    // not a re-serialisation of it.
    let request: SignBody =
        serde_json::from_str(&body).map_err(|_| MpcError::BadRequest("body_not_json"))?;

    let payload = B64
        .decode(request.payload.trim())
        .map_err(|_| MpcError::BadRequest("payload_not_base64"))?;

    let payload_hash = hash_payload(&payload);

    // Authenticate BEFORE doing anything else (ADR-0013).
    let signature = header(&headers, "x-mpc-signature")?;
    let timestamp: i64 = header(&headers, "x-mpc-timestamp")?
        .parse()
        .map_err(|_| MpcError::Unauthenticated("timestamp_not_an_integer"))?;

    state.caller.verify(
        &SignedRequest {
            method: "POST",
            path: "/v1/sign",
            request_id: &request.request_id,
            payload_hash: &payload_hash,
            timestamp,
        },
        signature,
        now_unix(),
    )?;

    let caller = headers
        .get("x-mpc-caller")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");

    let outcome = state.signer.sign(
        &request.request_id,
        &request.key_ref,
        &payload,
        &request.authorization,
        caller,
    )?;

    Ok(Json(SignResponse {
        request_id: request.request_id,
        signature: B64.encode(outcome.signature),
        public_key: B64.encode(outcome.public_key),
        replayed: outcome.replayed,
    }))
}

#[derive(Deserialize)]
pub struct PublicKeyQuery {
    #[serde(rename = "keyRef")]
    key_ref: String,
}

#[derive(Serialize)]
pub struct PublicKeyResponse {
    #[serde(rename = "keyRef")]
    key_ref: String,
    #[serde(rename = "publicKey")]
    public_key: String,
}

async fn public_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PublicKeyQuery>,
) -> Result<Json<PublicKeyResponse>> {
    // Authenticated too. The public key is not secret, but an unauthenticated
    // caller enumerating key references is reconnaissance.
    let signature = header(&headers, "x-mpc-signature")?;
    let timestamp: i64 = header(&headers, "x-mpc-timestamp")?
        .parse()
        .map_err(|_| MpcError::Unauthenticated("timestamp_not_an_integer"))?;

    state.caller.verify(
        &SignedRequest {
            method: "GET",
            path: "/v1/public-key",
            request_id: &query.key_ref,
            payload_hash: &hash_payload(b""),
            timestamp,
        },
        signature,
        now_unix(),
    )?;

    let public = state.signer.public_key(&query.key_ref)?;
    Ok(Json(PublicKeyResponse {
        key_ref: query.key_ref,
        public_key: B64.encode(public),
    }))
}

#[derive(Serialize)]
pub struct HealthResponse {
    status: &'static str,
    storage: &'static str,
}

/// Unauthenticated, and reports liveness only.
///
/// It must not touch key material and must not reveal whether any particular
/// key exists — the same reasoning that keeps `/health/live` off the database
/// in the API (prompt_phase1.md rule 151).
async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let storage = if state.store.is_healthy() {
        "up"
    } else {
        "down"
    };
    Json(HealthResponse {
        status: if storage == "up" { "ok" } else { "degraded" },
        storage,
    })
}

fn header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or(MpcError::Unauthenticated("missing_auth_header"))
}

fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
