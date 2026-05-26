//! JUnit XML test-results compressor.
//!
//! Raw form (typical pytest/maven/jest CI output, often hundreds of KB):
//!
//! ```xml
//! <?xml version="1.0" encoding="UTF-8"?>
//! <testsuites>
//!   <testsuite name="tests.foo" tests="42" failures="2" errors="0" time="3.14">
//!     <testcase classname="tests.foo" name="test_a" time="0.01"/>
//!     <testcase classname="tests.foo" name="test_b" time="0.02">
//!       <failure message="AssertionError" type="AssertionError">
//!         Traceback (most recent call last):
//!           File "/x/y.py", line 42, in test_b
//!             assert 1 + 1 == 3
//!         AssertionError: assert 2 == 3
//!       </failure>
//!     </testcase>
//!     ...
//!   </testsuite>
//! </testsuites>
//! ```
//!
//! Compressed form (one-liner per suite, FAILED tests listed with first
//! assertion line of their failure trace):
//!
//! ```text
//! tests.foo: 40/42 passed (3.14s) — 2 FAILED:
//!   test_b: assert 2 == 3
//!   test_c: NullPointerException at Foo.java:17
//! ```
//!
//! Strategy: stream-parse the XML so we don't have to materialise the
//! tree. `quick-xml` is event-based which is perfect for this.

use quick_xml::events::Event;
use quick_xml::Reader;

#[must_use]
pub fn compress(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    // Cheap pre-check: anything that doesn't look like XML, pass through.
    if !input.contains("<testsuite") && !input.contains("<testsuites") {
        return input.to_string();
    }

    let mut reader = Reader::from_str(input);
    reader.config_mut().trim_text(true);

    let mut suites: Vec<Suite> = Vec::new();
    let mut cur_suite: Option<Suite> = None;
    let mut cur_case: Option<Case> = None;
    let mut in_failure = false;
    let mut failure_buf = String::new();
    let mut buf = Vec::new();

    // Helper closure to handle the start of an element (used by both Start
    // and Empty events). Returns whether `in_failure` should now be true.
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                handle_open(
                    &e,
                    &mut cur_suite,
                    &mut cur_case,
                    &mut in_failure,
                    &mut failure_buf,
                );
            }
            Ok(Event::Empty(e)) => {
                // Self-closing tag — open AND close in one go
                handle_open(
                    &e,
                    &mut cur_suite,
                    &mut cur_case,
                    &mut in_failure,
                    &mut failure_buf,
                );
                handle_close(
                    e.name().as_ref(),
                    &mut suites,
                    &mut cur_suite,
                    &mut cur_case,
                    &mut in_failure,
                    &failure_buf,
                );
            }
            Ok(Event::End(e)) => {
                handle_close(
                    e.name().as_ref(),
                    &mut suites,
                    &mut cur_suite,
                    &mut cur_case,
                    &mut in_failure,
                    &failure_buf,
                );
            }
            Ok(Event::Text(t)) if in_failure => {
                if let Ok(s) = t.unescape() {
                    if failure_buf.is_empty() {
                        failure_buf = s.into_owned();
                    } else {
                        failure_buf.push('\n');
                        failure_buf.push_str(&s);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return input.to_string(),
            _ => {}
        }
        buf.clear();
    }

    if suites.is_empty() {
        return input.to_string();
    }

    let mut out = String::with_capacity(256);
    let mut total_tests = 0u32;
    let mut total_failures = 0u32;
    let mut total_errors = 0u32;
    let mut total_skipped = 0u32;
    for s in &suites {
        total_tests += s.tests;
        total_failures += s.failures;
        total_errors += s.errors;
        total_skipped += s.skipped;
    }

    let passed = total_tests
        .saturating_sub(total_failures)
        .saturating_sub(total_errors)
        .saturating_sub(total_skipped);
    out.push_str(&format!(
        "{passed}/{total_tests} passed",
    ));
    if total_failures > 0 {
        out.push_str(&format!(", {total_failures} failed"));
    }
    if total_errors > 0 {
        out.push_str(&format!(", {total_errors} errored"));
    }
    if total_skipped > 0 {
        out.push_str(&format!(", {total_skipped} skipped"));
    }
    out.push_str(" across ");
    out.push_str(&suites.len().to_string());
    out.push_str(" suite(s)\n");

    // Then one line per failed case (capped at 20 total — over that we
    // collapse the rest)
    const MAX_FAILS_SHOWN: usize = 20;
    let mut shown = 0;
    let mut remaining = 0;
    for s in &suites {
        for c in &s.failed_cases {
            if shown >= MAX_FAILS_SHOWN {
                remaining += 1;
                continue;
            }
            let cls = if c.classname.is_empty() {
                s.name.as_str()
            } else {
                c.classname.as_str()
            };
            out.push_str(&format!("  {cls}.{}: {}\n", c.name, c.failure));
            shown += 1;
        }
    }
    if remaining > 0 {
        out.push_str(&format!("  ... and {remaining} more failed test(s)\n"));
    }

    // Trim trailing newline so callers' length checks behave
    if out.ends_with('\n') {
        out.pop();
    }
    out
}

fn handle_open(
    e: &quick_xml::events::BytesStart<'_>,
    cur_suite: &mut Option<Suite>,
    cur_case: &mut Option<Case>,
    in_failure: &mut bool,
    failure_buf: &mut String,
) {
    match e.name().as_ref() {
        b"testsuite" => {
            let mut s = Suite::default();
            for attr in e.attributes().flatten() {
                match attr.key.as_ref() {
                    b"name" => s.name = attr_str(&attr.value),
                    b"tests" => s.tests = attr_num(&attr.value),
                    b"failures" => s.failures = attr_num(&attr.value),
                    b"errors" => s.errors = attr_num(&attr.value),
                    b"skipped" => s.skipped = attr_num(&attr.value),
                    b"time" => s.time = attr_str(&attr.value),
                    _ => {}
                }
            }
            *cur_suite = Some(s);
        }
        b"testcase" => {
            let mut c = Case::default();
            for attr in e.attributes().flatten() {
                match attr.key.as_ref() {
                    b"name" => c.name = attr_str(&attr.value),
                    b"classname" => c.classname = attr_str(&attr.value),
                    _ => {}
                }
            }
            *cur_case = Some(c);
        }
        b"failure" | b"error" => {
            *in_failure = true;
            failure_buf.clear();
            for attr in e.attributes().flatten() {
                if attr.key.as_ref() == b"message" {
                    *failure_buf = attr_str(&attr.value);
                    break;
                }
            }
        }
        _ => {}
    }
}

fn handle_close(
    name: &[u8],
    suites: &mut Vec<Suite>,
    cur_suite: &mut Option<Suite>,
    cur_case: &mut Option<Case>,
    in_failure: &mut bool,
    failure_buf: &str,
) {
    match name {
        b"testsuite" => {
            if let Some(s) = cur_suite.take() {
                suites.push(s);
            }
        }
        b"testcase" => {
            if let (Some(c), Some(s)) = (cur_case.take(), cur_suite.as_mut()) {
                if !c.failure.is_empty() {
                    s.failed_cases.push(c);
                }
            }
        }
        b"failure" | b"error" => {
            *in_failure = false;
            if let Some(c) = cur_case.as_mut() {
                c.failure = first_meaningful_line(failure_buf);
            }
        }
        _ => {}
    }
}

#[derive(Default, Debug)]
struct Suite {
    name: String,
    tests: u32,
    failures: u32,
    errors: u32,
    skipped: u32,
    time: String,
    failed_cases: Vec<Case>,
}

#[derive(Default, Debug)]
struct Case {
    name: String,
    classname: String,
    /// First meaningful line of failure trace; empty if test passed.
    failure: String,
}

fn attr_str(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn attr_num(bytes: &[u8]) -> u32 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Pick the first non-blank, non-trace-noise line from a failure body.
/// Trims off "Traceback (most recent call last):" boilerplate and goes
/// for the assertion line / exception name.
fn first_meaningful_line(text: &str) -> String {
    let mut best: Option<&str> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("Traceback") {
            continue;
        }
        if t.starts_with("File \"") && t.contains("line") {
            continue;
        }
        // Prefer lines that look like assertions or exceptions
        if t.contains("Error")
            || t.contains("Exception")
            || t.starts_with("assert")
            || t.starts_with("E ")
        {
            return clean(t);
        }
        if best.is_none() {
            best = Some(t);
        }
    }
    best.map_or_else(|| "(no detail)".to_string(), clean)
}

fn clean(s: &str) -> String {
    // Cap at 200 chars — failures with multi-line shrapnel
    if s.len() > 200 {
        let mut out = s[..200].to_string();
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_passes_through() {
        assert_eq!(compress(""), "");
    }

    #[test]
    fn non_xml_passes_through() {
        let input = "hello world this is not xml";
        assert_eq!(compress(input), input);
    }

    #[test]
    fn malformed_xml_passes_through() {
        let input = "<testsuite name=\"x\"><testcase ";
        assert_eq!(compress(input), input);
    }

    #[test]
    fn parses_passing_suite() {
        let xml = r#"<?xml version="1.0"?>
<testsuites>
  <testsuite name="alpha" tests="3" failures="0" errors="0" skipped="0" time="0.5">
    <testcase classname="alpha" name="t1" time="0.1"/>
    <testcase classname="alpha" name="t2" time="0.2"/>
    <testcase classname="alpha" name="t3" time="0.2"/>
  </testsuite>
</testsuites>"#;
        let out = compress(xml);
        assert!(out.contains("3/3 passed"));
        assert!(out.len() < xml.len());
    }

    #[test]
    fn parses_failing_suite_with_failure_lines() {
        let xml = r#"<?xml version="1.0"?>
<testsuites>
  <testsuite name="alpha" tests="3" failures="2" errors="0" skipped="0">
    <testcase classname="alpha" name="t1"/>
    <testcase classname="alpha" name="t2">
      <failure message="assert 1 == 2" type="AssertionError">
        Traceback (most recent call last):
          File "/x/y.py", line 1, in t2
        AssertionError: assert 1 == 2
      </failure>
    </testcase>
    <testcase classname="alpha" name="t3">
      <failure message="NullPointerException at Foo.java:42" type="NullPointerException"/>
    </testcase>
  </testsuite>
</testsuites>"#;
        let out = compress(xml);
        assert!(out.contains("1/3 passed"));
        assert!(out.contains("2 failed"));
        assert!(out.contains("t2: assert 1 == 2"));
        assert!(out.contains("t3: NullPointerException"));
        assert!(out.len() < xml.len());
    }

    #[test]
    fn compresses_realistic_ci_output() {
        let mut cases = String::new();
        for i in 0..40 {
            cases.push_str(&format!(
                "    <testcase classname=\"alpha.module.submodule\" name=\"test_passing_case_{i}\" time=\"0.012\"/>\n",
            ));
        }
        cases.push_str(r#"    <testcase classname="alpha.module.submodule" name="test_assertion_failure"><failure message="assert 4 == 5"/></testcase>"#);
        let input = format!(
            "<?xml version=\"1.0\"?>\n<testsuites>\n  <testsuite name=\"alpha\" tests=\"41\" failures=\"1\" errors=\"0\">\n{cases}\n  </testsuite>\n</testsuites>"
        );
        let out = compress(&input);
        eprintln!("input={} output={}", input.len(), out.len());
        eprintln!("OUT:\n{out}");
        assert!(out.len() < input.len());
        assert!(out.contains("40/41 passed"));
    }

    #[test]
    fn caps_many_failures() {
        let mut xml = String::from(r#"<?xml version="1.0"?>
<testsuites><testsuite name="big" tests="100" failures="50" errors="0" skipped="0">"#);
        for i in 0..50 {
            xml.push_str(&format!(
                r#"<testcase classname="big" name="case_{i}"><failure message="boom {i}"/></testcase>"#,
            ));
        }
        xml.push_str("</testsuite></testsuites>");
        let out = compress(&xml);
        assert!(out.contains("more failed test"));
        assert!(out.len() < xml.len());
    }
}
