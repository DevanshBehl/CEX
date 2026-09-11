use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Errors this service can produce.
///
/// The split that matters, and it is the same one `packages/errors` makes on
/// the TypeScript side: `client_message` crosses the network, `detail` never
/// does. A signing service's internal errors are exactly the kind that carry
/// paths, key references, and database text.
#[derive(Debug, thiserror::Error)]
pub enum MpcError {
    #[error("request authentication failed")]
    Unauthenticated(&'static str),

    #[error("request is malformed")]
    BadRequest(&'static str),

    #[error("no such key")]
    KeyNotFound,

    #[error("authorization proof rejected")]
    AuthorizationRejected(&'static str),

    #[error("storage failure")]
    Storage(#[from] rusqlite::Error),

    #[error("cryptographic failure")]
    Crypto(&'static str),

    #[error("internal failure")]
    Internal(&'static str),
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
}

impl MpcError {
    fn code(&self) -> &'static str {
        match self {
            Self::Unauthenticated(_) => "UNAUTHENTICATED",
            Self::BadRequest(_) => "BAD_REQUEST",
            Self::KeyNotFound => "KEY_NOT_FOUND",
            Self::AuthorizationRejected(_) => "AUTHORIZATION_REJECTED",
            Self::Storage(_) | Self::Crypto(_) | Self::Internal(_) => "INTERNAL",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::Unauthenticated(_) => StatusCode::UNAUTHORIZED,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::KeyNotFound => StatusCode::NOT_FOUND,
            Self::AuthorizationRejected(_) => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// The reason, for the log and the audit trail only.
    pub fn reason(&self) -> String {
        match self {
            Self::Unauthenticated(r)
            | Self::BadRequest(r)
            | Self::AuthorizationRejected(r)
            | Self::Crypto(r)
            | Self::Internal(r) => (*r).to_string(),
            Self::KeyNotFound => "key_not_found".to_string(),
            // Deliberately not the driver's message: it carries file paths and
            // SQL text, and this string reaches an audit row.
            Self::Storage(_) => "storage_failure".to_string(),
        }
    }
}

impl IntoResponse for MpcError {
    fn into_response(self) -> Response {
        // Logged here; never serialised into the body.
        tracing::warn!(code = self.code(), reason = %self.reason(), "request failed");

        let body = ErrorBody {
            code: self.code(),
            // Deliberately uniform. A caller learns that a request failed and
            // roughly why, never which check rejected it — the same reasoning
            // that keeps risk reason codes off the API response in Phase 3.
            message: match self {
                Self::Unauthenticated(_) => "Request authentication failed",
                Self::BadRequest(_) => "Request is malformed",
                Self::KeyNotFound => "No such key",
                Self::AuthorizationRejected(_) => "Authorization was rejected",
                _ => "An internal error occurred",
            },
        };

        (self.status(), axum::Json(body)).into_response()
    }
}

pub type Result<T> = std::result::Result<T, MpcError>;
