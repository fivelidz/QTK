# Draft: outreach note to the RTK community

> This is a DRAFT for posting as a GitHub Discussion on
> [rtk-ai/rtk](https://github.com/rtk-ai/rtk/discussions) or as an
> introduction post in their Discord. **Not yet posted.** The user
> should review tone + timing before publishing. The intent is to be
> respectful, transparent, and helpful — not to advertise, and
> definitely not to compete.

---

## Title

> Heads-up: QTK — opencode-plugin spiritual sibling, with import-rtk-filters

## Body

Hey RTK team and community,

I built a small opencode-specific spiritual sibling of RTK called QTK
("Qalarc Token Killer") and wanted to give you a heads-up rather than
have it surface elsewhere and look like a fork situation.

**TL;DR:** [github.com/fivelidz/QTK](https://github.com/fivelidz/QTK). MIT
licensed. opencode plugin only. The whole project is downstream of RTK
— RTK is the canonical work, RTK ships the 100+ filter corpus, RTK
serves 13 different AI coding agents. QTK is what you do if you
specifically use opencode and want to hook `tool.execute.after` inside
the agent rather than running an external CLI proxy.

A few notes for your visibility:

### What QTK does that RTK does

- TOML filter DSL — intentionally compatible with your syntax so
  filters can round-trip. Imports `match_command`, `strip_lines_matching`,
  `max_lines`, plus the structural keys.
- Bulk-import script (`scripts/import-rtk-filters.ts`) translates your
  `src/filters/*.toml` corpus into QTK format with full Apache-2.0
  attribution per file (Patrick Szymkowiak, Florian Bruniaux, Adrien
  Eppling and the RTK contributors). I ran it once against your
  current main; all 59 filters imported and validated as QTK specs.
  They ship under `packages/qtk-filters/imported/`.

### What QTK does that RTK doesn't (yet, in opencode)

- Hooks `tool.execute.after` (output-side compression) instead of
  rewriting bash commands → covers `Read`, `Grep`, `Glob`, and MCP
  tools, not just `Bash`
- In-process plugin, no subprocess fork per call (~30µs median vs
  ~5-15ms for the bash hook)
- Per-session in-memory dedup cache for identical repeated outputs
- Per-project savings sidecar JSON for cross-tool dashboards (we wire
  it into a multi-pane terminal tool we built called gmux to show
  live token-saved + USD-saved per agent)

### What RTK does that QTK doesn't (and probably never will)

- Cross-agent support — RTK serves 13 tools. We only handle opencode
  because that's where the in-process plugin hook lives.
- Mature filter corpus and a process for upstreaming new filters
- Production telemetry-with-consent for real measured value across users
- Windows support (we don't try)

### What we're explicitly NOT doing

- We're not competing for the same users. The README's "Read this
  first" block tells anyone not on opencode to install RTK instead, by
  name, with a `brew install rtk` example.
- We're not soaking up funding. `.github/FUNDING.yml` is a no-op file
  redirecting any sponsorship interest upstream to RTK (if/when you
  enable Sponsors).
- We're not silently borrowing your filter corpus. Every imported file
  carries the Apache-2.0 NOTICE and your three names. The LICENSE
  attribution section explicitly cites you per Apache-2.0 §4(b).

### Things I'd love your input on if/when you have a minute

1. **Filter DSL deltas.** A few RTK features QTK doesn't have a
   1:1 equivalent for: `strip_ansi`, `truncate_lines_at` (per-line
   truncate width), and the `match_output = [{pattern, message}]`
   feature for "replace with short message when pattern seen". I've
   preserved these as `# RTK: ...` comments in the imported files so
   they don't silently disappear. Want to add these to QTK to make
   the DSL fully RTK-compatible — would you mind if I copy the
   semantics directly?

2. **Filter corpus refresh.** Right now QTK ships a snapshot of your
   filters as-of import day. Is there a workflow you'd prefer for
   keeping QTK's `imported/` directory in sync — maybe a periodic
   GitHub Action that re-runs my import script and opens a PR? Or
   would you prefer we deliberately diverge and only sync on demand?

3. **Cross-project collaboration.** If there's anywhere QTK should
   point users back to RTK that I've missed, please let me know. I've
   tried to be diligent about credit — README front matter,
   `docs/RTK-COMPARISON.md`, LICENSE, blog posts, release notes —
   but I'm one pair of eyes.

I'm not asking for any official endorsement and I'll absolutely
respect "we'd rather you didn't" if that's the answer. Happy to make
changes to attribution, framing, scope, anything.

Thanks for building RTK in the first place — without it the
deterministic-compression idea would have stayed a hunch instead of a
shipped product, and QTK wouldn't exist.

— fivelidz · [qalarc.com](https://qalarc.com)

---

## Why this draft exists

Before posting to RTK's community channels, the user should:

1. Decide whether they want to introduce QTK to RTK at all. Some
   project leads prefer to discover downstream forks organically
   rather than be pinged about them — others appreciate the courtesy.
   Default: post the note.
2. Skim the tone. The draft above tries hard to be deferential
   without grovelling. Adjust if you'd rather sound more peer-level
   or more "thanks for everything".
3. Pick the right venue. RTK has [GitHub
   Discussions](https://github.com/rtk-ai/rtk/discussions),
   [Discord](https://discord.gg/...), and an
   [issues](https://github.com/rtk-ai/rtk/issues) tracker. The
   Discussions board is probably the right place (Discord may be
   too informal; issues are wrong for non-issue content).
4. Maybe wait until QTK has a real user — ideally one other than
   yourself — so you can credibly describe what people are doing
   with it. As of this commit, QTK has been used by exactly one
   person (you) in one project. That's fine to disclose; just be
   factual ("I built this in May 2026, I'm using it myself").

Once posted, link the post URL back into this file and rename it
`RTK-OUTREACH.md` (dropping `-DRAFT`).
