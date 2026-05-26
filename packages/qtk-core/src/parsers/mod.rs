//! Heavy parsers — each module exports a `compress(&str) -> String` function.
//!
//! Cardinal rules (mirror the TS-side `Compressor` contract):
//!   * Never panic. Anything weird → return the input unchanged.
//!   * Never produce output larger than input. Length-monotonicity.
//!   * Pure: no I/O, no spawning, no global state.
//!
//! Adding a new parser:
//!   1. Add a module `parsers::myname` with `pub fn compress(&str) -> String`
//!   2. Register it in [`dispatch`] with a stable string name
//!   3. Add the name to [`names`] so the bootstrap [`Hello`](super::protocol::Hello)
//!      lists it
//!   4. Add fixture + integration tests in `tests/parsers.rs`

pub mod cargo_json;
pub mod junit;
pub mod kubectl;
pub mod terraform;

/// Run the named compressor on `input`. Returns `None` if the compressor
/// name is unknown (so main can produce a clear error response).
#[must_use]
pub fn dispatch(name: &str, input: &str) -> Option<String> {
    let result = match name {
        "junit-xml" => junit::compress(input),
        "terraform-plan" => terraform::compress(input),
        "kubectl-yaml" | "kubectl-json" => kubectl::compress(input),
        "cargo-json" => cargo_json::compress(input),
        _ => return None,
    };

    // Length-monotonicity safeguard: never expand the input.
    if result.len() >= input.len() {
        Some(input.to_string())
    } else {
        Some(result)
    }
}

/// Static list of compressor names exposed in the bootstrap message.
#[must_use]
pub const fn names() -> &'static [&'static str] {
    &[
        "junit-xml",
        "terraform-plan",
        "kubectl-yaml",
        "kubectl-json",
        "cargo-json",
    ]
}
