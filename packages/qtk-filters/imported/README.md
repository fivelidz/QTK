# Imported RTK filters

This directory contains **59 filters imported from
[rtk-ai/rtk](https://github.com/rtk-ai/rtk)** (Apache-2.0) at commit time
of the bulk-import, run on 2026-05-26. Filters cover: ansible-playbook,
basedpyright, biome, brew-install, bundle-install, composer-install, df,
dotnet-build, du, fail2ban-client, gcc, gcloud, gradle, hadolint, helm,
iptables, jira, jj, jq, just, lsof, make, mise, mvn-build, nmap, nx,
ollama, oxlint, pacman, ping, pip-install, poetry-install, pre-commit,
quarto-render, rg, rsync, ruff-check, shellcheck, skopeo, sops, ss, ssh,
stat, stripe, swift-build, systemctl-status, task, taskfile, terraform,
tofu, tofu-init, tofu-plan, tofu-validate, top, traefik, trunk-build,
turbo, ty, uv-sync, vagrant, vault, vercel, xcodebuild, yadm, yamllint,
ytt-deps.

**You do not need to do anything to use these filters.** They've been
translated to QTK's TOML DSL format and ship as part of the QTK repo.
To activate one, copy it into your opencode project's
`.opencode/qtk/filters/` directory:

```bash
cp packages/qtk-filters/imported/helm.toml /path/to/your/opencode-project/.opencode/qtk/filters/
```

The plugin reloads on file change (250 ms debounce); the next `helm`
invocation will use the filter.

## What got translated

Each imported file is a clean-room translation of the RTK source. The
top of every file is an attribution header citing RTK, Apache-2.0, and
the RTK contributors. The body uses QTK's DSL keys (`command`, `strip`,
`truncate`, …) instead of RTK's (`match_command`, `strip_lines_matching`,
`max_lines`).

RTK features QTK doesn't support yet are preserved as `# RTK: <key> = <val>`
comments inside each file so you can see exactly what was dropped:

- `strip_ansi = true` — QTK passes ANSI through; would need an ansi-strip
  post-pipeline step
- `truncate_lines_at = <N>` — per-line truncate width; QTK doesn't have this
- `match_output = [...]` — RTK's "if output matches pattern, replace with
  short message" feature; closest QTK has is `pass_through_if` (bypass,
  not replace)

Pull requests welcome to add these features to QTK's DSL — see the
`# RTK: ...` comments in each file as a worklist.

## Refreshing from upstream

To pull the latest RTK filters and re-translate:

```bash
git clone https://github.com/rtk-ai/rtk /tmp/rtk
bun run scripts/import-rtk-filters.ts /tmp/rtk
```

The import is idempotent — re-running overwrites existing files in this
directory. It will not touch any filters you've added directly to your
opencode project's `.opencode/qtk/filters/` dir.

## Licensing

RTK is Apache-2.0 © Patrick Szymkowiak, Florian Bruniaux, Adrien Eppling
and the RTK contributors. Apache-2.0 → MIT redistribution is permitted
with attribution; every file in this directory carries its original
attribution as a comment header. See QTK's `LICENSE` for the full notice.

If you find a filter that translates incorrectly, please file an issue
on QTK's repo — and **also consider filing it upstream on RTK** if the
underlying RTK filter has a bug. RTK is the canonical source.

## The `_archive/` subdirectory

Holds historical test artifacts used during QTK development. These are
NOT real RTK filters — they're synthetic samples used to verify the
import pipeline. Safe to ignore.
