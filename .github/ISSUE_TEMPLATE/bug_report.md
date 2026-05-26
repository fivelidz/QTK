---
name: Bug report
about: Something QTK does is wrong, broken, or unexpected
labels: bug
---

## Summary

<!-- One sentence: what's broken? -->

## Environment

- QTK version (or commit SHA):
- opencode version (run `opencode --version` in your project):
- Bun version (`bun --version`):
- Rust toolchain version (`rustc --version`), if you built the sidecar:
- OS / arch (e.g. Linux x86_64, macOS arm64):

## Steps to reproduce

1.
2.
3.

## Expected vs actual

**Expected:**

**Actual:**

## Diagnostic data

- Output of `bun run packages/qtk-plugin/src/cli/gain.ts --all`:
  ```
  ```
- If a specific compressor misbehaves, contents of
  `<project>/.opencode/qtk-tee/<call-id>.log` for the affected call (REDACT any
  secrets! QTK does this automatically on write, but double-check):
  ```
  ```
- If the sidecar crashed, output of `qtk-core --version` and the relevant
  lines from your terminal's stderr where `[qtk] sidecar crashed` appeared:
  ```
  ```

## Anything else?

<!-- Workarounds you tried, related issues, suspected fixes, screenshots, etc. -->
