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
    /// Present when this process is running as a FROST participant.
    pub participant: Option<Arc<crate::frost::Participant>>,
    /// Present when this process is running as the coordinator.
    pub coordinator: Option<Arc<crate::threshold::Coordinator>>,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/sign", post(sign))
        .route("/v1/public-key", get(public_key))
        .route("/v1/health", get(health))
        // Participant endpoints. Present on every build; they refuse unless
        // this process actually holds a share, so a single-key deployment
        // cannot be talked into pretending it is a participant.
        .route("/v1/frost/commit", post(frost_commit))
        .route("/v1/frost/share", post(frost_share))
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

    /*
     * THE SWAP POINT.
     *
     * The caller asked for a signature. Whether that is one key in this
     * process or five participants across five hosts is decided here and
     * nowhere above — the request shape, the response shape, the idempotency
     * contract and the authentication are identical either way.
     *
     * This is the claim prompt_phase4.md rule 196 makes: replacing the
     * implementation must not require editing anything above the `Signer`
     * interface. The TypeScript side has no branch for this.
     */
    if let Some(coordinator) = state.coordinator.as_ref() {
        // Idempotency still belongs to the store, not to the rounds: a
        // repeated requestId must return the ORIGINAL signature rather than
        // starting a second set of rounds. Under threshold signing a duplicate
        // round is not merely wasteful — it is a nonce-reuse hazard, and the
        // participants refuse it, which would surface as an opaque failure
        // instead of the cached success the caller expects.
        state
            .signer
            .verify_authorization(&request.authorization, &payload_hash)?;

        let authorization_json = serde_json::to_string(&request.authorization)
            .map_err(|_| MpcError::Internal("authorization_not_serialisable"))?;

        let claimed = state.store.claim_request(
            &request.request_id,
            &request.key_ref,
            &payload_hash,
            &authorization_json,
            caller,
        )?;

        if !claimed {
            // Already seen. Either it finished — return the SAME signature, as
            // the idempotency contract promises — or it is still running, in
            // which case starting a second set of rounds would ask
            // participants to reuse nonces. They would refuse, but the caller
            // deserves a legible answer rather than a round that half-fails.
            let recorded = state.store.claimed_payload_hash(&request.request_id)?;
            if recorded.as_deref() != Some(payload_hash.as_slice()) {
                return Err(MpcError::BadRequest(
                    "request_id_reused_with_different_payload",
                ));
            }

            return match state.store.completed_signature_only(&request.request_id)? {
                Some(signature) => Ok(Json(SignResponse {
                    request_id: request.request_id,
                    signature: B64.encode(&signature),
                    public_key: B64.encode(coordinator.group_public_key()?),
                    replayed: true,
                })),
                None => Err(MpcError::BadRequest("request_in_progress")),
            };
        }

        let signature = match coordinator
            .sign(
                &request.request_id,
                &request.key_ref,
                &payload,
                &request.authorization,
            )
            .await
        {
            Ok(signature) => signature,
            Err(error) => {
                state.store.fail(&request.request_id, &error.reason())?;
                return Err(error);
            }
        };

        let bytes = signature
            .serialize()
            .map_err(|_| MpcError::Internal("signature_unserializable"))?;
        state.store.complete(&request.request_id, &bytes)?;

        return Ok(Json(SignResponse {
            request_id: request.request_id,
            signature: B64.encode(&bytes),
            public_key: B64.encode(coordinator.group_public_key()?),
            replayed: false,
        }));
    }

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

// ---------------------------------------------------------------------------
// FROST participant endpoints (ADR-0015, prompt_phase4.md §7)
// ---------------------------------------------------------------------------

/// Round 1. Commit to a nonce for this signing round.
///
/// Authenticated as the coordinator, like every other endpoint. That is
/// availability, not safety: the coordinator is a liveness dependency and the
/// thing that keeps it from being a safety one is the authorization check in
/// round 2, not this credential.
async fn frost_commit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<crate::threshold::CommitResponse>> {
    let request: crate::threshold::CommitRequest =
        serde_json::from_str(&body).map_err(|_| MpcError::BadRequest("body_not_json"))?;

    authenticate(
        &state,
        &headers,
        "/v1/frost/commit",
        &request.nonce_id,
        body.as_bytes(),
    )?;

    let Some(participant) = state.participant.as_ref() else {
        return Err(MpcError::BadRequest("not_a_participant"));
    };

    let commitments = participant.commit(&request.nonce_id)?;

    Ok(Json(crate::threshold::CommitResponse {
        identifier: crate::threshold::encode_identifier(&participant.identifier()),
        commitments: crate::threshold::encode_commitments(&commitments)?,
    }))
}

/// Round 2. Contribute a signature share — after checking the authorization.
///
/// # This is the endpoint that makes 3-of-5 worth building
///
/// A participant that signed whatever the coordinator sent would protect
/// against key theft and nothing else: a compromised API could ask five honest
/// participants for a signature paying an attacker, and get one.
///
/// So this verifies the `AuthorizationProof` against a key this host holds
/// independently of the coordinator, bound to THIS payload hash. It does not
/// re-run the risk rules — that would put policy in five places and violate
/// master-prompt rule 109. It checks the attestation, not the policy.
///
/// The package is rebuilt here from the raw commitments rather than accepting
/// a serialized `SigningPackage`, so the coordinator cannot present one message
/// to the participants and sign a different one.
async fn frost_share(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<crate::threshold::ShareResponse>> {
    let request: crate::threshold::ShareRequest =
        serde_json::from_str(&body).map_err(|_| MpcError::BadRequest("body_not_json"))?;

    authenticate(
        &state,
        &headers,
        "/v1/frost/share",
        &request.nonce_id,
        body.as_bytes(),
    )?;

    let Some(participant) = state.participant.as_ref() else {
        return Err(MpcError::BadRequest("not_a_participant"));
    };

    let payload =
        hex::decode(&request.payload).map_err(|_| MpcError::BadRequest("payload_not_hex"))?;
    if payload.is_empty() {
        return Err(MpcError::BadRequest("payload_empty"));
    }

    // THE CHECK. Independent of the coordinator, bound to this payload.
    state
        .signer
        .verify_authorization(&request.authorization, &hash_payload(&payload))?;

    let mut commitments = std::collections::BTreeMap::new();
    for (identifier, encoded) in &request.commitments {
        commitments.insert(
            crate::threshold::decode_identifier(identifier)?,
            crate::threshold::decode_commitments(encoded)?,
        );
    }

    let package = crate::frost::signing_package(commitments, &payload);
    let share = participant.sign(&request.nonce_id, &package)?;

    Ok(Json(crate::threshold::ShareResponse {
        identifier: crate::threshold::encode_identifier(&participant.identifier()),
        share: crate::threshold::encode_share(&share)?,
    }))
}

/// Shared caller authentication for the participant endpoints.
fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    path: &'static str,
    request_id: &str,
    body: &[u8],
) -> Result<()> {
    let signature = header(headers, "x-mpc-signature")?;
    let timestamp: i64 = header(headers, "x-mpc-timestamp")?
        .parse()
        .map_err(|_| MpcError::Unauthenticated("timestamp_not_an_integer"))?;

    state.caller.verify(
        &SignedRequest {
            method: "POST",
            path,
            request_id,
            payload_hash: &hash_payload(body),
            timestamp,
        },
        signature,
        now_unix(),
    )
}
