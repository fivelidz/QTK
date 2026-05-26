# Filter DSL Reference (Phase 2)

> The Phase 2 TOML filter DSL lets users add per-project compressors without
> writing TypeScript. This doc is the full reference of supported keys.
>
> **Status:** Specification complete; implementation lands in Phase 2.
> Phase 1 ships only hand-written TS compressors.

---

## Why a DSL

Phase 1 ships 7–15 hand-written TypeScript compressors covering the most-used
commands. But the long tail of commands is enormous — every team uses
different tools (terraform, kubectl, docker compose, dbt, sqlx, prisma,
their custom scripts, etc.). We can't ship a TS compressor for every one.

The DSL solves this by letting users declare a filter in a few lines of TOML
that lives in their project's `.opencode/qtk/filters/` directory. No
JavaScript skills needed; no rebuild of QTK; no PR upstream.

The format is designed to be compatible with RTK's TOML filter format
(Apache 2.0). We can `scripts/import-rtk-filters.ts` their corpus and get
~50 ready-to-use filters for free.

---

## File location and naming

```
.opencode/qtk/filters/
  ├─ kubectl-pods.toml
  ├─ docker-compose.toml
  ├─ terraform-plan.toml
  └─ my-custom-script.toml
```

Files are scanned at session start AND hot-reloaded on save during a
session. File name is just for organisation — the `command` key inside is
what matters for matching.

---

## Top-level keys

### `command` (required)

The command(s) this filter applies to. Supports:

- Exact match: `command = "git status"`
- Wildcard: `command = "kubectl get *"`
- Multiple: `command = ["docker ps", "docker container ls"]`

The first filter whose `command` matches a tool call wins. Filters in
`.opencode/qtk/filters/` override any built-in compressor with the same
match.

### `pass_through_if` (optional)

A regex pattern. If the **raw output** matches this regex, the filter
short-circuits and returns the raw output unchanged.

```toml
pass_through_if = "^Error:|^FATAL:"
```

Useful for never compressing error output — failures matter, brevity
costs context.

### `strip` (optional)

An array of regex patterns. Lines matching ANY pattern are dropped from
the output.

```toml
strip = [
  "^Using ",                  # bundle install noise
  "^Compiling \\S+",          # cargo verbose noise
  "^\\s*$"                    # blank lines
]
```

### `dedupe` (optional)

How to handle repeated content. Values:

- `"lines"` — collapse consecutive identical lines into `<line> (x42)`
- `"count"` — collapse but show only the unique lines + a count of total
- `"none"` (default) — no deduplication

```toml
dedupe = "lines"
```

### `match` (optional)

A regex with **named capture groups**. Each matching line becomes a
structured record. Lines that don't match are dropped (unless
`unmatched` is set; see below).

```toml
match = "^(?<status>\\S+)\\s+(?<file>\\S+)$"
```

### `unmatched` (optional)

Controls what happens to lines that don't match `match`.

- `"drop"` (default) — discard them
- `"keep"` — keep them as-is
- `"truncate"` — keep first 10, then `... and N more lines`

### `group_by` (optional)

After applying `match`, group records by a captured field. Each group
becomes one summary line.

```toml
match = "^(?<status>\\S+)\\s+(?<file>\\S+)$"
group_by = "status"
template = "{status}: {n} files"
```

Special variables in the template after `group_by`:

- `{n}` — count of records in this group
- `{first.<field>}` — value of `<field>` from the first record
- `{last.<field>}` — value of `<field>` from the last record
- `{joined.<field>}` — comma-joined values (truncated to 100 chars)

### `template` (optional)

Mustache-style template for output. Variables are the named capture groups
from `match`, plus the group-by aggregates above.

```toml
match = "^(?<file>.+):(?<line>\\d+):(?<text>.+)$"
template = "{file}:{line}  {text}"
```

If no `template` is set, the output is the raw matched record as
`field1=value1 field2=value2 ...`.

### `truncate` (optional)

Maximum number of output lines. Excess lines are dropped and replaced with
a single line per `truncate_message`.

```toml
truncate = 30
truncate_message = "... and {dropped} more"
```

Default `truncate_message` is `"... and {dropped} more (full output: {tee})"`.

### `header` (optional)

A string prepended to the output. Supports the same variables as the body
template plus:

- `{total}` — total input lines
- `{matched}` — number of lines that matched

```toml
header = "{matched}/{total} files modified:"
```

### `footer` (optional)

Same as `header` but appended.

### `min_input_lines` (optional)

If the raw input has fewer lines than this, pass through unchanged.
Sensible default: 5. Avoids "compressing" a single-line output into a
longer template.

```toml
min_input_lines = 10
```

### `enabled` (optional)

Default `true`. Set `false` to disable a filter without deleting the file.

```toml
enabled = false
```

---

## Worked examples

### Example 1: `git status --short`

```toml
# .opencode/qtk/filters/git-status-short.toml
command = "git status --short"

match = "^(?<flags>\\S+)\\s+(?<file>.+)$"
group_by = "flags"
template = "{flags}: {joined.file}"

truncate = 30
header = "{matched} files changed:"
```

Input:

```
 M src/foo.ts
 M src/bar.ts
?? new-file.ts
?? another.ts
 D removed.ts
```

Output:

```
5 files changed:
 M: src/foo.ts, src/bar.ts
??: new-file.ts, another.ts
 D: removed.ts
```

### Example 2: `kubectl get pods`

```toml
# .opencode/qtk/filters/kubectl-pods.toml
command = "kubectl get pods"

# First line is "NAME READY STATUS RESTARTS AGE" — skip it
strip = [
  "^NAME\\s+READY"
]

match = "^(?<name>\\S+)\\s+(?<ready>\\d+/\\d+)\\s+(?<status>\\S+)\\s+(?<restarts>\\d+)\\s+(?<age>\\S+)$"

group_by = "status"
template = "{status}: {n} ({joined.name})"

header = "{matched} pods total"
```

### Example 3: `pip install`

```toml
# .opencode/qtk/filters/pip-install.toml
command = "pip install"

strip = [
  "^Collecting ",
  "^Downloading ",
  "^Requirement already satisfied: ",
  "^  Using cached ",
  "^Installing collected packages: .*",
  "^\\[notice\\]"
]

match = "^Successfully installed (?<pkgs>.+)$"
template = "ok {pkgs}"

# If nothing installed (already satisfied), return "ok no changes"
unmatched = "drop"
footer = "{ matched == 0 ? 'ok no changes' : '' }"
```

### Example 4: `docker compose ps`

```toml
# .opencode/qtk/filters/docker-compose-ps.toml
command = ["docker compose ps", "docker-compose ps"]

strip = ["^NAME\\s+IMAGE"]

match = "^(?<name>\\S+)\\s+(?<image>\\S+)\\s+(?<status>.+?)\\s{2,}"

group_by = "status"
template = "{status}: {n} containers"
header = "{matched} containers:"
```

---

## Composition and ordering

Multiple filters can apply to one command — they run in declaration order.
The first filter's output is the input to the next.

Example: strip ANSI escapes globally, THEN apply per-command filters:

```toml
# .opencode/qtk/filters/00-ansi-strip.toml
command = "*"                                # matches every command
strip = ["\\x1b\\[[0-9;]*[a-zA-Z]"]          # ANSI escape sequence
truncate = 100000                            # don't truncate at this layer
```

The leading `00-` in the filename ensures it runs first (filters are loaded
in lexicographic file order).

---

## Compatibility with RTK's filter format

RTK's `src/filters/*.toml` files use a subset of these keys plus a few
RTK-specific ones. Our import script handles the translation:

| RTK key                 | QTK equivalent                           |
| ----------------------- | ---------------------------------------- |
| `match`                 | `match` (identical)                      |
| `template`              | `template` (identical)                   |
| `strip`                 | `strip` (identical)                      |
| `group_by`              | `group_by` (identical)                   |
| `truncate`              | `truncate` (identical)                   |
| `command`               | `command` (identical)                    |
| `category`              | (ignored — QTK doesn't categorise)       |
| `estimated_savings_pct` | (ignored — we measure actual savings)    |
| `subcommands`           | Expanded into multiple `command` entries |
| `rtk_status`            | (ignored)                                |

Filters imported from RTK get an attribution header:

```toml
# Imported from rtk-ai/rtk
# Original: src/filters/terraform-plan.toml
# Licensed Apache-2.0; re-distributed under MIT with attribution per LICENSE.

command = "terraform plan"
# ... rest of filter
```

---

## Safety constraints

The DSL is **declarative** — there's no command execution, no eval, no
shell-out primitive. The most powerful operation in the DSL is "apply a
regex to a string." This is by design.

Implementation-side guards:

- Regexes are compiled with a 100 ms timeout (no catastrophic backtracking
  shall block the agent loop more than 100 ms per pattern)
- Total output of a filter must be ≤ input length × 2; if exceeded, raw
  output is returned (RTK-style sanity check)
- Filters that throw during compilation are skipped with a warning, not a
  fatal error
- Filters loaded from `.opencode/qtk/filters/` are sandboxed to that
  directory — no `include` or `extends` from arbitrary paths

---

## Hot reload

When you edit a filter file, QTK detects the change (Bun.file watch) and
re-parses the filter at the start of the next tool call. The reload is
per-file — a syntax error in one filter doesn't affect others.

Log line on reload:

```
[qtk] reloaded .opencode/qtk/filters/kubectl-pods.toml — applied to next call
```

If the new filter has a syntax error:

```
[qtk] reload failed for .opencode/qtk/filters/kubectl-pods.toml: <error>
[qtk] keeping previous version of this filter
```

---

## What the DSL doesn't do (deliberately)

- **No imperative logic.** No loops, no conditionals beyond the
  pass-through guard. If you need imperative compression, write a TS
  compressor and ship it as a PR.
- **No FFI / shell-out.** No way to execute commands from a filter.
- **No HTTP / network.** No way to call out to a service.
- **No persistent state.** Each call is independent (the session cache is
  outside the DSL).
- **No multi-file processing.** Each tool call is a single filter pass.

These constraints exist to make filters trivially safe and reviewable. If
you need imperative power, that's what TS compressors are for.
