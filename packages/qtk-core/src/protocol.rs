//! Wire protocol for qtk-core. NDJSON over stdin/stdout — one JSON value
//! per line. The TS client sends a stream of [`Request`] objects, the Rust
//! side answers with a matching [`Response`] keyed by `id`.
//!
//! All fields are minimised — this is a hot path; we keep payloads small.

use serde::{Deserialize, Serialize};

/// A single compression request from the TS plugin to the sidecar.
#[derive(Debug, Deserialize)]
pub struct Request {
    /// Caller-assigned correlation id. The response echoes this.
    pub id: u64,

    /// Which compressor to apply. Free-form string; unknown names produce
    /// an error response rather than a crash. See `parsers/mod.rs`.
    pub compressor: String,

    /// Raw text to compress. Can be any size; we cap at 16 MiB for safety
    /// in the read loop (see main.rs).
    pub input: String,
}

/// The two response shapes — success carries the compressed output, failure
/// carries an error message.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Ok {
        id: u64,
        ok: bool, // always true in this variant; tag for the TS client
        output: String,
        /// Compression ratio (compressed.len() / input.len()) for stats.
        /// 1.0 means no compression happened (TS plugin should ignore).
        ratio: f32,
    },
    Err {
        id: u64,
        ok: bool, // always false
        error: String,
    },
}

impl Response {
    pub fn ok(id: u64, output: String, ratio: f32) -> Self {
        Response::Ok {
            id,
            ok: true,
            output,
            ratio,
        }
    }

    pub fn err(id: u64, error: impl Into<String>) -> Self {
        Response::Err {
            id,
            ok: false,
            error: error.into(),
        }
    }
}

/// Special bootstrap message — sent unsolicited once at process startup so
/// the TS client knows we're alive and which compressors we offer.
#[derive(Debug, Serialize)]
pub struct Hello {
    pub kind: &'static str, // always "hello"
    pub version: &'static str,
    pub compressors: Vec<&'static str>,
}
