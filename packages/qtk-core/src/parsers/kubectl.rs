//! kubectl `-o yaml` / `-o json` compressor.
//!
//! These outputs are enormous (multi-KB per pod for `get pods -o yaml`)
//! and most of the volume is `managedFields`, `creationTimestamp`,
//! `resourceVersion`, status conditions in CamelCase — none of which the
//! agent typically needs.
//!
//! Strategy: parse with `serde_json` (works for both JSON and one-doc
//! YAML if it's actually JSON-formatted; for YAML we use a tiny
//! line-based pre-filter to strip the worst offenders). For each item,
//! emit one line: `kind/name (namespace) status`.

use serde_json::Value;

#[must_use]
pub fn compress(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }

    // Detect format
    let trimmed = input.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return compress_json(input).unwrap_or_else(|| input.to_string());
    }
    // YAML path — line-based pruning (not a real YAML parser, which would
    // be heavyweight; we trust kubectl's predictable output shape).
    compress_yaml(input)
}

/// JSON path — for `kubectl get -o json` which is usually a single object
/// with `items: [...]` or a single resource.
fn compress_json(input: &str) -> Option<String> {
    let v: Value = serde_json::from_str(input).ok()?;

    // List form: { kind: "PodList", items: [...] }
    if let Some(items) = v.get("items").and_then(Value::as_array) {
        if items.is_empty() {
            return Some("(empty list)".to_string());
        }
        let mut out = String::with_capacity(64 * items.len());
        out.push_str(&format!("{} item(s):\n", items.len()));
        const MAX: usize = 50;
        for (i, item) in items.iter().enumerate() {
            if i >= MAX {
                out.push_str(&format!("  ... +{} more\n", items.len() - MAX));
                break;
            }
            out.push_str("  ");
            out.push_str(&one_line(item));
            out.push('\n');
        }
        if out.ends_with('\n') {
            out.pop();
        }
        return Some(out);
    }

    // Single-resource form
    let single = one_line(&v);
    if single.is_empty() {
        return None;
    }
    Some(single)
}

fn one_line(item: &Value) -> String {
    let kind = item.get("kind").and_then(Value::as_str).unwrap_or("?");
    let name = item
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let ns = item
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .unwrap_or("");
    let phase = item
        .pointer("/status/phase")
        .and_then(Value::as_str)
        .or_else(|| {
            item.pointer("/status/conditions/0/type")
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let ready = item
        .pointer("/status/containerStatuses/0/ready")
        .and_then(Value::as_bool);

    let ns_part = if ns.is_empty() {
        String::new()
    } else {
        format!(" (ns={ns})")
    };
    let phase_part = if phase.is_empty() {
        String::new()
    } else if let Some(r) = ready {
        format!(" {phase} ready={r}")
    } else {
        format!(" {phase}")
    };
    format!("{kind}/{name}{ns_part}{phase_part}")
}

/// YAML path — we're not a YAML parser; we just strip obvious noise.
/// Conservative: leaves real signal alone.
fn compress_yaml(input: &str) -> String {
    // Single-line noise keys (drop the whole line regardless of indent)
    const NOISE_KEYS: &[&str] = &[
        "creationTimestamp:",
        "resourceVersion:",
        "uid:",
        "selfLink:",
        "generation:",
    ];

    let mut out = String::with_capacity(input.len() / 4);
    // When we hit `managedFields:` at column N, we drop:
    //   - blank lines
    //   - lines with indent > N
    //   - lines with indent == N that start with `-` (YAML list items
    //     at the same column as their parent key — valid YAML form)
    // and exit skip mode on the first line with indent <= N that's NOT
    // a list-item continuation.
    let mut skip_target: Option<usize> = None;
    let mut total_in = 0usize;
    let mut kept = 0usize;

    for line in input.lines() {
        total_in += 1;
        let indent = line.bytes().take_while(|b| *b == b' ').count();
        let body = &line[indent..];

        if let Some(target) = skip_target {
            if body.is_empty() {
                continue; // blank line inside skip block
            }
            // Stay in skip mode if line is more-indented OR is a list item
            // at the same indent as the parent key.
            if indent > target || (indent == target && body.starts_with("- ")) {
                continue;
            }
            // Otherwise we're done skipping; fall through to evaluate this line
            skip_target = None;
        }

        // Detect managedFields opening (any indent)
        if body.starts_with("managedFields:") {
            skip_target = Some(indent);
            continue;
        }

        // Drop other single-line noise keys (any indent)
        if NOISE_KEYS.iter().any(|k| body.starts_with(k)) {
            continue;
        }

        out.push_str(line);
        out.push('\n');
        kept += 1;
    }

    // If we didn't drop much, return raw — likely not a yaml we recognise
    if kept * 100 > total_in * 90 {
        return input.to_string();
    }

    if out.ends_with('\n') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input() {
        assert_eq!(compress(""), "");
    }

    #[test]
    fn json_list_of_pods() {
        let input = serde_json::json!({
            "kind": "PodList",
            "items": [
                {
                    "kind": "Pod",
                    "metadata": {"name": "web-1", "namespace": "default"},
                    "status": {"phase": "Running"}
                },
                {
                    "kind": "Pod",
                    "metadata": {"name": "web-2", "namespace": "default"},
                    "status": {"phase": "Running"}
                },
                {
                    "kind": "Pod",
                    "metadata": {"name": "api-1", "namespace": "default"},
                    "status": {"phase": "Pending"}
                },
            ]
        })
        .to_string();
        let out = compress(&input);
        assert!(out.contains("3 item(s)"));
        assert!(out.contains("Pod/web-1"));
        assert!(out.contains("Pending"));
        assert!(out.len() < input.len());
    }

    #[test]
    fn json_empty_list() {
        let input = r#"{"kind":"PodList","items":[]}"#;
        assert!(compress(input).contains("empty list"));
    }

    #[test]
    fn yaml_strips_managed_fields() {
        let input = r#"apiVersion: v1
kind: Pod
metadata:
  name: web
  namespace: default
  creationTimestamp: "2026-05-26T00:00:00Z"
  resourceVersion: "12345"
  uid: abc-def-ghi
  managedFields:
  - manager: kubectl
    operation: Update
    apiVersion: v1
    time: "2026-05-26T00:00:00Z"
    fieldsType: FieldsV1
    fieldsV1:
      f:spec:
        f:containers: {}
spec:
  containers:
  - name: web
    image: nginx:latest
status:
  phase: Running
"#;
        let out = compress(input);
        assert!(out.contains("name: web"));
        assert!(out.contains("phase: Running"));
        assert!(!out.contains("managedFields"));
        assert!(!out.contains("creationTimestamp"));
        assert!(out.len() < input.len() / 2);
    }

    #[test]
    fn yaml_unrecognised_passes_through() {
        let input = "key1: value1\nkey2: value2\nkey3: value3\n";
        assert_eq!(compress(input), input);
    }
}
