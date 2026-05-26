# QTK Roadmap

> Phase-by-phase plan. Each phase is independently shippable — earlier
> phases must work alone before later ones become useful.

**Status snapshot (2026-05-26):**

| Phase | Description                                  | Status        |
| ----- | -------------------------------------------- | ------------- |
| 0     | Repo bootstrap                               | ✅ done       |
| 1     | TS-only MVP plugin (9 compressors)           | ✅ done       |
| 2     | TOML filter DSL + RTK import                 | ✅ done       |
| 3     | Rust sidecar (`qtk-core`) for heavy parsers  | ✅ done       |
| —     | Public release (GitHub + qalarc.com + blog)  | 🟡 in flight |
| 4     | gmux/tauri dashboard widget                  | ⬜ planned    |
| 5     | Smart compaction integration                 | ⬜ planned    |
| 6     | Cross-agent extraction (maybe)               | ⬜ maybe      |

---

## Phase 0 — Repo bootstrap (✅ done)

- Brief, README, ARCHITECTURE, RTK-COMPARISON, SECURITY, ROADMAP docs
- Monorepo skeleton with `packages/{qtk-plugin, qtk-filters, qtk-core, qtk-dashboard}`
- Workspace `package.json`, gitignore, opencodeignore, license

---

## Phase 1 — TS-only MVP plugin (✅ done)

Working `qtk-plugin` that:

- Hooks `tool.execute.after` and compresses outputs
- Ships **9 production-quality compressors**:
  - `git status`, `git log`
  - `ls -la`
  - `rg <pattern>` / `grep -r`
  - `cargo test` failures-only
  - `pytest` failures-only
  - **`Read` tool** (200+ line files → outline)
  - **`Grep` tool** (10+ files → grouped)
  - **`Glob` tool** (50+ paths → clustered)
- Session dedup cache that catches identical-output repeated calls
- Tee fallback to `.opencode/qtk-tee/` with strict 0o600 perms
- SQLite stats tracker
- Circuit breaker on compressor failures
- Plugin loads cleanly into opencode via `file://.opencode/plugin/qtk/`

### Deliverables — all shipped

- [x] `packages/qtk-plugin/src/index.ts` — plugin entry point
- [x] `packages/qtk-plugin/src/{types,registry,config,cache,tee,stats,estimator,circuit-breaker}.ts`
- [x] `packages/qtk-plugin/src/compressors/{git,ls,rg,cargo,pytest}.ts`
- [x] `packages/qtk-plugin/src/tools/{read,grep,glob}.ts`
- [x] `packages/qtk-plugin/test/compressors.test.ts` — 40 tests, 92 assertions
- [x] `scripts/install-into-opencode.ts` — symlink + jsonc edit + smoke test
- [x] `scripts/benchmark.ts` — measure compression ratios and p50/p90/p99 latency
- [x] `qtk gain` CLI — prints session-totals summary

### Acceptance criteria — met

- ✅ Plugin loads with no errors or warnings
- ✅ Compressors achieve ≥ 60% reduction on the fixture corpus
- ✅ Median additional latency per tool call: well under 5 ms (most under 100µs)
- ✅ p99 additional latency: well under 20 ms (max ~1.2 ms on real cases)
- 🟡 Real 30-minute session token reduction: needs live install measurement
- ✅ All compressors handle empty / huge / binary input without crashing
- ✅ Forcing a compressor to throw causes fallback to original output
- ✅ All tee files written are mode 0o600, owned by user only
- ✅ `qtk-stats.sqlite` created on first compression with proper schema

---

## Phase 2 — TOML filter DSL + RTK filter import (✅ done)

Goal: let users add per-project compressors without writing TypeScript.

### Deliverables — all shipped

- [x] `packages/qtk-plugin/src/dsl/parser.ts` — hand-written TOML parser
- [x] `packages/qtk-plugin/src/dsl/spec.ts` — spec validator + regex compilation
- [x] `packages/qtk-plugin/src/dsl/runtime.ts` — compileFilter(spec) → Compressor
- [x] `packages/qtk-plugin/src/dsl/loader.ts` — scans `.opencode/qtk/filters/*.toml`
- [x] `packages/qtk-plugin/src/dsl/watcher.ts` — hot-reload via fs.watch + 250 ms debounce
- [x] Registry: `prepend()` + `replaceUserCompressors()` for DSL integration
- [x] `scripts/import-rtk-filters.ts` — local-checkout import (no network code) with attribution
- [x] Documentation: `docs/FILTER-DSL.md` — full reference of supported keys
- [x] Tests: 39 DSL tests added (parser, spec, runtime, loader, end-to-end)

### Acceptance criteria — met

- ✅ A user can drop a new TOML file into `.opencode/qtk/filters/` and see the
  next matching tool call get compressed without restarting opencode
- ✅ Invalid TOML files log a warning but don't break QTK
- ✅ The DSL runtime achieves competitive performance — 98.2% reduction on
  `kubectl get pods` at p99 1.17 ms, same ballpark as hand-written TS
- 🟡 RTK filter import: pipeline works; haven't yet bulk-imported the 50+
  corpus (requires `git clone rtk-ai/rtk` + run script)

---

## Phase 3 — Rust sidecar `qtk-core` (✅ done)

Goal: handle heavy parsers (XML, JSON, YAML, terraform plan) where Rust
regex + streaming parsers are materially faster and more memory-safe than
JS regex.

### Deliverables — all shipped

- [x] `packages/qtk-core/Cargo.toml` + `src/main.rs` — Rust binary reading
      NDJSON on stdin, writing NDJSON on stdout
- [x] `packages/qtk-core/src/parsers/{junit,terraform,kubectl,cargo_json}.rs`
      — four heavy parsers
- [x] `packages/qtk-core/src/protocol.rs` — wire format types (serde)
- [x] `packages/qtk-plugin/src/sidecar/client.ts` — long-lived subprocess
      client: spawn, NDJSON in/out, per-request promise correlation by id,
      health-check, auto-restart up to maxRestarts, then permanently disable
- [x] `packages/qtk-plugin/src/sidecar/locator.ts` — finds the qtk-core
      binary (env var, bundled, dev-checkout, PATH)
- [x] `packages/qtk-plugin/src/sidecar/compressors.ts` — async-Compressor
      wrappers that match shell commands and route through the client
- [x] Plugin integration: sidecar runs BEFORE the sync registry; if it's
      unavailable, the sync TS compressors run as normal
- [x] Tests:
  - Rust: 22 unit tests in `packages/qtk-core/src/parsers/*.rs`
  - TS: 10 integration tests that spawn the real binary
        (`packages/qtk-plugin/test/sidecar.test.ts`)
- [x] `scripts/benchmark-sidecar.ts` — cold-start latency + throughput
      benchmark
- [x] `unsafe_code = "deny"` enforced in Cargo.toml

### Acceptance criteria — exceeded

| Criterion                                | Target          | Actual                |
| ---------------------------------------- | --------------- | --------------------- |
| Cold start (spawn → hello → first call)  | ≤ 30 ms         | **2.4–6.7 ms**        |
| Throughput (serial, one client)          | ≥ 5,000 ops/s   | **7.7k–13.7k ops/s**  |
| Throughput (concurrent batches)          | bonus           | **10.5k–33k ops/s**   |
| Compression ratios on heavy parsers      | "materially better" | **63.5–97.3% saved** |
| Graceful degradation if binary missing   | required        | ✅ falls back to TS    |
| Auto-restart on subprocess crash         | required        | ✅ up to 3× then disabled |
| Compressor list reported via hello msg   | required        | ✅                     |

### What's NOT done in Phase 3

- ⬜ Bundle the binary into a Tauri externalBin (Phase 4 territory)
- ⬜ npm-distribution path (would need a postinstall script that downloads the
  right binary per OS — out of scope for now; we ship as a Cargo build)

---

## Public release — GitHub + qalarc.com + blog (🟡 in flight)

Before any code-level Phase 4 work, surface the project publicly.

### Deliverables

- [ ] Sanitize repo of personal/private references (done — see `PUBLIC.md`)
- [ ] Push to `github.com/fivelidz/QTK` (or chosen handle), MIT-licensed
- [ ] Add project card to `qalarc.com/projects/` (projects.json entry)
- [ ] Write a layman + technical blog post pair for qalarc-blog
- [ ] Tag a `v0.3.0` release matching the Phase 3 cutpoint
- [ ] (Optional) Publish `@qtk/plugin` to npm

### Acceptance criteria

- A first-time visitor can read the README and understand:
  - What QTK is
  - Why it exists (the RTK comparison)
  - How to install it (3-step quickstart)
  - Concrete savings numbers from the benchmark suite
- The blog post pair (layman + technical) explains:
  - "Why am I paying for the same `git status` 50 times this session?"
  - The deterministic-compression thesis, with measured savings
  - The Rust-sidecar design with cold-start + throughput numbers

---

## Phase 4 — gmux/tauri dashboard widget (⬜ planned, target: 3 days)

A live UI showing what QTK is doing.

### Deliverables

- [ ] `packages/qtk-dashboard/` — UI components (SolidJS, matching opencode's
      `packages/desktop` stack)
- [ ] Tauri-side IPC: QTK plugin emits events on each compression;
      dashboard subscribes via SSE or Tauri event
- [ ] Per-pane status bar widget: `tokens saved: 47K (-78%)`
- [ ] Drill-down inspector modal:
  - List of recent compressions with raw/compact side-by-side
  - "View tee fallback" button → opens the saved raw log
  - Filter by tool, command, ratio
- [ ] Aggregate view: per-project totals, top compressors, savings over time

### Acceptance criteria

- Widget renders in real-time as the agent runs (< 500 ms after each call)
- No measurable impact on agent latency from event emission
- Works in both `packages/tauri` (existing) and gmux's planned Tauri app
  (when it ships)

---

## Phase 5 — Smart compaction integration (⬜ planned, target: 3 days)

Replace opencode's "[output pruned]" with "[summarised: 4 prior git status
calls, no changes since 14:18]" when the rolling-window pruner kicks in.

### Deliverables

- [ ] Patch to `packages/opencode/src/session/compaction.ts` (PR upstream)
- [ ] qtk-plugin exposes a `summariseOldOutput(toolCalls)` function that
      compaction calls
- [ ] One LLM call per compaction event to generate the human-readable
      summary (we accept the small token cost in exchange for retaining
      meaningful context)
- [ ] Configurable: which compaction strategy to use — "null" (existing),
      "summarise" (LLM), or "deterministic-summarise" (template-based,
      no LLM)

### Acceptance criteria

- After a compaction event, the LLM can still answer "what was the git
  status earlier in this session?" accurately, based on the summary
- Compaction cost ≤ 200 tokens per event (whether template or LLM)
- Total context retained after compaction grows by ≤ 5% vs nulling
  (because we're adding summaries; trade-off is the model retains useful
  state)

---

## Phase 6 — Cross-agent extraction (⬜ maybe never)

If QTK turns out to be valuable beyond opencode, extract the core
compressor library to be agent-agnostic. Then write adapters:

- Claude Code (PreToolUse hook)
- Cursor
- Gemini CLI
- Generic shell wrapper

This is RTK's territory. We'd only do it if there's clear demand and our
architecture genuinely makes sense outside opencode — which is not
obvious. RTK already exists for this need.

**Phase 6 is more of a maybe than a plan.** Don't count on it.

---

## Cross-cutting work

### Documentation

- [x] BRIEF.md (Phase 0)
- [x] README.md (Phase 0)
- [x] ARCHITECTURE.md (Phase 0)
- [x] RTK-COMPARISON.md (Phase 0)
- [x] SECURITY.md (Phase 0)
- [x] ROADMAP.md (Phase 0)
- [x] FILTER-DSL.md (Phase 2)
- [x] INTEGRATION.md (Phase 1)
- [x] CONTRIBUTING.md (Phase 1)
- [ ] PUBLIC.md (pre-release) — what's in the public version, licence story, etc.

### Testing

- [x] Unit tests per compressor with golden fixtures (Phase 1)
- [x] Adversarial input tests (Phase 1)
- [x] Benchmark suite — `scripts/benchmark.ts` (Phase 1)
- [x] DSL parser + runtime tests (Phase 2)
- [x] Rust unit tests (Phase 3)
- [x] TS-integration tests that spawn the real binary (Phase 3)
- [x] Sidecar benchmark — `scripts/benchmark-sidecar.ts` (Phase 3)
- [ ] Integration test that runs opencode in a sandbox with QTK installed
      and replays a recorded session (Phase 4)
- [ ] Long-running smoke test — 24-hour session in a sandbox (Phase 4)

### Release

- [x] Tag `v0.1.0` once Phase 1 acceptance criteria are met — internal tag
- [ ] Tag `v0.3.0` covering Phase 1 + 2 + 3 — coincides with first GitHub push
- [ ] Publish `@qtk/plugin` to npm under MIT license
- [ ] Announce on the opencode community channels
- [ ] Submit PR to opencode docs adding a "QTK" section

---

## What we're NOT doing

To keep the project scoped:

- **No general-purpose CLI proxy.** RTK already exists.
- **No Windows-specific code paths.** opencode runs on Linux/macOS.
- **No paid tier, no SaaS, no telemetry endpoint.** Local-only forever.
- **No automatic filter updates from a central repo.** Filters live in the
  user's project. No silent updates.
- **No LLM-based compression in the hot path.** The whole thesis is that
  this is unnecessary. Compaction summarisation is Phase 5 only.
- **No GUI installer.** Symlink + JSONC edit. That's the install.
- **No network code in qtk-core.** The Rust sidecar has zero HTTP deps;
  it only ever reads stdin and writes stdout.

---

## Decision log

Tracking design decisions and their justifications.

| Date       | Decision                                                    | Justification                                                                                                |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 2026-05-20 | Compress on `tool.execute.after`, not `tool.execute.before` | See ARCHITECTURE.md §1 — output-side compression covers all tools, zero prompt overhead, no double-wrap risk |
| 2026-05-20 | TypeScript Phase 1, Rust sidecar Phase 3                    | In-process JS wins on latency despite slower regex; Rust only for genuinely expensive parsers                |
| 2026-05-20 | No network code, ever                                       | Strongest possible privacy story, removes entire class of risks                                              |
| 2026-05-20 | Tee files 0o600, dir 0o700, no env override                 | Direct response to RTK audit findings §3.1 and §3.2                                                          |
| 2026-05-20 | Session cache is in-memory only in Phase 1                  | Simpler, faster; per-project persistence comes in Phase 2 if useful                                          |
| 2026-05-20 | Adopt RTK's TOML DSL format                                 | Apache 2.0 → MIT compatible; we get 100 filters for free                                                     |
| 2026-05-20 | Phase 5 (smart compaction) is its own phase                 | Requires upstream PR to opencode compaction code; landing that is a separate political/technical project     |
| 2026-05-26 | NDJSON protocol over stdin/stdout for qtk-core              | Trivial wire format; no JSON-RPC library needed; works with any subprocess-spawning host                     |
| 2026-05-26 | Sidecar is OPTIONAL, never required                         | Binary may not be available (no Rust toolchain, no prebuilt for arch); plugin must work as TS-only           |
| 2026-05-26 | Reframe public release as `opencode` plugin, not qalcode2   | qalcode2 is our private fork; the plugin actually works on any opencode-compatible host                      |
