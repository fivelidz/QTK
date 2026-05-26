# QTK Architecture

> How QTK actually works inside opencode. The brief
> ([`BRIEF.md`](../BRIEF.md)) is the _what_ and _why_. This is the _how_.

---

## 1. Where QTK lives in opencode's tool-call lifecycle

Every tool call in opencode (`Bash`, `Read`, `Grep`, `Glob`, MCP tools, the
`Task` sub-agent tool) flows through one wrapper function in
`packages/opencode/src/session/prompt.ts` around line 1036–1088:

```ts
async execute(args, options) {
  await Plugin.trigger(
    "tool.execute.before",
    { tool: item.id, sessionID, callID: options.toolCallId },
    { args },
  )

  const result = await item.execute(args, { ... })   // ← the actual tool

  await Plugin.trigger(
    "tool.execute.after",
    { tool: item.id, sessionID, callID: options.toolCallId },
    result,                                          // ← QTK mutates this
  )
  return result
},
toModelOutput(result) {
  return { type: "text", value: result.output }     // ← this is what the LLM sees
}
```

`Plugin.trigger` walks the registered plugins in order and calls each hook
function with the **mutable** `result` object. **Any plugin can mutate
`result.output`** and the change flows directly into `toModelOutput()`.

QTK registers a `tool.execute.after` hook and rewrites `result.output` in place.

That's the entire integration surface. ~5 lines in opencode we don't have to
touch.

---

## 2. Module layout

```
qtk-plugin/
  src/
    index.ts           ← plugin entry, registers tool.execute.after hook
    types.ts           ← shared type aliases
    registry.ts        ← maps (tool, command) → compressor function
    config.ts          ← loads .opencode/qtk.toml (with sensible defaults)

    cache.ts           ← in-memory session dedup cache
                         fingerprint = sha256(tool + canonical-args)
                         entry = { outputHash, ts, compressedOutput }
                         TTL = 60s default

    tee.ts             ← writes raw output to .opencode/qtk-tee/<id>.log
                         (only on failure or when compression > threshold)
                         strict 0o600 perms

    stats.ts           ← SQLite logger
                         schema = (ts, sessionID, tool, command_head,
                                   orig_bytes, comp_bytes, ratio, ...)

    estimator.ts       ← token estimator (chars/4, matches opencode's)

    compressors/       ← per-command compressors
      git.ts             git status / log / diff
      ls.ts              ls / ls -la
      rg.ts              ripgrep output (also covers `grep -r`)
      find.ts            find / fd
      cargo.ts           cargo build/test/clippy
      pytest.ts          pytest summaries
      npm.ts             npm install/test/run-script
      jest.ts            jest / vitest JSON output
      generic.ts         fallback heuristics for unknown commands

    tools/             ← compressors for built-in opencode tools
      read.ts            Read tool → outline if too long
      grep.ts            Grep tool → group by file
      glob.ts            Glob tool → cluster by directory
```

---

## 3. Request lifecycle (one tool call)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ opencode agent loop                                                     │
│                                                                         │
│ 1. LLM emits tool_use: bash {"command": "git status"}                   │
│                                                                         │
│ 2. session/prompt.ts wraps the bash tool's execute()                    │
│    ↓                                                                    │
│    fires Plugin.trigger("tool.execute.before") → RTK plugin             │
│    (if RTK is installed, it MAY rewrite to "rtk git status")            │
│    ↓                                                                    │
│ 3. bash tool runs the command, captures stdout+stderr to result.output  │
│    (1.8 KB of porcelain text)                                           │
│    ↓                                                                    │
│ 4. fires Plugin.trigger("tool.execute.after") → QTK plugin              │
│    ↓                                                                    │
│ 5. QTK hook (this is the QTK logic):                                    │
│                                                                         │
│    a. Compute fingerprint sha256(tool + args.command)                   │
│    b. Lookup in session cache                                           │
│         IF found AND outputHash matches AND ts within TTL:              │
│            result.output = "<qtk-unchanged since=14:23>"                │
│            stats.log("dedup_hit", ...)                                  │
│            return                                                       │
│                                                                         │
│    c. Pick compressor:                                                  │
│         registry.lookup(tool, args.command)                             │
│         If no match → generic.ts heuristics                             │
│                                                                         │
│    d. compressor.compress(result.output) → compressed string            │
│         If compressor throws → log + leave output unchanged             │
│                                                                         │
│    e. If compressed/original ratio < 0.5:                               │
│         tee.write(callID, result.output)                                │
│         result.output = `<qtk-compressed orig_lines=X ratio=Y           │
│                           tee=qtk-tee/<callID>.log>                     │
│                          ${compressed}                                  │
│                          </qtk-compressed>`                             │
│                                                                         │
│    f. stats.log(...)                                                    │
│    g. cache.put(fingerprint, outputHash, compressed)                    │
│                                                                         │
│ 6. session/prompt.ts → toModelOutput(result) → LLM context              │
│    (250 bytes of compact text + 1.8 KB invisible on disk)               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Compressor interface

Every compressor implements:

```ts
export interface Compressor {
  /** Stable identifier for stats and config overrides. */
  readonly name: string;

  /**
   * Does this compressor want to handle (tool, args)? Pure function, no I/O.
   * Returning true commits to compressing — registry stops searching.
   */
  matches(tool: string, args: Record<string, unknown>): boolean;

  /**
   * Synchronous, deterministic transformation of raw output → compact output.
   * Must NEVER throw. If something goes wrong, return the input unchanged.
   * Must NEVER do I/O. Pure string-in-string-out.
   */
  compress(raw: string, ctx: CompressorContext): string;
}

export interface CompressorContext {
  /** The full tool args, in case compressor wants to inspect flags. */
  readonly args: Record<string, unknown>;
  /** Project root (Instance.directory equivalent). */
  readonly cwd: string;
  /** Optional config snapshot for this compressor. */
  readonly config: Record<string, unknown>;
}
```

**Why synchronous and pure?** Two reasons:

1. **No I/O = no failure modes we can't bound.** A compressor that reads a file
   could block on a stuck NFS mount; a compressor that calls an LLM could time
   out. By keeping compressors as pure string transformers, the worst-case
   latency is bounded by the regex engine.

2. **Determinism makes tests trivial.** Golden-file tests: `compress(fixture)
== expected_output`. No mocks, no async, no flake.

The registry is the **only** place that does I/O — it reads config and dispatches.

---

## 5. Cache & dedup

The session cache is the single most impactful optimisation in Phase 1 — it's
also the simplest:

```ts
class SessionCache {
  private entries = new Map<string, CacheEntry>();

  fingerprint(tool: string, args: Record<string, unknown>): string {
    const canonical = JSON.stringify(args, Object.keys(args).sort());
    return sha256(`${tool}\0${canonical}`);
  }

  lookup(fp: string, outputHash: string, ttlMs: number): CacheEntry | null {
    const e = this.entries.get(fp);
    if (!e) return null;
    if (Date.now() - e.ts > ttlMs) return null;
    if (e.outputHash !== outputHash) return null; // output changed → recompute
    return e;
  }

  put(fp: string, outputHash: string, compressed: string) {
    this.entries.set(fp, { outputHash, compressed, ts: Date.now() });
    // simple LRU: if > 500 entries, drop the oldest 100
    if (this.entries.size > 500) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, 100);
      for (const [k] of oldest) this.entries.delete(k);
    }
  }
}
```

Note the subtle point in `lookup`: we don't just match the fingerprint — we
also need the actual output's hash to match. If `git status` is called now and
returns "modified: foo.ts", then in 30s the agent fixes the file and runs
`git status` again returning "nothing to commit", the second call MUST go
through the compressor (output changed). The cache only short-circuits when
output is **identical** to the recent prior call.

This means we always do the work of running the tool and hashing its output;
we just skip the compression+SQLite write if nothing changed. That's still a
big win — most of the latency budget is the compressor's regex passes, not
the file I/O.

---

## 6. Tee fallback

On compression, we write the raw output to disk so the agent can recover it
if it needs to. Path: `.opencode/qtk-tee/<callID>.log`.

```ts
async function tee(callID: string, raw: string): Promise<string> {
  const dir = ".opencode/qtk-tee";
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${callID}.log`;
  // Write with 0o600 explicitly — DO NOT rely on umask
  // (RTK audit finding §3.1: RTK uses default 0o644 which is world-readable)
  await Bun.write(path, raw, { mode: 0o600 });
  return path;
}
```

Old tee files are pruned at session start (anything > 7 days). We don't prune
during the session — disk is cheap, surprises mid-session are not.

---

## 7. Stats / telemetry — strictly local

`.opencode/qtk-stats.sqlite` schema:

```sql
CREATE TABLE IF NOT EXISTS compressions (
  ts                       INTEGER NOT NULL,
  session_id               TEXT,
  tool                     TEXT NOT NULL,
  command_head             TEXT,           -- first 3 tokens of command line
  compressor               TEXT NOT NULL,  -- name of compressor that handled it
  original_bytes           INTEGER NOT NULL,
  compressed_bytes         INTEGER NOT NULL,
  original_tokens_est      INTEGER NOT NULL,
  compressed_tokens_est    INTEGER NOT NULL,
  ratio                    REAL NOT NULL,  -- compressed / original
  was_cache_hit            INTEGER NOT NULL,
  tee_file                 TEXT,           -- relative path or NULL
  agent_read_tee           INTEGER NOT NULL DEFAULT 0,
  duration_ms              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session ON compressions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool ON compressions(tool);
CREATE INDEX IF NOT EXISTS idx_ts ON compressions(ts);
```

We use `bun:sqlite` — comes with Bun, zero deps.

**No network code in QTK.** Period. Not opt-in, not opt-out, not "anonymous
aggregate" — there is no HTTP client in the dependency tree. If you `grep -r
"fetch\|http" qtk-plugin/src/` you should get zero matches.

---

## 8. Failure modes & fallbacks

The cardinal rule: **QTK MUST NEVER break the agent loop.** Every failure
mode falls back to the raw output.

| Failure                                             | What happens                                  | What the LLM sees                           |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Compressor throws                                   | Log, increment circuit breaker                | Raw output (unchanged)                      |
| Compressor returns garbage (zero-length or > input) | Log, ignore result                            | Raw output                                  |
| Cache lookup throws                                 | Log, skip cache                               | Raw output goes through compressor normally |
| Tee write fails                                     | Log, set tee_file = NULL                      | Compressed output without `tee=` attr       |
| Stats write fails                                   | Log only                                      | No effect on output                         |
| Config file invalid TOML                            | Log, use defaults                             | Raw output (compressors disabled)           |
| QTK plugin itself fails to load                     | opencode reports plugin load error, continues | Raw output (no QTK at all)                  |

### Circuit breaker

If a single compressor throws ≥ 3 times in a session, it's disabled for the
rest of that session. We never crash the agent because of a buggy regex.

```ts
class CircuitBreaker {
  private failures = new Map<string, number>();
  private disabled = new Set<string>();
  recordFailure(compressor: string) {
    const n = (this.failures.get(compressor) ?? 0) + 1;
    this.failures.set(compressor, n);
    if (n >= 3) this.disabled.add(compressor);
  }
  isDisabled(compressor: string): boolean {
    return this.disabled.has(compressor);
  }
}
```

---

## 9. Configuration

`.opencode/qtk.toml` (or `.opencode/qtk/config.toml`):

```toml
[qtk]
enabled = true                # master kill switch
log_level = "info"            # debug | info | warn | error
dedup_ttl_seconds = 60        # cache TTL

[qtk.tee]
enabled = true
directory = ".opencode/qtk-tee"   # relative to project root, must stay inside
mode = "failures_and_compressed"  # always | failures_and_compressed | never
prune_days = 7                # delete tee files older than this at session start

[qtk.stats]
enabled = true
database = ".opencode/qtk-stats.sqlite"

[qtk.compressors]
# Override defaults per-compressor
git_status = { enabled = true, max_files_shown = 20 }
ls = { enabled = true, max_entries_shown = 40 }
rg = { enabled = true, max_files_shown = 15, max_matches_per_file = 3 }
pytest = { enabled = true, show_passing_summary = true }

# Per-tool overrides
[qtk.tools.read]
enabled = true
outline_threshold_lines = 200    # if file > N lines, return outline only

[qtk.tools.grep]
enabled = true
max_files_shown = 15

[qtk.tools.glob]
enabled = true
cluster_threshold = 30           # cluster by directory if > N results
```

All keys are optional; QTK ships with sensible defaults that work for the
typical opencode user.

---

## 10. Compatibility with RTK

If both RTK and QTK are installed, the flow is:

1. `tool.execute.before` fires → RTK rewrites `git status` → `rtk git status`
2. Bash tool runs `rtk git status` — RTK's native git filter compresses
   output server-side, produces ~150-byte compact output
3. `tool.execute.after` fires → QTK's git compressor inspects the output
4. Output already starts with `RTK` or matches "compact format" pattern → QTK
   short-circuits, doesn't double-compress

Implementation in `compressors/git.ts`:

```ts
function compress(raw: string): string {
  // If RTK already compressed this, leave it alone.
  if (raw.length < 200 || /^[ML][AMD]\s/.test(raw.trim())) return raw;
  // ... our own compression logic
}
```

No conflict, no double-work, no double-tee. Just an additive layer.

---

## 11. Performance budget

Target: **median additional latency < 5ms per tool call**.

Approximate budget per call:

- Fingerprint hash (sha256 of ~200 bytes): 50 µs
- Cache lookup (Map.get): 1 µs
- Output hash (sha256 of typical 2 KB): 200 µs
- Compressor regex passes: 500 µs – 3 ms (compressor-dependent)
- SQLite insert (in-memory commit, sync to disk async): 100 µs
- Tee write (async, fire-and-forget): 0 µs (not awaited if compression succeeded)

Total: ~1–4 ms typical. Worst case (large output, expensive compressor): ~10 ms.

We benchmark with `scripts/benchmark.ts` — runs every compressor against the
fixture corpus and reports `p50 / p90 / p99` latencies. Anything over 10 ms
p99 is a bug.

---

## 12. What lives where (vs RTK)

| Concern                | RTK                                  | QTK                                     |
| ---------------------- | ------------------------------------ | --------------------------------------- |
| Process model          | External binary, subprocess per call | In-process TS, no subprocess            |
| Compression strategies | Rust regex + TOML DSL                | TS regex (TOML DSL in Phase 2)          |
| Per-call latency       | 5–15 ms (fork + exec + IPC)          | 1–4 ms (in-process)                     |
| Tool scope             | Bash only                            | All tools (Bash, Read, Grep, Glob, MCP) |
| Prompt injection       | CLAUDE.md teaches the model          | None — invisible to model               |
| State                  | Stateless, per-call                  | Session cache + SQLite stats            |
| Telemetry              | Opt-in, phones home                  | Strictly local SQLite                   |
| Tee perms              | 0o644 (umask)                        | 0o600 explicit                          |
| Heavy parsers          | Always in-binary                     | Optional Rust sidecar (Phase 3)         |

QTK's surface area is dramatically smaller than RTK's because RTK is
trying to be a general-purpose CLI proxy for any agent. QTK targets one
specific plugin surface and doesn't need any of the install-script,
hook-installer, exit-code-protocol machinery.
