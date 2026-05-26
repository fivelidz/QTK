<!--
Thanks for contributing! A few quick checks:

1. If you're adding a NEW compressor, please include both a fixture (real
   command output) and at least one passing test that demonstrates the
   compression ratio.

2. If you're adding a Rust parser, run BOTH `cargo fmt --all` AND
   `cargo clippy --release --all-targets -- -D warnings` locally before pushing.
   CI enforces both.

3. If you're touching the sidecar protocol, update `packages/qtk-core/src/protocol.rs`
   AND `packages/qtk-plugin/src/sidecar/types.ts` so the wire format matches on
   both sides.

4. If you're adding a feature that affects the savings sidecar JSON
   (`<project>/.opencode/qtk-savings.json`), bump `SAVINGS_SCHEMA_VERSION` in
   `src/savings-export.ts` so external consumers (gmux, third-party
   dashboards) can detect the change.
-->

## Summary

<!-- 1-2 lines: what does this change? -->

## Why

<!-- What's the motivation? Link any related issues. -->

## Type of change

- [ ] New compressor (TS or DSL)
- [ ] New Rust parser
- [ ] Bug fix
- [ ] Performance improvement
- [ ] Documentation
- [ ] Other (describe)

## Testing

- [ ] `bun test` passes locally
- [ ] `cd packages/qtk-core && cargo test --release` passes locally
- [ ] `cargo fmt --all -- --check` passes locally
- [ ] `cargo clippy --release --all-targets -- -D warnings` passes locally
- [ ] New tests cover the new behaviour (golden fixtures + adversarial inputs)
- [ ] Benchmark numbers from `bun run scripts/benchmark.ts` are no worse
      than baseline (paste in PR body if perf-sensitive)

## RTK relationship

<!--
QTK's core thesis comes from RTK. If your change touches the TOML DSL or
filter format, please consider whether RTK's existing syntax already covers
it — keeping RTK + QTK filters interchangeable is a project goal.

If your change is a new compressor and RTK has an equivalent, link the
RTK filter file in this PR so the reviewer can compare semantics.
-->

## Anything else?
