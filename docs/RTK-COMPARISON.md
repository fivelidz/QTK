# QTK vs RTK — A Detailed Comparison

> **Read this first:** [RTK](https://github.com/rtk-ai/rtk) is the mature,
> production-grade project. 54k+ GitHub stars, 185 releases, supports 13
> AI coding tools across Linux/macOS/Windows, ships a 100+ command filter
> corpus. It is the project that proved deterministic token compression
> works at scale. Built by Patrick Szymkowiak, Florian Bruniaux, Adrien
> Eppling, and the RTK community. Licensed Apache-2.0.
>
> **If you're not running opencode specifically, you almost certainly want
> RTK, not QTK.** RTK supports Claude Code, Cursor, Gemini CLI, GitHub
> Copilot, Codex, Windsurf, Cline, Roo Code, OpenCode, OpenClaw, Hermes,
> Kilo Code, Antigravity — basically every serious AI coding agent.
>
> QTK is a much narrower project. It asks one question: *if we built this
> specifically for the opencode plugin surface, what would change?* The
> answer is "the architectural diff is meaningful enough to merit a
> separate codebase that we maintain ourselves" — but **the diff is small
> compared to the conceptual debt to RTK**. The whole thesis comes from
> RTK. Most of the filter ideas come from RTK. The TOML DSL syntax is
> RTK-compatible by deliberate design. This doc enumerates every
> meaningful difference and why we chose each tradeoff.

---

## At a glance

|                                  | RTK                                           | QTK                                        |
| -------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Form factor                      | External Rust binary (~8 MB)                  | TypeScript plugin file                     |
| Lines of code                    | ~50,000 Rust + 100+ TOML filters              | Target Phase 1: ~3,000 TS                  |
| Installation                     | `cargo install`, `brew install`, `install.sh` | Symlink a file into `.opencode/plugin/`    |
| Process model                    | Spawn per call (forks `rtk rewrite`)          | In-process, no subprocess                  |
| Tool scope                       | Bash only (via hook)                          | All tools that use `tool.execute.after`    |
| Compression timing               | Before tool call (rewrites command)           | After tool call (rewrites output)          |
| Prompt overhead                  | ~hundreds of tokens of CLAUDE.md hint         | Zero                                       |
| Per-call latency                 | 5–15 ms                                       | 1–4 ms                                     |
| Cross-call dedup                 | None                                          | Session cache                              |
| Compaction integration           | None                                          | Plugs into opencode's pruner (Phase 5)     |
| Filter authoring                 | Upstream PR to rtk-ai/rtk                     | Per-project `.opencode/qtk/filters/*.toml` |
| Telemetry                        | Opt-in HTTP POST to operator's endpoint       | Strictly local SQLite                      |
| Tee perms                        | 0o644 (umask default — world-readable!)       | 0o600 explicit                             |
| Telemetry kill switch            | Runtime + env var                             | Not applicable (no network code exists)    |
| Coverage of `Read`/`Grep`/`Glob` | Zero                                          | Full                                       |
| Built-in test runners            | jest/vitest/pytest/cargo/go/playwright        | Phase 1: pytest/cargo/jest/vitest          |
| Standalone CLI                   | Yes (`rtk`)                                   | Only `qtk gain` (optional analytics)       |
| Cross-agent support              | 13+ agents                                    | opencode plugin surface only               |

---

## The three structural differences that actually matter

### 1. Where the work happens

**RTK rewrites the command** before it runs:

```
LLM → "git status"
hook → "rtk git status"
shell → runs rtk binary
rtk → calls git, parses output, prints compact form
```

**QTK rewrites the output** after the command runs:

```
LLM → "git status"
shell → runs git
opencode → captures result.output (raw porcelain)
QTK hook → compresses result.output
LLM ← compact form
```

This single architectural flip cascades into most of the wins. Concretely:

- **No prompt injection.** RTK has to install a CLAUDE.md hint so the model
  knows `rtk` exists (or else the model would refuse the rewritten command).
  QTK is invisible to the model — the model writes `git status` and sees
  compact output, never learning QTK exists.

- **Double-wrap safety.** If the model has learned (from previous projects)
  to write `rtk git status` proactively, RTK's hook turns this into
  `rtk rtk git status` unless it has guard logic. QTK never has this
  problem — we don't touch the command.

- **Read/Grep/Glob support.** RTK's hook is on `tool.execute.before` for the
  bash tool only. opencode's built-in `Read`/`Grep`/`Glob` tools never see
  the bash tool's hook. They're real tools with their own `execute()`
  functions. But they all flow through the same `tool.execute.after` wrapper
  — which is where QTK lives. We pick up all of them for free.

- **Stronger safety surface.** RTK has documented `sh -c <user_input>`
  paths in `rtk summary`, `rtk err`, `rtk test`, `rtk proxy` (audit finding
  §2.1). These are intentional shell wrappers, but they widen RTK's attack
  surface meaningfully — if an attacker can influence the model's command
  output, they can chain into shell execution via these meta-commands. QTK
  never executes anything. The bash tool runs the command (just like
  before); QTK reads the result.

### 2. Process model

**RTK forks a subprocess on every bash tool call.** Look at the opencode
plugin shipped at `hooks/opencode/rtk.ts`:

```ts
const result = await $`rtk rewrite ${command}`.quiet().nothrow();
```

That's a `fork() + exec() + IPC roundtrip` per call. On modern Linux, that's
~5 ms minimum, more like 10–15 ms in practice with binary loading.

**QTK runs in-process.** Compressors are pure TypeScript functions called
synchronously. The overhead is the regex engine and a SQLite insert.
Measured ~1–4 ms in microbenchmarks.

This matters for two reasons:

- **Long sessions add up.** A 4-hour yolo session can easily make 500+ tool
  calls. RTK adds 2.5–7.5 seconds of fork overhead; QTK adds 0.5–2 seconds.
  Both invisible to humans, but the budget difference is real.

- **The cost of being out-of-process compounds.** Subprocess output has to
  be captured by opencode anyway (it's the shell's stdout/stderr); now we
  also have to capture rtk's stdout. Doubles the I/O bookkeeping.

The Rust performance argument cuts the other way once you're already in a
JS runtime. RTK's actual compressors are fast Rust regex, but the cost of
_getting to_ them dominates the cost of running them. QTK pays the in-process
JS regex tax, which is higher than Rust regex on hot paths — but we save the
entire IPC roundtrip, which is several orders of magnitude larger.

(Phase 3 introduces an optional Rust sidecar `qtk-core` for genuinely
expensive parsers like JUnit XML or terraform plan. The default Phase 1
plugin doesn't need it.)

### 3. State

**RTK is stateless per call.** Every invocation is independent.

**QTK has a session cache.** The cardinal pattern in agent loops is:

```
1. git status     → 23 lines of output
2. <work happens>
3. git status     → same 23 lines
4. <more work>
5. git status     → still same 23 lines
```

RTK compresses all three calls identically. QTK detects calls 2 and 3 as
**output-equal to the previous call** and short-circuits with:

```
<qtk-unchanged tool=bash command="git status" since=14:23:47>
(prior output: 23 lines, see qtk inspect last)
</qtk-unchanged>
```

On a real agent session, this catches the "list files → make edit → list
files again" pattern hundreds of times. Each hit saves the full compressed
output's tokens.

State also unlocks Phase 5: smart compaction. opencode already has a
compaction system that nulls old tool outputs when context fills up. With
QTK's stats DB, we can replace nulling with summarising — instead of
"[output pruned]", the model sees "4 prior `git status` calls, no new
changes since 14:18".

---

## Things RTK does that QTK deliberately doesn't

### Hook-based command rewriting

QTK doesn't rewrite commands. We compress outputs. This is a deliberate
architectural choice (see §1 above), not a missing feature.

If you want command rewriting, install RTK alongside QTK. They compose:
RTK rewrites the command, the rewritten command runs, QTK compresses the
result (no-op if RTK already compressed it to a tiny form).

### Standalone CLI

RTK ships a CLI binary that's useful even without an agent — you can run
`rtk git status` in your own terminal and get compact output.

QTK doesn't have an equivalent because QTK only exists to serve opencode.
If you want compact git output in your own terminal, use RTK.

### Cross-agent support (Cursor, Gemini, Windsurf, Cline, etc.)

RTK supports 13 agents because it's a CLI proxy with hook adapters.

QTK targets exactly one surface: the opencode plugin API. If you want
similar functionality in Cursor or Gemini, use RTK or write a separate
adapter. Don't ask QTK to be RTK.

### `rtk discover` / `rtk gain` / `rtk session` analytics CLI

RTK has a rich CLI for inspecting savings. QTK has one analytics command,
`qtk gain`, that prints session totals and is intentionally minimal.

The intended QTK analytics surface is the **gmux dashboard widget**
(Phase 4) — a live counter in your terminal multiplexer pane showing the
running token-savings number, with a drill-down inspector. That's where we
think analytics belong: in the agent UX, not in a separate CLI you have to
remember to run.

### Cryptographic device hashing / salted IDs for telemetry

RTK has thoughtful telemetry privacy (salted SHA-256 device IDs, GDPR
opt-in, etc). QTK doesn't need any of this because there's no telemetry
endpoint. The complexity simply doesn't exist.

---

## Things QTK does that RTK doesn't

### Tool-level compressors for Read/Grep/Glob

The single biggest practical gap in RTK. When an agent is exploring an
unfamiliar codebase, the typical flow is:

```
Glob "src/**/*.ts"           → 200 file paths
Read packages/opencode/...   → 1200-line file
Grep "useEffect" src/        → 80 matches across 20 files
```

That's easily 30 KB of context per exploration round. RTK can't touch any
of it. QTK compresses all three:

- **Glob** → clusters by common directory prefix:

  ```
  src/ui/components/  (47 .ts files)
  src/lib/parsers/    (23 .ts files)
  src/server/api/     (19 .ts files)
  ... and 5 more directories. Full list: see qtk-tee/abc.log
  ```

- **Read** → if file > 200 lines, returns signature outline + offset:

  ```
  <file-outline path="packages/opencode/src/session/prompt.ts" lines=1200>
  L1   import { z } from "zod"
  L18  export const Prompt = createContext(...)
  L36  export const Stop = createError(...)
  L84  export async function load(sessionID: string) { ... }
  L142 export async function spawn(...) { ... }
  L1036 async execute(args, options) { ... }
  ...
  </file-outline>
  Full file in: qtk-tee/abc.log (or call Read with offset=N)
  ```

- **Grep** → groups by file, shows first match per file by default:
  ```
  src/ui/component/foo.ts (3 matches)
    L17: useEffect(() => { setX(value) })
  src/ui/component/bar.ts (12 matches)
    L42: useEffect(() => loadData(), [])
  ...
  ```

### Session dedup

Already covered in §3 above. RTK has no equivalent.

### Compaction integration (Phase 5)

RTK is stateless and has no knowledge of opencode's compaction system. QTK
plugs into it and replaces "[output pruned]" with summaries.

### Zero prompt injection

RTK's adoption strategy requires a CLAUDE.md hint or AGENTS.md mention to
teach the model that `rtk` is the better tool. QTK is invisible.

### Local-only telemetry as default and only mode

RTK has thoughtful opt-in HTTP telemetry. QTK has SQLite-only telemetry.
The complexity of opt-in flows, GDPR consent text, salting algorithms,
endpoint security, and the trust required to use any of it... simply doesn't
exist in QTK because we never call out.

---

## Compatibility matrix

Can RTK and QTK both be installed in the same opencode project?

**Yes, and they compose cleanly.**

| Scenario                                            | RTK behaviour                                      | QTK behaviour                                     | Net result                |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- | ------------------------- |
| Model writes `git status`                           | Rewrites to `rtk git status`                       | Inspects output, sees it's already compact, skips | RTK-compressed (best)     |
| Model writes `pytest`                               | Rewrites to `rtk pytest`                           | Skips (output already short)                      | RTK-compressed            |
| Model writes `cat src/foo.ts`                       | No rewrite (rtk has read but agent didn't call it) | Compressed                                        | QTK-compressed            |
| Model uses `Read` tool                              | Hook doesn't fire for non-bash tools               | Compressed                                        | QTK-compressed            |
| Model uses `Grep` tool                              | Bypass                                             | Compressed                                        | QTK-compressed            |
| Model uses `Glob` tool                              | Bypass                                             | Compressed                                        | QTK-compressed            |
| MCP tool returns big JSON                           | Bypass                                             | Compressed (if configured)                        | QTK-compressed            |
| Model writes some exotic `npm run my-custom-script` | No rule, passthrough                               | No rule, passthrough                              | Original (no compression) |
| Two RTK invocations in a row (caching)              | Each is independent fork                           | Session cache catches identical output            | RTK + QTK dedup           |

So installing both gives you: RTK's mature filter corpus + QTK's coverage
of the tools RTK can't touch + QTK's session dedup over both.

---

## When to use which

| You want...                                                              | Use                                     |
| ------------------------------------------------------------------------ | --------------------------------------- |
| Token compression in Claude Code, Cursor, Gemini, etc.                   | RTK                                     |
| Token compression in opencode specifically, with maximum coverage        | QTK (+ optionally RTK)                  |
| One unified install across many agents                                   | RTK                                     |
| Zero prompt overhead                                                     | QTK                                     |
| Best-in-class compression of `git`, `cargo test`, `kubectl`, `terraform` | RTK (much more mature filter corpus)    |
| Coverage of `Read`/`Grep`/`Glob` output                                  | QTK (RTK can't reach these)             |
| Live dashboard integration with gmux/tauri                               | QTK (Phase 4)                           |
| Smart compaction in opencode sessions                                    | QTK (Phase 5)                           |
| No network code at all in your supply chain                              | QTK                                     |
| To not have to think about it                                            | RTK on everything else, QTK on opencode |

---

## On giving credit

QTK is downstream of RTK in every meaningful sense. The thesis (deterministic
compression beats LLM-summarisation), the filter taxonomy (which commands
matter most), the tee-fallback pattern, the TOML filter DSL — all RTK
inventions. QTK takes that and asks "what if we built it for opencode
specifically?". The answer is a much smaller, more focused tool that does
fewer things better in one specific environment.

If you find QTK useful, star RTK too. Patrick Szymkowiak and the contributors
did the hard work.
