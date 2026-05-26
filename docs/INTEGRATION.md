# Integrating QTK with opencode

> Step-by-step guide to installing QTK into any opencode-based agent
> (stock [opencode](https://github.com/sst/opencode) ≥ 1.1.21, or compatible
> forks). QTK ships as a plain opencode plugin — no patching of the host.

---

## Prerequisites

- Bun ≥ 1.3.5 (`bun --version`)
- opencode ≥ 1.1.21 (or a fork that loads `@opencode-ai/plugin`-compatible plugins)
- A QTK checkout

In the snippets below, replace `$QTK` with the path to your QTK checkout and
`$OC` with the path to your opencode project root (the directory containing
`.opencode/`).

---

## Install method 1 — symlink (recommended for dev)

This is the path during active QTK development. Changes to QTK's source are
picked up by opencode on the next session start.

```bash
# 1. Build qtk-plugin (creates dist/index.js)
cd "$QTK"
bun install
bun run build

# 2. Symlink into opencode's plugin directory
mkdir -p "$OC/.opencode/plugin"
ln -sfn "$QTK/packages/qtk-plugin" "$OC/.opencode/plugin/qtk"

# 3. Register in opencode.jsonc — add to the "plugin" array:
#       "file://.opencode/plugin/qtk/src/index.ts"

# 4. Restart opencode
```

## Install method 2 — single-file (recommended once stable)

Once QTK is stable in your workflow, copy the built bundle directly. Less
coupling to QTK's source tree.

```bash
cd "$QTK"
bun run build
cp packages/qtk-plugin/dist/index.js "$OC/.opencode/plugin/qtk.js"

# Then in opencode.jsonc:
#   "file://.opencode/plugin/qtk.js"
```

## Install method 3 — automated installer

A convenience script lives at `scripts/install-into-opencode.ts`. Pass the
path to your opencode project root:

```bash
cd "$QTK"
bun run scripts/install-into-opencode.ts "$OC"

# To remove:
bun run scripts/install-into-opencode.ts "$OC" --uninstall
```

The script symlinks the plugin and patches `.opencode/opencode.jsonc`
(creating a `.bak` first).

## Install method 4 — npm (eventually)

Once published:

```bash
cd "$OC"
bun add @qtk/plugin

# In opencode.jsonc:
#   "@qtk/plugin"
```

---

## Verifying the install

After restart, open a fresh opencode session and check the startup output.
You should see:

```
[qtk] active — N compressors registered
[qtk] compressors: read-tool, grep-tool, glob-tool, git-status, ls, rg, pytest, cargo, ...
```

If you see a load error instead, check:

- `.opencode/plugin/qtk` symlink target exists and is readable
- `dist/index.js` exists (run `bun run build` in QTK)
- `opencode.jsonc` has the plugin path correctly listed

---

## Verifying compression works

In the new session, ask the agent to run any of these and watch the
response size:

```
git status
ls -la
rg useEffect packages/
```

Then inspect the stats DB directly:

```bash
sqlite3 "$OC/.opencode/qtk-stats.sqlite" \
  "SELECT tool, compressor, original_bytes, compressed_bytes,
          ROUND(ratio, 2) AS ratio
   FROM compressions
   ORDER BY ts DESC
   LIMIT 20;"
```

Or via the CLI:

```bash
bun "$QTK/packages/qtk-plugin/src/cli/gain.ts"
```

---

## Configuration

Drop a `.opencode/qtk.toml` in your opencode project root to override
defaults:

```toml
[qtk]
enabled = true
log_level = "info"
dedup_ttl_seconds = 60

[qtk.tee]
enabled = true
mode = "failures_and_compressed"
prune_days = 7

[qtk.compressors.git_status]
max_files_shown = 30

[qtk.tools.read]
outline_threshold_lines = 250
```

See `docs/FILTER-DSL.md` for adding custom per-project compressors as TOML
filters in `.opencode/qtk/filters/`.

---

## Coexistence with RTK

If you have [RTK](https://github.com/rtk-ai/rtk) installed already (as
`~/.local/bin/rtk` + the OpenCode plugin at `.opencode/plugin/rtk.ts`),
QTK is additive. The order of plugins in `opencode.jsonc` matters:

```jsonc
{
  "plugin": [
    "file://.opencode/plugin/rtk.ts", // RTK rewrites commands (before)
    "file://.opencode/plugin/qtk", // QTK compresses outputs (after)
  ],
}
```

RTK runs on `tool.execute.before` and rewrites bash commands. QTK runs on
`tool.execute.after` and compresses what comes back. No conflict.

When the agent writes `git status`:

1. RTK turns it into `rtk git status`
2. Bash runs `rtk git status` — RTK's internal git filter produces compact output
3. QTK's git compressor sees the already-compact output, skips
4. Model sees the small compact form

When the agent writes `cat src/foo.ts`:

1. RTK has no rewrite rule for `cat <file>`, passes through
2. Bash runs `cat src/foo.ts` — raw file contents
3. QTK's generic file-content compressor truncates/outlines if large
4. Model sees the compressed form

So even with RTK, QTK catches what RTK misses — particularly built-in tools
(`Read`/`Grep`/`Glob`), which RTK can't reach at all.

---

## Compatibility with local Ollama / vLLM models

QTK is provider-agnostic — it compresses tool outputs the same way regardless
of which model the agent is using. Local Qwen, Llama, Claude Sonnet, GPT-4 —
all see the same compressed outputs.

In fact QTK is **more valuable** for local models because:

- Local models have shorter effective context windows
- Local models pay no monetary cost per token but pay heavily in latency
  and VRAM for long contexts
- Compressing tool outputs lets local models keep more conversation history
  in the same VRAM budget

---

## Uninstalling

```bash
# Remove the symlink/file
rm "$OC/.opencode/plugin/qtk"
# or
rm "$OC/.opencode/plugin/qtk.js"

# Remove from opencode.jsonc plugin array

# Optional: remove the cache/stats files
rm -rf "$OC/.opencode/qtk-tee/"
rm "$OC/.opencode/qtk-stats.sqlite"

# Restart opencode — no QTK
```

---

## Troubleshooting

| Symptom                                 | Likely cause                            | Fix                                                            |
| --------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `[qtk] active` never appears on startup | Plugin not registered in opencode.jsonc | Check the `plugin` array includes the file:// path             |
| Plugin loads but no compression happens | Compressor matches not triggering       | Check `qtk-stats.sqlite` — empty? Compressor names wrong?      |
| Stats DB has entries but ratio is 1.0   | Compressor returning input unchanged    | Likely raw output already short, or compressor has a bug       |
| `qtk-tee/` files are world-readable     | OS umask interfering                    | Open issue — files are written with explicit `mode: 0o600`     |
| Latency spikes per tool call > 50 ms    | Compressor regex backtracking           | Identify offending compressor in stats `duration_ms`, file bug |
| QTK disabled itself mid-session         | Circuit breaker triggered               | Check stderr for which compressor failed 3×; file bug          |
| Memory growing during long session      | Cache LRU not pruning                   | Restart session, file bug — cache should cap at 500 entries    |
