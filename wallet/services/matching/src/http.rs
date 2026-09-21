//! The control plane.
//!
//! The engine's only legitimate caller is the order gateway; an end user never
//! reaches it. Everything here exists to make that true and to keep it true.
//!
//! # Status codes
//!
//! A **rejected order is a 200** carrying a `Rejected` event. A rejection is a
//! business outcome the engine computed; a 4xx says the request never got that
//! far, and conflating them leaves the gateway unable to tell "your order was
//! refused" from "your request was malformed".
//!
//! The non-2xx cases are exactly: malformed input (400), a failed signature
//! (401), an unknown route (404), a replayed request id (409), and a publish
//! that did not confirm (503 — and **ambiguous**, see [`ADR-0030`]).
//!
//! [`ADR-0030`]: ../../../docs/adr/0030-engine-transport-and-backpressure.md

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::auth::{hash_payload, AuthFailure, CallerVerifier, ReplayCache, SignedRequest};
use crate::lookup::LookupOutcome;
use crate::service::Service;
use crate::types::{Command, Event, MarketStatus, OrderRequest, Price, Qty, Seq};

pub struct AppState {
    pub service: Arc<Service>,
    /// `None` only when bound to loopback with no key configured — a
    /// development convenience the config refuses to allow off loopback.
    pub verifier: Option<CallerVerifier>,
    pub replay: Mutex<ReplayCache>,
    /// Injected so tests can advance it. The ENGINE has no clock; this one
    /// belongs to the transport and never reaches a command.
    pub now: Box<dyn Fn() -> i64 + Send + Sync>,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/orders", post(place))
        .route("/v1/orders/lookup", get(lookup))
        .route("/v1/orders/:order_id", delete(cancel))
        .route("/v1/orders/:order_id", patch(amend))
        .route("/v1/events", get(events))
        .route("/v1/book", get(book))
        .route("/v1/markets/status", post(set_status))
        .route("/v1/health", get(health))
        .with_state(state)
}

// ---------------------------------------------------------------- responses

#[derive(Serialize)]
pub struct CommandResponse {
    pub seq: Seq,
    pub events: Vec<Event>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ErrorResponse { error: self.1 })).into_response()
    }
}

impl From<AuthFailure> for ApiError {
    fn from(failure: AuthFailure) -> Self {
        // A replay is a 409, distinct from the 401 a bad signature earns, so an
        // operator can tell a client retrying from an attacker replaying.
        let status = if failure.is_replay() {
            StatusCode::CONFLICT
        } else {
            StatusCode::UNAUTHORIZED
        };
        ApiError(status, failure.reason())
    }
}

impl From<crate::error::MatchingError> for ApiError {
    fn from(error: crate::error::MatchingError) -> Self {
        match error {
            // The command IS journaled and the book HAS mutated. The caller
            // lost certainty, not the order, and resolves it with the lookup
            // endpoint rather than by retrying blind.
            crate::error::MatchingError::Egress(_) => {
                ApiError(StatusCode::SERVICE_UNAVAILABLE, "egress_unconfirmed")
            }
            crate::error::MatchingError::JournalCorruption { .. } => {
                ApiError(StatusCode::INTERNAL_SERVER_ERROR, "journal_corruption")
            }
            _ => ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

// ------------------------------------------------------------ authentication

async fn authenticate(
    state: &AppState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), ApiError> {
    let Some(verifier) = state.verifier.as_ref() else {
        return Ok(()); // loopback development mode; the config refuses this elsewhere
    };

    let signature = header(headers, "x-atlas-signature")?;
    let request_id = header(headers, "x-atlas-request-id")?;
    let timestamp: i64 = header(headers, "x-atlas-timestamp")?
        .parse()
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "timestamp_not_an_integer"))?;

    let now = (state.now)();
    let payload_hash = hash_payload(body);
    verifier.verify(
        &SignedRequest {
            method: method.as_str(),
            path,
            request_id,
            payload_hash: &payload_hash,
            timestamp,
        },
        signature,
        now,
    )?;

    // Only after the signature is known good. Recording an id from an unsigned
    // request would let anyone burn a request id the gateway intends to use.
    state
        .replay
        .lock()
        .await
        .observe(request_id, timestamp, now)?;
    Ok(())
}

/// The exact target the signature covers: path AND query.
///
/// Verifying `uri.path()` alone would leave every query parameter unsigned, so
/// a captured `GET /v1/events?after=0` could be rewritten to `after=999999` —
/// same path, empty body, still a valid signature. Parameters that change what
/// is returned must be inside what was signed.
fn signed_target(uri: &axum::http::Uri) -> &str {
    uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
}

fn header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str, ApiError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "missing_auth_header"))
}

fn decode<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|_| ApiError(StatusCode::BAD_REQUEST, "malformed_body"))
}

// ---------------------------------------------------------------- handlers

#[derive(Deserialize)]
struct PlaceBody {
    order_id: String,
    timestamp_ms: i64,
    request: OrderRequest,
}

async fn place(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<CommandResponse>, ApiError> {
    authenticate(&state, &method, signed_target(&uri), &headers, &body).await?;
    let parsed: PlaceBody = decode(&body)?;
    let submitted = state
        .service
        .submit(
            parsed.timestamp_ms,
            Command::Place {
                order_id: parsed.order_id,
                request: parsed.request,
            },
        )
        .await?;
    Ok(Json(CommandResponse {
        seq: submitted.seq,
        events: submitted.events,
    }))
}

#[derive(Deserialize)]
struct TimestampBody {
    timestamp_ms: i64,
}

async fn cancel(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    Path(order_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<CommandResponse>, ApiError> {
    authenticate(&state, &method, signed_target(&uri), &headers, &body).await?;
    let parsed: TimestampBody = decode(&body)?;
    let submitted = state
        .service
        .submit(parsed.timestamp_ms, Command::Cancel { order_id })
        .await?;
    Ok(Json(CommandResponse {
        seq: submitted.seq,
        events: submitted.events,
    }))
}

#[derive(Deserialize)]
struct AmendBody {
    timestamp_ms: i64,
    new_order_id: String,
    price: Price,
    qty: Qty,
}

async fn amend(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    Path(order_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<CommandResponse>, ApiError> {
    authenticate(&state, &method, signed_target(&uri), &headers, &body).await?;
    let parsed: AmendBody = decode(&body)?;
    let submitted = state
        .service
        .submit(
            parsed.timestamp_ms,
            Command::Amend {
                order_id,
                new_order_id: parsed.new_order_id,
                price: parsed.price,
                qty: parsed.qty,
            },
        )
        .await?;
    Ok(Json(CommandResponse {
        seq: submitted.seq,
        events: submitted.events,
    }))
}

#[derive(Deserialize)]
struct StatusBody {
    timestamp_ms: i64,
    status: MarketStatus,
}

async fn set_status(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<CommandResponse>, ApiError> {
    authenticate(&state, &method, signed_target(&uri), &headers, &body).await?;
    let parsed: StatusBody = decode(&body)?;
    let submitted = state
        .service
        .submit(
            parsed.timestamp_ms,
            Command::SetStatus {
                status: parsed.status,
            },
        )
        .await?;
    Ok(Json(CommandResponse {
        seq: submitted.seq,
        events: submitted.events,
    }))
}

#[derive(Deserialize)]
struct LookupQuery {
    #[serde(rename = "clientOrderId")]
    client_order_id: String,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum LookupResponse {
    /// The engine has no record of it.
    NeverSeen,
    Seen {
        seq: Seq,
        order_id: String,
    },
    /// Its own answer. A sweeper that reads this as `never_seen` reverses a
    /// live hold.
    Rebuilding,
}

async fn lookup(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Query(query): Query<LookupQuery>,
    body: Bytes,
) -> Result<Json<LookupResponse>, ApiError> {
    authenticate(&state, &method, signed_target(&uri), &headers, &body).await?;
    Ok(Json(
        match state.service.lookup(&query.client_order_id).await {
            LookupOutcome::NeverSeen => LookupResponse::NeverSeen,
            LookupOutcome::Seen { seq, order_id } => LookupResponse::Seen { seq, order_id },
            LookupOutcome::Rebuilding => LookupResponse::Rebuilding,
        },
    ))
}

#[derive(Deserialize)]
struct EventsQuery {
    after: Seq,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    1_000
}

#[derive(Serialize)]
struct EventsResponse {
    events: Vec<Event>,
}

async fn events(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Query(query): Query<EventsQuery>,
    body: Bytes,
) -> Result<Json<EventsResponse>, ApiError> {
    authenticate(&state, &method, signed_target(&uri), &headers, &body).await?;
    let events = state.service.events_since(query.after, query.limit).await?;
    Ok(Json(EventsResponse { events }))
}

#[derive(Serialize)]
struct BookLevel {
    price: Price,
    qty: String,
}

#[derive(Serialize)]
struct BookResponse {
    seq: Seq,
    bids: Vec<BookLevel>,
    asks: Vec<BookLevel>,
}

/// An authoritative depth snapshot, for S5's resnapshot-on-gap.
async fn book(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<BookResponse>, ApiError> {
    authenticate(&state, &method, signed_target(&uri), &headers, &body).await?;
    let snapshot = state.service.book_snapshot().await;
    let level = |ladder: &crate::book::Ladder| {
        ladder
            .iter_from_best()
            .map(|(price, level)| BookLevel {
                price: *price,
                qty: level.total_qty().to_string(),
            })
            .collect::<Vec<_>>()
    };
    Ok(Json(BookResponse {
        seq: state.service.last_seq().await,
        bids: level(snapshot.bids()),
        asks: level(snapshot.asks()),
    }))
}

#[derive(Serialize)]
struct HealthResponse {
    market: String,
    status: MarketStatus,
    last_seq: Seq,
    published_watermark: Seq,
    replay_cache_size: usize,
}

/// Requires no signature and reveals no order.
async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        market: state.service.market().id.clone(),
        status: state.service.status().await,
        last_seq: state.service.last_seq().await,
        published_watermark: state.service.published_watermark().await,
        replay_cache_size: state.replay.lock().await.len(),
    })
}
