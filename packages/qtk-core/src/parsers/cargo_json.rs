//! `cargo --message-format=json` compressor.
//!
//! Each line is a JSON object. Cargo emits dozens of `compiler-artifact`
//! messages per crate (one per dep) which we collapse, then promotes any
//! `compiler-message` (a diagnostic) to the output.
//!
//! Raw form (truncated):
//!
//! ```text
//! {"reason":"compiler-artifact","package_id":"serde 1.0.228 ...","target":{...},...}
//! {"reason":"compiler-artifact","package_id":"quote 1.0.40 ...",...}
//! ... 80 more lines of compiler-artifact ...
//! {"reason":"compiler-message","package_id":"my_crate 0.1.0",...,"message":{"rendered":"error[E0277]: ...","spans":[...],"level":"error"}}
//! {"reason":"build-finished","success":false}
//! ```
//!
//! Compressed form:
//!
//! ```text
//! cargo: 82 artifacts compiled
//! ERROR my_crate: error[E0277]: the trait bound `X: Y` is not satisfied
//!   at src/foo.rs:42:5
//! build-finished success=false
//! ```

use serde_json::Value;

#[must_use]
pub fn compress(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    // Quick gate
    if !input.contains("\"reason\"") {
        return input.to_string();
    }

    let mut artifacts = 0u32;
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut build_finished: Option<bool> = None;
    let mut other_lines = 0u32;

    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            other_lines += 1;
            continue;
        };
        let reason = v.get("reason").and_then(Value::as_str).unwrap_or("");
        match reason {
            "compiler-artifact" => artifacts += 1,
            "build-script-executed" => artifacts += 1, // count as artifact-ish
            "compiler-message" => {
                let level = v
                    .pointer("/message/level")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let rendered = v
                    .pointer("/message/rendered")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let pkg = v
                    .get("package_id")
                    .and_then(Value::as_str)
                    .and_then(short_pkg_id)
                    .unwrap_or_else(|| "?".to_string());
                let first_line = rendered.lines().next().unwrap_or("").trim();
                let span_loc = v
                    .pointer("/message/spans/0/file_name")
                    .and_then(Value::as_str)
                    .and_then(|f| {
                        let line = v
                            .pointer("/message/spans/0/line_start")
                            .and_then(Value::as_u64)?;
                        let col = v
                            .pointer("/message/spans/0/column_start")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        Some(format!("{f}:{line}:{col}"))
                    });
                let entry = match span_loc {
                    Some(loc) => format!("{pkg}: {first_line}\n  at {loc}"),
                    None => format!("{pkg}: {first_line}"),
                };
                if level == "error" {
                    errors.push(entry);
                } else if level == "warning" {
                    warnings.push(entry);
                }
            }
            "build-finished" => {
                build_finished = v.get("success").and_then(Value::as_bool);
            }
            _ => other_lines += 1,
        }
    }

    // If we didn't parse anything cargo-like, pass through
    if artifacts == 0 && errors.is_empty() && warnings.is_empty() && build_finished.is_none() {
        if other_lines > 0 {
            return input.to_string();
        }
        return input.to_string();
    }

    let mut out = String::with_capacity(256);
    if artifacts > 0 {
        out.push_str(&format!("cargo: {artifacts} artifact(s) compiled"));
        out.push('\n');
    }

    const MAX_DIAG: usize = 20;
    for (i, e) in errors.iter().enumerate() {
        if i >= MAX_DIAG {
            out.push_str(&format!(
                "  ... +{} more error(s)\n",
                errors.len() - MAX_DIAG
            ));
            break;
        }
        out.push_str("ERROR ");
        out.push_str(e);
        out.push('\n');
    }
    if errors.is_empty() {
        // Only show warnings if no errors (otherwise warnings are noise)
        for (i, w) in warnings.iter().enumerate() {
            if i >= MAX_DIAG {
                out.push_str(&format!(
                    "  ... +{} more warning(s)\n",
                    warnings.len() - MAX_DIAG
                ));
                break;
            }
            out.push_str("WARN ");
            out.push_str(w);
            out.push('\n');
        }
    } else if !warnings.is_empty() {
        out.push_str(&format!("(+ {} warning(s) suppressed)\n", warnings.len()));
    }

    if let Some(success) = build_finished {
        out.push_str(&format!("build-finished success={success}\n"));
    }

    if out.ends_with('\n') {
        out.pop();
    }
    out
}

/// Strip the `package_id` down from
/// `"serde 1.0.228 (registry+https://github.com/rust-lang/crates.io-index)"`
/// to just `"serde"`.
fn short_pkg_id(s: &str) -> Option<String> {
    let first = s.split_whitespace().next()?;
    Some(first.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input() {
        assert_eq!(compress(""), "");
    }

    #[test]
    fn non_cargo_passes_through() {
        let input = "just some lines\nthat aren't cargo json\n";
        assert_eq!(compress(input), input);
    }

    #[test]
    fn collapses_artifacts_and_shows_errors() {
        let mut input = String::new();
        for _ in 0..30 {
            input.push_str(r#"{"reason":"compiler-artifact","package_id":"foo 1.0.0 (registry+x)","target":{},"profile":{},"features":[],"filenames":[],"executable":null,"fresh":true}"#);
            input.push('\n');
        }
        input.push_str(r#"{"reason":"compiler-message","package_id":"my_crate 0.1.0 (path+file:///x)","target":{},"message":{"rendered":"error[E0277]: the trait bound `X: Y` is not satisfied","level":"error","spans":[{"file_name":"src/foo.rs","line_start":42,"column_start":5}]}}"#);
        input.push('\n');
        input.push_str(r#"{"reason":"build-finished","success":false}"#);
        input.push('\n');

        let out = compress(&input);
        assert!(out.contains("30 artifact"));
        assert!(out.contains("ERROR my_crate"));
        assert!(out.contains("E0277"));
        assert!(out.contains("at src/foo.rs:42:5"));
        assert!(out.contains("success=false"));
        assert!(out.len() < input.len() / 4);
    }

    #[test]
    fn caps_many_errors() {
        let mut input = String::new();
        for i in 0..30 {
            input.push_str(&format!(
                r#"{{"reason":"compiler-message","package_id":"x 0.1.0","target":{{}},"message":{{"rendered":"error: number {i}","level":"error","spans":[]}}}}"#
            ));
            input.push('\n');
        }
        let out = compress(&input);
        assert!(out.contains("more error(s)"));
    }

    #[test]
    fn suppresses_warnings_when_errors_present() {
        let input = r#"{"reason":"compiler-message","package_id":"a 0.1.0","target":{},"message":{"rendered":"warning: unused","level":"warning","spans":[]}}
{"reason":"compiler-message","package_id":"a 0.1.0","target":{},"message":{"rendered":"error: bad","level":"error","spans":[]}}
{"reason":"build-finished","success":false}
"#;
        let out = compress(input);
        assert!(out.contains("ERROR"));
        assert!(out.contains("1 warning(s) suppressed"));
    }
}
