# @qalarc/qtk-plugin

> opencode plugin for deterministic, in-process token compression of tool
> outputs. Downstream of [RTK (rtk-ai/rtk)](https://github.com/rtk-ai/rtk).

[![npm](https://img.shields.io/npm/v/@qalarc/qtk-plugin)](https://www.npmjs.com/package/@qalarc/qtk-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/qalarc/QTK/blob/main/LICENSE)
[![downstream of](https://img.shields.io/badge/downstream%20of-RTK-orange)](https://github.com/rtk-ai/rtk)

This is the npm-publishable package containing the TypeScript opencode
plugin. The full project (including the Rust sidecar `qtk-core`, the
RTK filter import script, and all docs) lives at:

  **https://github.com/qalarc/QTK**

If you're not using opencode specifically, you almost certainly want
[RTK](https://github.com/rtk-ai/rtk) instead — RTK supports 13 AI
coding tools (Claude Code, Cursor, Gemini CLI, Copilot, OpenCode,
Codex, Windsurf, Cline, Roo Code, OpenClaw, Hermes, Kilo Code, and
Google Antigravity) and ships a 100+ filter corpus.

## Install

```bash
cd /path/to/your/opencode-project
bun add @qalarc/qtk-plugin
```

Then register it in `.opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "@qalarc/qtk-plugin"
  ]
}
```

Restart opencode. You should see `[qtk] active — N compressors registered`.

## What it does

QTK hooks `tool.execute.after` in opencode and silently rewrites tool
outputs to a compact form before the model sees them. Typical
compression: 60-99% reduction on `git status`, `ls -la`, `rg`,
`pytest`, `cargo`, `Read`, `Grep`, `Glob` tool calls.

For per-project custom compressors, drop TOML files into
`.opencode/qtk/filters/`. Format is intentionally compatible with
RTK's filter DSL.

For heavy parsers (JUnit XML, terraform plan, kubectl YAML/JSON, cargo
JSON), install the optional `qtk-core` Rust binary too. The plugin
auto-detects it; if missing, it just falls back to the TypeScript
compressors silently.

## Docs

- **Full README**: https://github.com/qalarc/QTK
- **Filter DSL reference**: https://github.com/qalarc/QTK/blob/main/docs/FILTER-DSL.md
- **Integration guide**: https://github.com/qalarc/QTK/blob/main/docs/INTEGRATION.md
- **vs RTK comparison**: https://github.com/qalarc/QTK/blob/main/docs/RTK-COMPARISON.md

## License

MIT.

QTK derives its TOML filter DSL from
[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) by
Patrick Szymkowiak, Florian Bruniaux, Adrien Eppling and the RTK
contributors. Apache-2.0. See the LICENSE file in this package for
the full attribution NOTICE.
