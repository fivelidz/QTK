# QTK — Design Brief

**Last updated:** 2026-05-20
**Author:** fivelidz + Claude
**Status:** Phase 0 — brief locked, Phase 1 implementation in progress

---

## 1. Problem statement

A typical opencode yolo session burns ~120,000 tokens of context on
deterministic tool output: `git status` porcelain, `ls -la` columns, `rg`
match clusters, `cargo test` compiler verbosity, `npm install` progress bars,
`kubectl get pods` tables.

**None of this needs an LLM to compress.** A few hundred lines of
hand-written parsers can reduce these outputs by 60–90% with zero quality
loss for the model. RTK (rtk-ai/rtk) proved this thesis at scale with a 100+
command corpus.

But RTK has three architectural limits we hit in practice with opencode:

1. **Hook scope** — RTK intercepts only the `Bash` tool. opencode's `Read`,
   `Grep`, and `Glob` tools account for 30–50% of context bloat in a typical
   exploration session, and RTK can't touch them.

2. **Prompt overhead** — RTK works by **rewriting the command** (e.g.
   `git status` → `rtk git status`). For this to happen, the model must
   either (a) explicitly call `rtk`, requiring a CLAUDE.md injection of
   instructions (hundreds of tokens of system prompt overhead), or (b) be
   silently rewritten by a PreToolUse hook. Option (b) works for Claude Code
   but means trusting the rewrite path completely.

3. **Subprocess cost** — RTK's OpenCode plugin forks `rtk rewrite` on every
   single bash invocation. At 5–15ms per fork, with hundreds of calls per
   session, this adds up.

QTK solves all three at the architectural layer that's correct for
opencode: an **output-side compressor** living inside the agent as a
first-class plugin.

---

## 2. Core architectural choice

| Axis                       | RTK                                                | QTK                                                              |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| **Where the work happens** | Before tool call: rewrite command, then native-run | After tool call: run command unchanged, compress `result.output` |
| **What the model sees**    | A `rtk`-prefixed command that emits compact output | An unchanged command that produced compact output (invisible)    |
| **Process model**          | External binary + IPC                              | In-process TS, optional Rust sidecar                             |
| **Scope**                  | Whatever the `Bash` tool runs                      | Every tool that goes through `tool.execute.after`                |

This single decision cascades into all the wins:

- **No prompt injection** needed — the model doesn't have to know QTK exists
- **No double-wrap risk** — we don't change the command, so a model writing
  `rtk git status` (because it learned from RTK in a previous project)
  doesn't get `rtk rtk git status`
- **Read/Grep/Glob coverage** — those tools also go through
  `tool.execute.after`, so they get compressed by the same code path
- **No per-call subprocess** — TS compressors run in-process; Rust sidecar
  fires only for heavy parsers (JUnit XML, terraform plan)
- **Stronger safety** — RTK has a documented `sh -c <user_input>` surface in
  `rtk summary/err/test/proxy` (audit finding §2.1). QTK never executes
  anything; it only reads the output of a command opencode already ran.

---

## 3. Compression strategies

We adopt all four of RTK's strategies plus add three more:

### From RTK

1. **Smart filtering** — strip comments, whitespace, boilerplate, progress bars
2. **Grouping** — aggregate similar items (files by directory, errors by type)
3. **Truncation** — keep relevant context, drop redundancy
4. **Deduplication** — collapse repeated log lines with counts

### New in QTK

5. **Session dedup cache** — if the same tool+args produced the same output
   within N seconds, return `"unchanged since <ts>"`. Huge for the
   loop-pattern of "check status, do thing, check status again".

6. **Tool-aware compression** — different strategies for different tool types:
   - `Read`: if output > 200 lines, generate signature outline
   - `Grep`: cluster matches by file, show top hit per file by default
   - `Glob`: cluster paths by common directory prefix

7. **Tee fallback with structured pointer** — on compression, write raw
   output to `.opencode/qtk-tee/<id>.log` and return a structured marker:
   ```
   <qtk-compressed orig_lines=247 ratio=0.18 tee=qtk-tee/abc123.log>
   ... compressed output ...
   </qtk-compressed>
   ```
   The agent can `cat` the tee log if it needs the raw form. The structured
   marker is also machine-readable so the gmux dashboard can render it.

---

## 4. Specific compressors (Phase 1 MVP target list)

In rough order of frequency-impact (most-used × biggest savings first):

### Filesystem & search

- `ls` / `ls -la` → tree format (–80%)
- `find` / `find -name` → group by directory, cap depth (–70%)
- `rg <pattern>` → group by file, show first match + count (–80%)
- `grep -r` → same as rg
- `cat <file>` / `head` / `tail` → defer to `Read` tool compressor

### Git

- `git status` → compact (–80%)
- `git status --short` → already short, pass through
- `git diff` → condensed (–75%)
- `git diff --stat` → pass through
- `git log` → one-line commits (–80%)
- `git add` / `git commit` / `git push` → success → "ok"

### Test runners (biggest wins — passes are noise, only failures matter)

- `pytest` → failures only (–90%)
- `cargo test` → failures only (–90%)
- `npm test` / `jest` / `vitest` → failures only (–90%)
- `go test` → failures only

### Build / lint

- `cargo build` → strip "Compiling X" lines, keep errors (–80%)
- `npm run build` / `bun run build` → strip progress bars
- `tsc` → group errors by file
- `eslint` / `biome` → group by rule

### Package managers

- `npm install` / `bun install` → "ok N packages, M changes" (–95%)
- `pip install` → "ok N packages" (–95%)
- `apt list --installed` → count + first N

### Built-in opencode tools (where RTK can't go)

- `Read` — if length > 200 lines, signature outline + offset to read more
- `Grep` — group by file, show first match per file, count remaining
- `Glob` — cluster by common directory prefix when > 30 results

---

## 5. Filter DSL (Phase 2)

Filters live in `.opencode/qtk/filters/*.toml` per-project.
We adopt RTK's TOML DSL syntax so RTK's 100-tool corpus is importable for free
(Apache 2.0 → MIT compatible). Each imported filter carries its original
attribution as a comment.

Example filter format:

```toml
# .opencode/qtk/filters/git-status.toml
command = "git status"
match = "^\\s*(modified|new file|deleted):\\s*(.+)$"
group_by = "category"
template = "{category}: {file}"
truncate = 50
truncate_message = "... and {n} more"
```

DSL primitives:

- `command` — string or glob, matches command prefix
- `match` — regex per line to extract structured fields
- `group_by` — column name to aggregate on
- `dedupe` — `lines` | `count`
- `strip` — regex of lines to drop entirely
- `template` — Mustache-style output template
- `truncate` — int, max output lines
- `truncate_message` — message when truncated
- `pass_through_if` — regex; if matched, return original unchanged

Hot-reload: filter TOMLs are re-read on file change.

---

## 6. Cross-call session cache (the cleverest bit)

Fingerprint each tool call as `sha256(tool + args.canonicalize())`. Store the
last N fingerprints with their output hash and timestamp in
`.opencode/qtk-cache.sqlite`.

When a tool call's fingerprint matches a recent (< 60s default) entry AND the
output hash matches:

```
<qtk-unchanged tool=bash args="git status" since=14:23:47 cached_output_lines=23>
(use `rtk inspect last` to see the prior output)
</qtk-unchanged>
```

This single optimisation alone catches the very common pattern of
"check git status → make a change → check git status again". The third call
in a session frequently returns identical output, and the agent doesn't need
to see the same output twice.

---

## 7. Telemetry (local only)

`.opencode/qtk-stats.sqlite` schema:

```sql
CREATE TABLE compressions (
  ts INTEGER NOT NULL,
  session_id TEXT,
  tool TEXT,
  command TEXT,         -- first 3 words of command only (privacy)
  original_bytes INTEGER,
  compressed_bytes INTEGER,
  original_tokens_est INTEGER,
  compressed_tokens_est INTEGER,
  ratio REAL,           -- compressed / original
  compressor TEXT,      -- which compressor handled it
  tee_file TEXT,        -- relative path to raw fallback
  agent_read_tee BOOLEAN DEFAULT 0  -- updated retrospectively if agent cats the tee
);

CREATE INDEX idx_session ON compressions(session_id);
CREATE INDEX idx_command ON compressions(command);
```

Surfaced via:

- CLI: `qtk gain` (matching RTK's familiar UX)
- Gmux dashboard widget (Phase 4)

Zero network traffic. Ever.

---

## 8. Smart compaction integration (Phase 5)

opencode already has a compaction pruner
(`packages/opencode/src/session/compaction.ts`) that nulls out old tool
outputs beyond a 40k-token rolling window.

QTK upgrades this: instead of nulling, **summarise**. For a sequence of 5
`git status` calls, instead of:

```
[tool call 17: output pruned]
[tool call 23: output pruned]
[tool call 29: output pruned]
[tool call 31: output pruned]
[tool call 38: git status: X modified files]
```

We produce:

```
[Earlier in session: 4 prior `git status` calls — last identical, no new changes since 14:18]
[tool call 38: git status: X modified files]
```

This costs one extra LLM call to summarise on compaction (every ~30k tokens),
saves multiple times that in the long-running context.

---

## 9. Safety / security posture

Lessons from the RTK audit (`SECURITY.md` for full notes):

| RTK risk                                        | QTK approach                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `sh -c <user_input>` in `rtk summary/err/test`  | **Never execute** anything. We only read tool outputs after opencode has already run them.                                                        |
| Tee files written with `0o644` (world-readable) | Tee files written with `0o600` explicitly. Tee directory created `0o700`.                                                                         |
| `RTK_TEE_DIR` env-redirect with no validation   | Tee directory is **only** configurable from `.opencode/qtk.toml`, never from env. Canonicalize and verify it's inside the project before writing. |
| Telemetry URL baked into binary at build time   | Local SQLite only. No network code at all. The package has no HTTP client dep.                                                                    |
| Install script with no signature verification   | We're a TS plugin loaded from a project file. No installer.                                                                                       |
| `unsafe_code = "deny"` enforced in Rust         | Same rule for qtk-core when we add it.                                                                                                            |

---

## 10. Open questions

These are not blockers but worth surfacing:

1. **Cache scope** — session-local? per-project? cross-session? Phase 1 ships
   per-session in-memory only. Phase 2 will offer per-project persistence.

2. **Compressor failure mode** — if our compressor throws, we MUST fall back
   to original output (never crash the agent). Need an outer try/catch around
   every compressor and a circuit-breaker that disables a misbehaving
   compressor for the rest of the session after N failures.

3. **Streaming outputs** — opencode's bash tool emits partial output as
   metadata during execution (for the UI). Do we compress only the final
   `result.output`, or also the streaming metadata? Phase 1: final only.

4. **MCP tools** — they go through the same `tool.execute.after` path. Are
   their outputs structured enough that a generic JSON compressor would help,
   or do we need per-MCP-server compressors? Probably depends on the server.

5. **Coexistence with RTK** — if both are installed (RTK as bash-rewriter +
   QTK as output-compressor), do they double-compress? In principle no
   (RTK runs `rtk git status` natively, QTK then compresses the already-compact
   output further — likely a no-op). Worth measuring.

6. **gmux integration timing** — gmux's Tauri Option B doesn't exist yet
   (per ARCHITECTURE_PLANS.md). The dashboard widget targets the existing
   `packages/tauri` desktop first; gmux integration follows when that ships.

---

## 11. Definition of done — Phase 1 MVP

- [ ] `qtk-plugin` builds clean with `bun run build`
- [ ] Plugin loads in opencode without errors (smoke test)
- [ ] At least these compressors work end-to-end with golden-output tests:
  - [ ] `git status` (long)
  - [ ] `git status` (clean)
  - [ ] `ls -la` (large dir)
  - [ ] `rg <pattern>` (multi-file)
  - [ ] `cargo test` (failures)
  - [ ] `pytest` (failures)
  - [ ] Read tool (200+ line file → outline)
  - [ ] Grep tool (10+ files → grouped)
  - [ ] Glob tool (50+ files → clustered)
- [ ] Session dedup cache catches the "git status x3" pattern
- [ ] Tee fallback writes to `.opencode/qtk-tee/` with `0o600`
- [ ] SQLite stats DB records every call
- [ ] `qtk gain` CLI prints session summary
- [ ] Total compression ratio on a real exploration session > 50%
- [ ] Adds < 5ms median latency per tool call
- [ ] No subprocess forked for the top 20 compressors
- [ ] Compressor failure → automatic fallback to original output (verified by
      forcing an error in one compressor and confirming the agent loop
      continues unimpeded)

---

## 12. Out of scope (deliberately)

- **Other agents** — Phase 1 is opencode-only. A generic agent-agnostic
  package can come later if there's demand. RTK already covers that need.
- **Windows** — opencode runs on Linux/macOS. We don't test Windows.
- **Bundling our own binary distribution** — QTK ships as a plugin file you
  symlink into opencode. No `curl | sh`, no apt repos, no homebrew.
- **A standalone CLI** — `qtk gain` is the only CLI we ship, and it's
  optional (the plugin works without it). We're not building another
  general-purpose CLI proxy.
