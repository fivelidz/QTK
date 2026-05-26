//! qtk-core — the long-lived Rust sidecar that handles QTK's heavy parsers.
//!
//! Spawned once per opencode session by the TS-side `qtk-plugin`. Talks
//! NDJSON on stdin/stdout — one request per line, one response per line.
//! Designed to handle thousands of requests per second.
//!
//! Protocol:
//!   * On startup, we write one [`Hello`] line so the TS client knows we're
//!     alive and which compressors we offer.
//!   * For each line read from stdin: parse as [`Request`], dispatch to
//!     [`parsers::dispatch`], write the matching [`Response`] on stdout.
//!   * Per-request errors (bad JSON, unknown compressor, panic in a parser)
//!     do NOT crash the process — they produce an error response so the
//!     TS client can fall back to its in-process compressor.
//!   * EOF on stdin → exit 0 cleanly.

mod parsers;
mod protocol;

use std::io::{self, BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use protocol::{Hello, Request, Response};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    // Bootstrap message — TS client uses this to confirm liveness.
    let hello = Hello {
        kind: "hello",
        version: VERSION,
        compressors: parsers::names().to_vec(),
    };
    if write_line(&mut stdout, &hello).is_err() {
        // Stdout closed before we even started — nothing to do
        return;
    }

    // Main read loop
    for line in stdin.lines() {
        let Ok(text) = line else {
            // Read error on stdin — exit
            break;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }

        let resp = handle_one(trimmed);
        // If we can't write the response, the parent has gone away; stop.
        if write_response(&mut stdout, &resp).is_err() {
            break;
        }
    }
}

/// Handle one request line. This is the only function allowed to catch
/// panics — parser code is *meant* to never panic, but if one slips
/// through we degrade to an error response rather than killing the
/// session's sidecar.
fn handle_one(line: &str) -> Response {
    // Parse
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            return Response::err(0, format!("bad request json: {e}"));
        }
    };

    // Dispatch — wrapped in catch_unwind for safety
    let result = catch_unwind(AssertUnwindSafe(|| {
        parsers::dispatch(&req.compressor, &req.input)
    }));

    match result {
        Ok(Some(output)) => {
            #[allow(clippy::cast_precision_loss)]
            let ratio = if req.input.is_empty() {
                1.0
            } else {
                output.len() as f32 / req.input.len() as f32
            };
            Response::ok(req.id, output, ratio)
        }
        Ok(None) => Response::err(req.id, format!("unknown compressor: {}", req.compressor)),
        Err(_) => Response::err(req.id, "parser panicked"),
    }
}

fn write_line<T: serde::Serialize, W: Write>(out: &mut W, v: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *out, v).map_err(io::Error::other)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn write_response<W: Write>(out: &mut W, r: &Response) -> io::Result<()> {
    write_line(out, r)
}
