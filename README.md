# QTK — Qalarc Token Killer

> Also a backronym for **Q**uantised **T**oken **K**iller — same idea, more descriptive.

**Deterministic token compression for opencode-based AI coding agents.**

> ## Read this first
>
> [**RTK (Rust Token Killer)**](https://github.com/rtk-ai/rtk) is the
> mature, production-grade project for deterministic token compression.
> 54k+ GitHub stars, 185 releases, supports 13 AI coding tools across
> Linux/macOS/Windows, ships a 100+ command filter corpus. Built by
> Patrick Szymkowiak, Florian Bruniaux, Adrien Eppling and the RTK
> community. Licensed Apache-2.0.
>
> **If you're using Claude Code, Cursor, Gemini CLI, GitHub Copilot,
> Codex, Windsurf, Cline, Roo Code, OpenClaw, Hermes, Kilo Code, or
> Google Antigravity — use [RTK](https://rtk-ai.app).**
>
> **QTK is a narrow opencode-specific spiritual sibling.** It exists
> because opencode's plugin surface lets us hook `tool.execute.after`
> in-process, which removes the per-call subprocess fork and the
> system-prompt overhead any external-CLI tool necessarily carries.
> That trade-off only makes sense if you're already committed to
> opencode. The whole project is downstream of RTK — RTK proved the
> thesis, ships the canonical filter corpus, and is broader and more
> battle-tested. See [`docs/RTK-COMPARISON.md`](docs/RTK-COMPARISON.md)
> for the architectural diff.

QTK is an [opencode](https://github.com/sst/opencode) plugin that silently
compresses tool outputs (`git status`, `ls -la`, `rg`, `pytest`, `cargo test`,
`Read`/`Grep`/`Glob`, `kubectl get -o yaml`, `terraform plan`, JUnit XML, …)
**before they reach the model's context window**. No LLM. No prompt
injection. ~99% reduction on the worst offenders, sub-millisecond p99
latency, zero changes to how you use opencode.

<!-- TODO: insert a screenshot of the qtk gain output once we have a real session -->

```
QTK active — 13 compressors registered
  read-tool, grep-tool, glob-tool, git-status, git-log, ls, rg, pytest, cargo,
  sidecar:terraform-plan, sidecar:kubectl-structured, sidecar:cargo-json,
  sidecar:junit-xml

Session summary (after 3 hrs of agent work):
  4,872 tool calls compressed
  1,247,392 tokens saved (-71.3%)
  $4.92 of Claude tokens not spent
```

[![tests](https://img.shields.io/badge/tests-111%20passing-brightgreen)](#tests)
[![bench](https://img.shields.io/badge/p99%20latency-%3C1.2ms-brightgreen)](#benchmarks)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Why this exists

A typical opencode "yolo" session burns **~120,000 tokens** of context on
mechanically-compressible tool output:

- `git status` porcelain (40+ lines for a typical work-in-progress)
- `ls -la` columns of `drwxr-xr-x 5 user group 4096 May 20 14:23 ...`
- `rg <pattern>` repeated `path:line:match` clusters
- `cargo test` "Compiling N crates" verbosity
- `npm install` progress bars and "added 412 packages" trees
- `kubectl get pods -o yaml` (multi-KB per pod, mostly `managedFields`)
- `terraform plan` showing 50 resources where 3 changed

**None of this needs an LLM to compress.** A few hundred lines of
hand-written parsers reduce these outputs by 60–99% with zero quality loss
for the model.

[RTK](https://github.com/rtk-ai/rtk) proved the thesis at scale with a
100+ filter corpus. QTK is the in-agent version of the same idea:

| | RTK | QTK |
|---|---|---|
| **Where it lives** | External CLI binary | opencode plugin (in-process) |
| **Tools covered** | `Bash` only | `Bash` + `Read` + `Grep` + `Glob` + MCP |
| **Integration cost** | Hundreds of tokens in CLAUDE.md so the model knows to call `rtk <cmd>` | Zero — the model is unaware QTK exists |
| **Per-call overhead** | Subprocess fork per bash invocation (5–15 ms) | In-process TS (median 30µs) |
| **Heavy parsers** | Same Rust binary as everything | Optional `qtk-core` sidecar, fires only for XML/YAML/JSON |
| **Cross-call dedup** | None | Session cache: `<qtk-unchanged tool=bash since=14s_ago>` |
| **User filters** | PR upstream | `.opencode/qtk/filters/*.toml`, hot-reloaded |
| **Telemetry** | Opt-in, phones home | 100% local SQLite, zero network code |

RTK is the right answer for everyone running an agent that isn't opencode.
**QTK is the right answer if you use opencode** (or qalcode2, or any
opencode-compatible fork).

---

## Show me the numbers

```
QTK benchmark suite (200 iters per case)

name                                            in     out   saved      p50      p90      p99
---------------------------------------------------------------------------------------------------
git status (real opencode-fork output)         939     542   42.3%     17µs     31µs    110µs
git status (synthetic large, 100 files)       4.4k    1.3k   70.8%     55µs     93µs    178µs
rg (50 matches across 10 files)               3.6k    2.3k   36.6%     37µs     58µs    261µs
Read tool (500-line file)                    16.4k     206   98.7%    221µs    343µs   1.11ms
DSL: kubectl get pods (60 rows)               4.2k      73   98.2%    114µs    188µs   1.17ms
Glob (45 paths in 3 clusters)                 1.3k     360   73.1%     32µs     50µs    166µs
```

```
qtk-core sidecar benchmark (Rust, NDJSON pipe)

Cold start (spawn → hello → first compress): 2.4 ms ✅ (target ≤ 30 ms)

Throughput (serial, one client):
case                       in      out   saved      p50      p99      ops/s
--------------------------------------------------------------------------------
terraform-plan           3.3k      664   79.8%     64µs    739µs      10,102
kubectl-json             3.9k     1.4k   63.5%     95µs    848µs       7,721
cargo-json               5.0k      134   97.3%     56µs    748µs      11,316
junit-xml                2.8k      150   94.6%     43µs    729µs      13,732

Throughput (concurrent batches of 50):
  terraform-plan: 17,551 ops/s    cargo-json: 22,470 ops/s
  kubectl-json:   10,512 ops/s    junit-xml:  32,994 ops/s
```

---

## What QTK does, in 60 seconds

1. **opencode** runs a tool (e.g. `Bash("git status")`) and gets raw output back.
2. The `tool.execute.after` hook fires. QTK intercepts.
3. QTK looks up a matching compressor:
   - First: 4 async **sidecar compressors** (terraform plan, kubectl YAML/JSON, cargo JSON, JUnit XML) — these route to the Rust `qtk-core` subprocess. If the sidecar isn't available, they pass through.
   - Then: any **DSL filter** in `.opencode/qtk/filters/*.toml` matching the command.
   - Then: the **9 built-in TS compressors** (`git-status`, `git-log`, `ls`, `rg`, `pytest`, `cargo`, `Read`, `Grep`, `Glob`).
4. The compressor runs (median ≪ 1 ms). Output is replaced with a compact form wrapped in `<qtk-compressed compressor=git-status orig_lines=42 ratio=0.18 tee=qtk-tee/abc123.log>...</qtk-compressed>`.
5. The model sees the compact output. The raw output is saved to a tee file with mode `0o600` for forensic recovery if needed.
6. Every compression is logged to a per-project SQLite DB; `bun run qtk-plugin/src/cli/gain.ts` prints session totals.

**The model never knows QTK exists.** No CLAUDE.md injection. No command rewriting. No special tool wrappers.

---

## What's in here

### Phase 1: 9 built-in TypeScript compressors

Hand-written, sub-100µs median latency:

- **`git status`** — porcelain → `branch=main (up to date with origin/main)\nstaged (3): modified foo.ts, modified bar.ts, new baz.ts\nunstaged (1): modified qux.ts`
- **`git log`** — multi-line commits → one-liners with `<hash> <date> <author>: <subject>`
- **`ls -la`** — long-format → sorted by type with size/mtime; falls back to grouped-by-extension for large flat listings
- **`rg`** / **`grep -r`** — `5 matches across 3 files:\n  src/foo.ts (3 matches)\n  L17: ...`
- **`pytest`** — passing → just the summary; failing → keeps FAILED lines + first 8 trace lines
- **`cargo test`/`cargo build`/`cargo clippy`** — strips Compiling-noise, keeps errors
- **`Read` tool** — > 200 lines → signature outline (imports, function/class/interface/export lines)
- **`Grep` tool** — multi-file results → grouped by file, top match shown
- **`Glob` tool** — > 30 paths → clustered by 2-deep common directory prefix

### Phase 2: TOML filter DSL

Per-project compressors without writing TypeScript. Drop a file into `.opencode/qtk/filters/`:

```toml
# .opencode/qtk/filters/kubectl-pods.toml
command = "kubectl get pods"
strip = ["^NAME\\s+READY"]
match = "^(?<name>\\S+)\\s+(?<ready>\\d+/\\d+)\\s+(?<status>\\S+)\\s+(?<restarts>\\d+)\\s+(?<age>\\S+)$"
group_by = "status"
template = "{status}: {n} ({joined.name})"
header = "{matched} pods total"
truncate = 30
```

Pipeline: `pass_through_if → strip → dedupe → match → group_by → template → header/footer → truncate`. Regexes compiled at load time. Hot-reloaded with 250 ms debounce. Errors per-file isolated.

Also ships `scripts/import-rtk-filters.ts` to translate a local `git clone rtk-ai/rtk` into QTK format (strips RTK-only keys, adds attribution headers, validates against QTK's spec).

### Phase 3: Rust sidecar `qtk-core`

For heavy parsers where Rust's streaming parsers beat anything you'd write in JS:

- **JUnit XML** — quick-xml streaming, picks the first meaningful failure line per test, caps to 20 failures shown
- **Terraform plan** — regex-scan for resource headers, extracts the changed attributes for `~ updated in-place` resources
- **kubectl `get -o yaml`/`-o json`** — serde_json for JSON, conservative line-based pruning for YAML (drops `managedFields`, `resourceVersion`, etc.)
- **Cargo `--message-format=json`** — collapses N artifact lines into a count, promotes errors with `file:line:col`

NDJSON protocol over stdin/stdout (one JSON object per line). Long-lived subprocess per session. The TS client:
- Auto-restarts up to 3× on crash, then permanently disables
- Per-request 1-second timeout, falls back to the TS path on stall
- Lazy startup — first matching call awaits the binary; everything else passes through immediately
- **If the binary isn't installed, everything still works** — QTK silently uses TS-only

---

## Safety + privacy

- **No network code anywhere.** The Rust crate has no HTTP deps. The TS plugin has no HTTP deps. We literally cannot phone home.
- **Tee files are mode `0o600`, directory `0o700`.** Path-confined to the project root.
- **Secrets-aware redaction** on tee files: AWS access keys, GitHub PATs, OpenAI keys (`sk-...`), Slack tokens (`xoxb-...`), `Bearer ...` headers — all redacted before write.
- **`unsafe_code = "deny"`** in the Rust crate.
- **Circuit breaker:** any compressor that throws 3× in a session is automatically disabled for the rest of the session.
- **Length-monotonicity guard:** if a compressor ever produces output ≥ its input, the original is returned. Compression should never make things worse.
- **Compressor panic in Rust is caught** (`catch_unwind`) — turns into an error response, doesn't kill the sidecar.
- **Config paths are project-rooted** — env-var overrides are deliberately NOT honoured (lesson from RTK's audit).

---

## Install

```bash
# 1. Clone + build
git clone https://github.com/fivelidz/QTK
cd QTK && bun install && bun run build

# 2. (Optional) Build the Rust sidecar
cd packages/qtk-core && cargo build --release && cd ../..

# 3. Symlink the plugin into your opencode project
mkdir -p /path/to/your/opencode-project/.opencode/plugin
ln -s "$PWD/packages/qtk-plugin" \
      /path/to/your/opencode-project/.opencode/plugin/qtk

# 4. Add to .opencode/opencode.jsonc:
#    "plugin": [ ..., "file://.opencode/plugin/qtk/src/index.ts" ]

# 5. Restart opencode
```

Or use the one-shot installer:

```bash
bun run scripts/install-into-opencode.ts /path/to/your/opencode-project
```

After install, check `[qtk] active — N compressors registered` in opencode's startup log. See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the full guide.

---

## Inspect what QTK is doing

```bash
bun run packages/qtk-plugin/src/cli/gain.ts

# Output:
# Session b1c2d3 (3h 14m):
#   1,247 calls compressed
#   originally 4,512,309 bytes / 1,128,077 tokens
#   compressed  1,289,432 bytes /   322,358 tokens
#   tokens saved:     805,719 (-71.4%)
#
# Top 10 commands by tokens saved:
#   read-tool                    283   1.2M    312k   847k saved (-73%)
#   git-status                   147   294k     58k   234k saved (-79%)
#   sidecar:kubectl-structured    34   421k     94k   327k saved (-77%)
#   ...
```

Or query the SQLite DB directly at `.opencode/qtk-stats.sqlite`.

---

## Architecture

```
opencode process
  └─ qtk-plugin (TypeScript)
      ├─ tool.execute.after hook
      ├─ Session cache (SHA-256 fingerprint, output-hash equality)
      │     → "<qtk-unchanged tool=bash since=14s_ago>"
      ├─ Async sidecar compressors (Phase 3)
      │     ├─ matches() → bash command pattern
      │     └─ compress() → NDJSON over stdin/stdout to qtk-core
      │           ↓
      │     packages/qtk-core (Rust binary, optional)
      │       ├─ junit-xml      (quick-xml streaming)
      │       ├─ terraform-plan (regex-scan)
      │       ├─ kubectl-yaml   (line-pruner)
      │       ├─ kubectl-json   (serde_json)
      │       └─ cargo-json     (NDJSON serde_json)
      ├─ DSL filters (Phase 2)
      │     ├─ Loaded from .opencode/qtk/filters/*.toml
      │     ├─ Hot-reloaded on file change (250ms debounce)
      │     └─ Pipeline: strip → dedupe → match → group_by → template → truncate
      ├─ Built-in TS compressors (Phase 1)
      │     git-status, git-log, ls, rg, pytest, cargo,
      │     read-tool, grep-tool, glob-tool
      ├─ Tee writer (.opencode/qtk-tee/<call-id>.log, 0o600)
      ├─ SQLite stats (.opencode/qtk-stats.sqlite)
      └─ Circuit breaker (auto-disables flaky compressor after 3 failures)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design,
[`docs/RTK-COMPARISON.md`](docs/RTK-COMPARISON.md) for the detailed RTK
side-by-side, [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model.

---

## Project layout

```
QTK/
├── README.md                       ← you are here
├── BRIEF.md                        ← original design brief
├── STATUS.md                       ← what's currently working
├── docs/
│   ├── ARCHITECTURE.md             ← internal design
│   ├── ROADMAP.md                  ← phase plan with current status
│   ├── RTK-COMPARISON.md           ← QTK vs RTK in detail
│   ├── SECURITY.md                 ← threat model + mitigations
│   ├── FILTER-DSL.md               ← TOML filter reference
│   └── INTEGRATION.md              ← installation guide
├── packages/
│   ├── qtk-plugin/                 ← Phase 1+2+3 TS plugin (73 KB bundle)
│   │   ├── src/
│   │   │   ├── index.ts            ← tool.execute.after hook
│   │   │   ├── compressors/        ← 9 hand-written compressors
│   │   │   ├── tools/              ← built-in tool compressors
│   │   │   ├── dsl/                ← Phase 2: TOML filter DSL
│   │   │   ├── sidecar/            ← Phase 3: Rust subprocess client
│   │   │   └── cli/                ← `qtk gain` analytics
│   │   └── test/                   ← 89 TS tests
│   ├── qtk-core/                   ← Phase 3 Rust crate (1.98 MB binary)
│   │   ├── src/
│   │   │   ├── main.rs             ← NDJSON read loop
│   │   │   ├── protocol.rs         ← serde types
│   │   │   └── parsers/            ← 4 heavy parsers (22 Rust tests)
│   │   └── Cargo.toml
│   └── qtk-filters/imported/       ← RTK filter import target
├── scripts/
│   ├── install-into-opencode.ts    ← symlink + jsonc patcher
│   ├── benchmark.ts                ← TS compressor benchmark
│   ├── benchmark-sidecar.ts        ← Rust sidecar throughput benchmark
│   └── import-rtk-filters.ts       ← translate RTK corpus → QTK
└── LICENSE                         ← MIT
```

---

## Tests

```bash
bun test                          # 89 TS tests
cd packages/qtk-core && cargo test --release   # 22 Rust tests
# total: 111 passing, 0 failing
```

Coverage:

| Area                         | Tests | Notes                                                   |
| ---------------------------- | ----- | ------------------------------------------------------- |
| Phase 1 compressors          | 28    | All 9 compressors, golden fixtures, adversarial inputs  |
| Session cache                | 3     | Fingerprint stability, hash check, LRU pruning          |
| Circuit breaker              | 2     | 3-strike disable, per-compressor isolation              |
| Tee secret redaction         | 4     | AWS, GitHub PAT, Bearer, benign-passthrough             |
| Phase 2 TOML DSL             | 39    | Parser, spec validator, runtime, loader, end-to-end     |
| Phase 3 Rust parsers         | 22    | All 4 parsers, malformed input, length-monotonicity     |
| Phase 3 sidecar integration  | 10    | Real binary spawn, hello, concurrent ids, stop/restart  |

---

## Benchmarks

```bash
bun run scripts/benchmark.ts             # TS compressors
bun run scripts/benchmark-sidecar.ts     # Rust sidecar (needs binary built)
```

See the "Show me the numbers" section above for current results.

---

## License

[MIT](LICENSE).

QTK's TOML filter DSL syntax is intentionally compatible with
[RTK's](https://github.com/rtk-ai/rtk) (Apache 2.0). RTK's filter corpus
can be imported via `scripts/import-rtk-filters.ts` with attribution
headers added per file. **No RTK source code is vendored** — QTK is a
clean-room implementation that shares only the user-facing TOML format.

---

## Acknowledgements

The entire QTK project is downstream of [RTK](https://github.com/rtk-ai/rtk).
RTK did the hard work of proving the deterministic-compression thesis at
scale and shipped a 100-filter corpus. QTK is what we want specifically
for opencode-based agents (where we can hook tools directly and don't
need an external CLI proxy); RTK is the right answer for everyone else.

Built on:
- [opencode](https://github.com/sst/opencode) — the agent host
- [@opencode-ai/plugin](https://www.npmjs.com/package/@opencode-ai/plugin) — plugin SDK
- [Bun](https://bun.sh) — TS runtime
- [quick-xml](https://crates.io/crates/quick-xml), [serde](https://serde.rs), [regex](https://crates.io/crates/regex) — Rust deps

Authored by [fivelidz](https://qalarc.com).
