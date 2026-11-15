//! The API's errors: a status, a readable message, and an optional code the app keys off
//! (`LOCKED`, `BAD_PASSWORD`…). Same shape as the Node server's `HttpError`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
    pub code: Option<&'static str>,
}

impl HttpError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), code: None }
    }
    pub fn coded(status: u16, message: impl Into<String>, code: &'static str) -> Self {
        Self { status, message: message.into(), code: Some(code) }
    }
    pub fn locked() -> Self {
        Self::coded(401, "Locked. Unlock to continue", "LOCKED")
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HttpError {}

pub type Result<T> = std::result::Result<T, HttpError>;

/// SQLite errors: the sync app replacing the file mid-save, or another program holding it.
/// Anything else is reported generically, never echoed (it could contain data).
impl From<rusqlite::Error> for HttpError {
    fn from(err: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::*;
        match err.sqlite_error_code() {
            Some(ReadOnly) => HttpError::coded(409, "Your database just changed on another device. Try that again.", "DB_CHANGED"),
            Some(DatabaseBusy | DatabaseLocked) => HttpError::coded(503, "The database is busy (another program is using it). Try again in a moment.", "BUSY"),
            _ => {
                eprintln!("Unexpected database error: {}", err.sqlite_error_code().map(|c| format!("{c:?}")).unwrap_or_else(|| "other".into()));
                HttpError::new(500, "Internal error")
            }
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = match self.code {
            Some(code) => json!({ "error": self.message, "code": code }),
            None => json!({ "error": self.message }),
        };
        (status, Json(body)).into_response()
    }
}
