# QTK Security Posture

> Building a tool that sits inside an AI agent's tool-call lifecycle is a
> high-trust position. This doc explains what we don't do, what we do
> instead, and the design decisions that came directly out of auditing
> RTK.

---

## Threat model

QTK runs inside opencode, which runs locally as the user. The threat surface
is therefore:

1. **Malicious tool output** — an attacker controls what `cargo`, `git`, or
   a remote MCP server    returns to opencode (e.g. by tricking the agent into
   running a command that hits an attacker-controlled server).
2. **Malicious or buggy config** — `.opencode/qtk.toml` is read from the
   project directory; an attacker who can write to the project (e.g. a
   compromised dependency, or untrusted code the user `git clone`d) can
   influence QTK's behaviour.
3. **Compromised QTK supply chain** — somebody publishes a malicious version
   of QTK to npm/git.
4. **Buggy compressor regex** — catastrophic backtracking on adversarial
   input could DoS the agent loop.
5. **Tee files leaking secrets** — output we tee to disk may contain
   secrets (AWS keys printed by `env`, OAuth tokens in `git remote -v` URLs,
   etc.); if file perms are wrong, other users on a multi-user system can
   read them.

---

## Hard rules — properties of QTK that hold by construction

### 1. QTK never executes code

The bash tool runs the command. The Read/Grep/Glob tools run their own
filesystem operations. QTK is a pure string-in-string-out transformer over
the result. We **never** call `Bun.spawn`, `child_process.exec`,
`new Function`, `eval`, or anything equivalent.

**Why this matters:** RTK has documented `sh -c <user_input>` paths in
`rtk summary`, `rtk err`, `rtk test`, and `rtk proxy` (RTK audit §2.1). These
are intentional features for chaining commands, but they create a path
from "agent can produce a string" to "shell executes that string." QTK
eliminates this surface entirely. If you `rg -i "spawn|exec|eval|Function\(" qtk-plugin/src/` you should get **zero matches** in non-test code.

### 2. QTK has no network code

Not opt-in, not opt-out. There is no HTTP client, no fetch call, no socket
open. `package.json` of `@qtk/plugin` has no `axios`, no `node-fetch`, no
`undici`, no `ureq`-equivalent. If you grep the source for `fetch(`,
`http://`, `https://`, you should get only doc-comment references.

**Why this matters:** RTK's biggest unverifiable claim is what its
telemetry endpoint actually does — the URL is baked into release binaries
at build time via `option_env!("RTK_TELEMETRY_URL")` and the source doesn't
disclose it. RTK addresses this by making telemetry opt-in. QTK addresses
it by **not having any network code at all**, so there is nothing to
verify.

### 3. QTK never modifies the command

The model writes `git status` → the bash tool runs `git status` → QTK sees
the output of `git status`. QTK does not change `args.command` (that's the
`tool.execute.before` hook, which QTK doesn't use). The model's intent is
preserved exactly.

**Why this matters:** if QTK had a bug in command rewriting, it could
silently substitute one command for another. We avoid this entire class
of bugs by not touching the command.

### 4. QTK never crashes the agent

Every code path in `tool.execute.after` is wrapped in a top-level try/catch
that falls back to the original output. Compressor failures are tracked by
a per-session circuit breaker — three failures and that compressor is
disabled for the rest of the session.

The integration test suite includes deliberately-broken compressors and
verifies the agent loop continues unimpeded.

### 5. Tee files are 0o600 explicitly

```ts
await Bun.write(path, raw, { mode: 0o600 });
```

The tee directory is created `0o700`. We do **not** rely on the process
umask. RTK uses `std::fs::write` which inherits umask — on most Linux
systems that's `0o022`, producing `0o644` (world-readable) tee files. On a
shared system, that's a real privacy leak. QTK does not have this bug.

### 6. Tee directory is path-confined

The tee directory is configurable via `.opencode/qtk.toml`, but the loaded
config is **path-canonicalised** and **must resolve inside the project
directory**. We do NOT honour environment variables for path overrides.

**Why this matters:** RTK honours `RTK_TEE_DIR` with no validation (audit
§3.2), meaning a process that can set the env var can redirect tee output
to anywhere. QTK only reads `.opencode/qtk.toml` (which the user controls)
and validates the resulting path is inside `cwd`.

---

## Soft rules — properties we maintain through code review

These aren't enforced by the type system but are checked at PR time and in
the test suite.

### Regex catastrophic backtracking

Every regex in the compressors is required to be linear-time. Anything that
could backtrack catastrophically (e.g. `(a+)+`) is flagged in review. We test
each compressor against pathological inputs (10 MB of `aaa...`, deeply nested
brackets, etc.) and require p99 latency under 50 ms.

### No `any` types in security-sensitive paths

The path resolution code (`config.ts`), the tee writer (`tee.ts`), the
fingerprint hasher (`cache.ts`) are required to be fully typed. The
`tsconfig.json` `strict: true` enforces this.

### Bounded output sizes

A compressor that produces output **larger** than its input is rejected.
This is checked at the wrapper layer:

```ts
const compressed = compressor.compress(raw, ctx);
if (compressed.length > raw.length) {
  log.warn("compressor produced larger output, falling back", { name });
  return raw;
}
return compressed;
```

### Secrets-aware tee

Some commands emit secrets. The tee writer scans output for common secret
patterns (AWS access keys, GitHub tokens, common API key prefixes) and
either:

- redacts them inline before writing, OR
- writes a placeholder file and a separate `.redacted` file (mode 0o600)

This is best-effort — we don't try to be a DLP solution. But the obvious
cases shouldn't be on disk in plaintext.

Patterns scanned:

- `AKIA[0-9A-Z]{16}` (AWS access key)
- `ASIA[0-9A-Z]{16}` (AWS temp credentials)
- `ghp_[A-Za-z0-9_]{36,}` (GitHub PAT classic)
- `github_pat_[A-Za-z0-9_]{82}` (GitHub PAT fine-grained)
- `sk-[A-Za-z0-9]{40,}` (OpenAI / Anthropic key)
- `xoxb-[0-9]+-[0-9]+-[0-9]+-[a-z0-9]+` (Slack bot token)
- Strings matching `[A-Za-z0-9+/]{40,}={0,2}` AFTER a `password|secret|token|key` keyword on the same line
- Bearer tokens in `Authorization:` headers (e.g. from `curl -v`)

---

## Comparing against the RTK audit findings

For each RTK audit finding, here's QTK's posture:

| RTK Finding                                             | RTK Severity | QTK posture                                                                      |
| ------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| §2.1 `sh -c user_input` in summary/err/test             | HIGH         | Doesn't exist (QTK never executes anything)                                      |
| §7.1 Install script no signature verification           | HIGH         | Doesn't apply (QTK is a plugin file, no installer)                               |
| §3.1 Tee files 0o644 (umask-default)                    | Medium       | Explicit 0o600                                                                   |
| §3.2 RTK_TEE_DIR env env-redirect, no validation        | Medium       | Config-only path, canonicalised to project root                                  |
| §9.1 Agent-callable shell wrappers                      | Medium       | Doesn't apply (no CLI wrappers)                                                  |
| §1.1 Telemetry URL baked at build time                  | Medium       | No network code at all                                                           |
| §9.3 Probes `~/.claude/`, `~/.gemini/` to detect agent  | Low          | Doesn't apply                                                                    |
| §1.3 Telemetry passthrough_top granularity unverifiable | Low          | No telemetry endpoint exists                                                     |
| §4.3 `git rev-parse` output as path no canonicalize     | Low          | We don't shell out to git                                                        |
| §5.3 Glob middle-wildcard matches broader than docs     | Low          | We don't have a permission system to bypass                                      |
| §3.3 Tee writes have no symlink protection              | Low          | We use Bun.write which respects O_NOFOLLOW when given `mode` (verify in testing) |
| §1.4 No auto-update                                     | Info+        | Same — no auto-update                                                            |
| §2.3 Lexer is quote-aware                               | Info+        | We don't lex anything                                                            |
| §4.1 Primary execution uses argv arrays                 | Info+        | We don't execute anything                                                        |
| §5.1 Issue #1155 fix verified                           | Info+        | No permission protocol exists                                                    |
| §5.2 Issue #1213 fix verified                           | Info+        | No permission protocol exists                                                    |
| §7.2 `build.rs` is clean                                | Info+        | We have no build.rs                                                              |

---

## Audit checklist for QTK itself

To make this concrete, the same questions someone might ask of RTK, asked
of QTK:

| Question                                               | Answer                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| What URLs does QTK call?                               | None. There is no HTTP client.                                                                   |
| Where is telemetry sent?                               | Local SQLite. No network code exists.                                                            |
| Can a malicious command output execute code via QTK?   | No — QTK never executes anything.                                                                |
| Where does QTK write to disk?                          | `.opencode/qtk-tee/` (mode 0o700), `.opencode/qtk-stats.sqlite`. Nowhere else.                   |
| Permissions on tee files?                              | 0o600 explicit                                                                                   |
| Can the tee directory be redirected?                   | Only via `.opencode/qtk.toml`, must canonicalise to inside project. Env vars are ignored.        |
| Does QTK auto-update?                                  | No.                                                                                              |
| Does QTK have unsafe code paths?                       | No — pure TypeScript, no `eval`/`Function`/`spawn`.                                              |
| Does QTK introduce new dependencies?                   | Only `bun:sqlite` (built into Bun) and `@opencode-ai/plugin` types.                              |
| Can a malicious `.opencode/qtk.toml` exfiltrate data?  | No — config has no `command_exec` or equivalent. Path overrides are constrained to project root. |
| Can a malicious filter `.toml` (Phase 2) execute code? | No — filter DSL is declarative (regex + templates), no command execution primitive.              |
| Does QTK respect `OPENCODE_OFFLINE`?                   | Yes — it's already offline. No network code exists.                                              |

---

## Reporting a security issue

If you find one, email the project maintainer directly. Don't open a public
issue. We're a one-person project; please give us a chance to fix things
before disclosure.

---

## Things we explicitly did not do, and why

### We did not write QTK in Rust

Rust has obvious appeals for a tool like this: memory safety, performance,
small static binaries. We considered it. But:

- The in-process Rust → TS bridge in Bun (`bun:ffi` etc.) is doable but
  adds complexity for marginal latency wins on the typical-size outputs we
  see (a few KB).
  - The plugin must load into opencode's TS runtime. Going Rust means going
    out-of-process, which negates the entire latency win of being in-process.
- Phase 3 introduces an _optional_ Rust sidecar `qtk-core` for genuinely
  expensive parsers — but only as a sidecar, not as the main plugin.

### We did not add a permission/allow/deny protocol

RTK's exit-code protocol for permissions (`Allow=0, Passthrough=1, Deny=2,
Ask=3`) is a careful piece of design that took several rounds to get right
(see issues #1155, #1213). QTK doesn't have an equivalent because we don't
need one — we don't modify commands or grant any new capability. The agent's
existing permission system continues to govern what commands can run; QTK is
purely a post-processing step.

### We did not add a TOML DSL in Phase 1

The DSL is Phase 2 deliberately. Phase 1 ships hand-written TypeScript
compressors. Two reasons:

1. We want to learn from real usage what filter shapes are common before
   committing to a DSL syntax. Even if we copy RTK's DSL verbatim, we might
   discover opencode-specific extensions.
2. A type-checked TS compressor is faster to iterate on for the initial
   batch of high-value filters. Phase 2 then adds the DSL for community/user
   filters.


---

## Reporting a vulnerability

If you find a security issue in QTK, please **do not** open a public GitHub
issue. Instead, email the maintainer at the address listed on the GitHub
profile (`@fivelidz`) or open a private security advisory at:

  https://github.com/fivelidz/QTK/security/advisories/new

Please include:

- A description of the issue and which file(s) / functions are affected
- A minimal reproduction (a TOML filter, a tool output, or a sidecar
  request that triggers the problem)
- The expected vs actual behaviour
- Whether you 're happy to be credited in the eventual fix announcement

We commit to:

- Acknowledging the report within 7 days
- Providing an initial assessment within 14 days
- Disclosing fixed vulnerabilities in `CHANGELOG.md` and (if appropriate)
  in a GitHub Security Advisory once a fix has shipped

QTK is a small single-maintainer project. We do not have a bug-bounty
program, but we will credit good-faith reporters in `CHANGELOG.md` (if
you want to be named).

### Out of scope

- Issues in opencode itself — please report to upstream
  (https://github.com/sst/opencode/security)
- Issues in RTK (which QTK derives some of its DSL design from) —
  please report to RTK (https://github.com/rtk-ai/rtk/security)
- Issues in Bun, Rust, quick-xml, serde, regex, or other dependencies —
  please report to those upstreams directly
- Reports that boil down to "if the user 's opencode config points at a
  malicious plugin, the plugin can do bad things" — this is the inherent
  trust model of opencode plugins and isn't specific to QTK

### Disclosure policy

Default: coordinated disclosure with a 90-day deadline from initial
acknowledgement. If a fix isn't practical within that window, we'll
discuss extensions or partial disclosures with the reporter.

