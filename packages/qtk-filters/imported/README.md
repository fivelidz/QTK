# Imported RTK filters

This directory is the target of `scripts/import-rtk-filters.ts`. It's
**empty by default in the upstream repo** — to populate it, clone RTK
locally and run the import script:

```bash
git clone https://github.com/rtk-ai/rtk /tmp/rtk
bun run scripts/import-rtk-filters.ts /tmp/rtk
```

The script will:

- Read every `*.toml` in `<rtk>/src/filters/` (or `<rtk>/filters/`)
- Drop RTK-only keys (`category`, `estimated_savings_pct`, `rtk_status`,
  `version`, `author`, `description`)
- Prepend an attribution header citing rtk-ai/rtk and Apache-2.0
- Validate the translated filter against QTK's spec
- Write the validated file here

To **use** an imported filter, copy it from here into your opencode
project's `.opencode/qtk/filters/` directory. The plugin reloads on
file change (250 ms debounce), so newly-added filters take effect on
the next matching tool call.

## Licensing

RTK is Apache-2.0 licensed. Apache-2.0 → MIT redistribution is
permitted with attribution. Every imported file carries its original
attribution header.

QTK's TOML filter DSL syntax is intentionally compatible with RTK's,
so most filters work without modification. See `docs/FILTER-DSL.md` in
this repo for the full DSL reference.

## The `_archive/` subdirectory

Holds historical test artifacts used during QTK development. These are
NOT real RTK filters — they're synthetic samples used to verify the
import pipeline. Don't copy them into a real project's filter
directory.
