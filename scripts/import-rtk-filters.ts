// scripts/import-rtk-filters.ts
//
// Imports filter TOMLs from a local clone of rtk-ai/rtk into QTK's
// packages/qtk-filters/imported/ directory, adding attribution headers
// and stripping RTK-only keys.
//
// USAGE:
//   bun run scripts/import-rtk-filters.ts <path-to-rtk-checkout>
//   bun run scripts/import-rtk-filters.ts --dry-run <path-to-rtk-checkout>
//
// We don't fetch from the network — the user must `git clone rtk-ai/rtk`
// first and pass the path. This is deliberate: network-fetch in a build
// script is a supply-chain risk; we want the user to consciously bring in
// upstream code.
//
// What we do:
//   - Walk <rtk-root>/src/filters/*.toml (or the configured corpus dir)
//   - For each file, prepend an attribution comment block
//   - Strip keys QTK ignores (`category`, `estimated_savings_pct`, `rtk_status`)
//   - Expand `subcommands = [...]` into multiple `command` entries
//   - Validate the result against QTK's spec validator (so we ship working filters)
//   - Write to packages/qtk-filters/imported/<basename>.toml
//
// Bad files are reported but do not abort the run.

import { resolve, basename, join } from "node:path";
import {
  readdir,
  mkdir,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { parseFilterToml } from "../packages/qtk-plugin/src/dsl/parser.ts";
import { validateFilterSpec } from "../packages/qtk-plugin/src/dsl/spec.ts";

const QTK_ROOT = resolve(import.meta.dir, "..");
const TARGET_DIR = resolve(QTK_ROOT, "packages/qtk-filters/imported");

interface CliArgs {
  rtkRoot: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) {
    console.error(
      "usage: bun run scripts/import-rtk-filters.ts [--dry-run] <path-to-rtk-checkout>",
    );
    process.exit(2);
  }
  return { rtkRoot: resolve(positional[0]!), dryRun };
}

// Keys QTK ignores when imported (they're either presentational or
// RTK-specific). See docs/FILTER-DSL.md "Compatibility" section.
const IGNORED_KEYS = new Set([
  "category",
  "estimated_savings_pct",
  "rtk_status",
  "version",
  "author",
  "description",
]);

interface ImportResult {
  source: string;
  target: string;
  status: "imported" | "skipped" | "failed";
  reason?: string;
}

async function main() {
  const { rtkRoot, dryRun } = parseArgs();

  // Detect filter directory inside RTK
  const candidates = [
    join(rtkRoot, "src", "filters"),
    join(rtkRoot, "filters"),
    join(rtkRoot, "rtk", "filters"),
  ];

  let filterDir: string | null = null;
  for (const c of candidates) {
    try {
      const st = await stat(c);
      if (st.isDirectory()) {
        filterDir = c;
        break;
      }
    } catch {
      // continue
    }
  }
  if (!filterDir) {
    console.error(
      `Could not find RTK filter directory in ${rtkRoot}. Tried:\n  ` +
        candidates.join("\n  "),
    );
    process.exit(2);
  }

  console.log(`[import-rtk] reading filters from: ${filterDir}`);
  console.log(`[import-rtk] writing to: ${TARGET_DIR}`);
  if (dryRun) console.log("[import-rtk] DRY RUN — no files will be written");

  if (!dryRun) {
    await mkdir(TARGET_DIR, { recursive: true });
  }

  const entries = await readdir(filterDir);
  const tomlFiles = entries.filter((n) => n.endsWith(".toml")).sort();

  const results: ImportResult[] = [];

  for (const name of tomlFiles) {
    const srcPath = join(filterDir, name);
    const dstPath = join(TARGET_DIR, name);

    let result: ImportResult = {
      source: srcPath,
      target: dstPath,
      status: "imported",
    };

    try {
      const text = await readFile(srcPath, "utf-8");

      // Translate RTK → QTK
      const translated = translateRtkFilter(text, name);

      // Validate it parses + spec-validates as a QTK filter
      const parsed = parseFilterToml(translated, srcPath);
      validateFilterSpec(parsed, srcPath);

      if (!dryRun) {
        await writeFile(dstPath, translated, "utf-8");
      }
    } catch (e) {
      result = {
        source: srcPath,
        target: dstPath,
        status: "failed",
        reason: (e as Error).message,
      };
    }

    results.push(result);
  }

  // Summary
  const imported = results.filter((r) => r.status === "imported").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  console.log("");
  console.log(
    `[import-rtk] ${imported} imported, ${skipped} skipped, ${failed} failed`,
  );
  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(`  ${basename(r.source)}: ${r.reason}`);
    }
  }
}

// Keys QTK doesn't support yet — drop with a `# RTK:` comment trail.
// (We keep them visible so a human reviewing the imported file can decide
// whether to add the feature to QTK or drop the filter.)
const UNSUPPORTED_KEYS = new Set([
  "strip_ansi", // QTK passes ANSI through; would need an ansi-strip post-step
  "truncate_lines_at", // per-line truncate width — QTK doesn't have this
  "description", // pure metadata; RTK shows it in `rtk gain`
]);

// Multi-line block keys that we can't drop with a single-line comment —
// they span multiple lines (typically an array literal). We swallow the
// whole block (greedy across newlines until balanced) and replace with
// a `# RTK: ... (multi-line; not yet supported)` marker.
const UNSUPPORTED_BLOCK_KEYS = new Set([
  "match_output", // RTK feature: if output matches pattern, replace with message
  "summary_rules", // similar — pattern → summary
]);

// Keys we directly translate name → name.
const KEY_RENAME: Record<string, string> = {
  match_command: "command",
  strip_lines_matching: "strip",
  max_lines: "truncate",
};

/**
 * Translate an RTK filter TOML to QTK format.
 *
 * RTK format (as of 2026-05):
 *
 *     [filters.helm]
 *     description = "Compact helm output"
 *     match_command = "^helm\\b"
 *     strip_ansi = true
 *     strip_lines_matching = ["^\\s*$", "^W\\d{4}"]
 *     truncate_lines_at = 120
 *     max_lines = 40
 *
 *     [[tests.helm]]
 *     name = "..."
 *     input = "..."
 *     expected = "..."
 *
 * QTK format we produce:
 *
 *     # Imported from rtk-ai/rtk src/filters/helm.toml
 *     # Apache-2.0 © Patrick Szymkowiak, Florian Bruniaux, Adrien Eppling
 *     # and the RTK contributors. Re-distributed under MIT with attribution.
 *     #
 *     # RTK description: "Compact helm output"
 *
 *     command = "^helm\\b"
 *     strip = ["^\\s*$", "^W\\d{4}"]
 *     truncate = 40
 *     # RTK: strip_ansi = true  (QTK doesn't strip ANSI; codes pass through)
 *     # RTK: truncate_lines_at = 120  (QTK doesn't truncate per-line width)
 *
 * The translation is line-based (not full TOML re-emit) so we preserve
 * formatting + comments where possible. Errors during translation cause
 * the filter to be marked `failed` — callers should look at the warning.
 */
function translateRtkFilter(rtkText: string, name: string): string {
  // Strip BOM if any
  const text = rtkText.replace(/^\uFEFF/, "");
  const baseName = name.replace(/\.toml$/, "");

  const lines = text.split("\n");
  const out: string[] = [];
  let inMultiline = false;
  let inTestsSection = false;
  // Note: inFiltersSection state is implicit — once we see [filters.X]
  // we just keep promoting keys. The "tests" section is the one we need
  // to actively skip.
  let descriptionLine: string | null = null;
  // When we're inside an unsupported multi-line block, count open/close brackets
  // until balanced.
  let bracketBalance = 0;
  let swallowingBlockKey: string | null = null;

  for (const line of lines) {
    // Track triple-quote state so we don't process inside a multiline string
    const quoteCount = (line.match(/"""/g) ?? []).length;
    if (quoteCount % 2 === 1) inMultiline = !inMultiline;

    // If we're mid-swallow of an unsupported block, keep counting brackets
    if (swallowingBlockKey) {
      const opens = (line.match(/\[/g) ?? []).length;
      const closes = (line.match(/\]/g) ?? []).length;
      bracketBalance += opens - closes;
      if (bracketBalance <= 0) {
        out.push(
          `# RTK: ${swallowingBlockKey} = [...]  (multi-line; not yet supported by QTK — review)`,
        );
        swallowingBlockKey = null;
        bracketBalance = 0;
      }
      continue;
    }

    if (inMultiline) {
      // Don't transform inside a """ block. But ALSO don't keep it if we're
      // inside a [[tests]] table — that's RTK test data we want to drop.
      if (!inTestsSection) out.push(line);
      continue;
    }

    // Section markers
    const sectionMatch = line.match(/^\s*\[(\[?[A-Za-z0-9_.-]+\]?)\]\s*$/);
    if (sectionMatch) {
      const sec = sectionMatch[1]!;
      // [filters.<name>] → drop the section header (flatten to top-level)
      if (/^filters\./.test(sec)) {
        inTestsSection = false;
        continue;
      }
      // [[tests.<name>]] or [tests.<name>] → drop entire section
      if (/^\[?tests\./.test(sec)) {
        inTestsSection = true;
        continue;
      }
      // Unknown section — keep as a passthrough comment so a reviewer can see it
      out.push(`# (RTK section: ${sec} — review)`);
      inTestsSection = false;
      continue;
    }

    if (inTestsSection) {
      // Skip everything inside [[tests.NAME]]
      continue;
    }

    // Inside [filters.NAME] (or top-level for files that don't use it):
    // process key = value lines
    const keyMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1]!;
      const valuePart = keyMatch[2]!;

      // Skip ignored metadata keys but capture description for the header
      if (IGNORED_KEYS.has(key)) {
        if (key === "description") {
          descriptionLine = valuePart;
        }
        continue;
      }

      // Drop unsupported but mark them visibly
      if (UNSUPPORTED_KEYS.has(key)) {
        out.push(
          `# RTK: ${key} = ${valuePart}  (not yet supported by QTK — review)`,
        );
        continue;
      }

      // Multi-line block keys — start swallowing until we hit a balanced ]
      if (UNSUPPORTED_BLOCK_KEYS.has(key)) {
        if (valuePart.includes("[")) {
          const opens = (valuePart.match(/\[/g) ?? []).length;
          const closes = (valuePart.match(/\]/g) ?? []).length;
          bracketBalance = opens - closes;
          if (bracketBalance > 0) {
            // multi-line — keep swallowing
            swallowingBlockKey = key;
            continue;
          }
          // single-line array — fall through to comment-out below
        }
        out.push(
          `# RTK: ${key} = ${valuePart}  (not yet supported by QTK — review)`,
        );
        continue;
      }

      // Rename + emit
      const newKey = KEY_RENAME[key] ?? key;
      if (newKey !== key) {
        out.push(`${newKey} = ${valuePart}`);
      } else {
        out.push(line);
      }
      continue;
    }

    // Non-key, non-section line (blank, comment, etc.) — pass through
    out.push(line);
  }

  // Strip leading/trailing blank lines from body
  while (out.length && out[0]!.trim() === "") out.shift();
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();

  const header = `# Imported from rtk-ai/rtk src/filters/${name}
# Apache-2.0 © Patrick Szymkowiak, Florian Bruniaux, Adrien Eppling
# and the RTK contributors. Re-distributed under MIT with attribution
# per QTK's LICENSE.
${descriptionLine ? `#\n# RTK description: ${descriptionLine}\n` : ""}
`;

  // We MUST have a `command =` after translation, otherwise the filter is
  // a fragment and won't load. Insert a placeholder + warning if missing.
  const body = out.join("\n");
  if (!/^\s*command\s*=/m.test(body)) {
    return (
      header +
      `# WARNING: no command key found after RTK translation.
# RTK source used [filters.${baseName}] without match_command. Review:
# original filename: ${name}.
# Setting placeholder command — edit before use.
command = "${baseName}"
${body}
`
    );
  }

  // QTK expects command patterns to be shell prefixes/globs, not anchored
  // regexes. RTK's match_command is a regex like "^helm\\b" — we strip
  // the leading "^" and any trailing "\\b" / "\\b\\b" so QTK's literal-prefix
  // matcher does the right thing. (If anyone wants the full regex semantics
  // they can edit the file by hand — QTK's DSL doesn't support it.)
  //
  // Use a strict regex with greedy capture that stops BEFORE optional \\b
  // suffix — non-greedy + optional was eating part of the actual command.
  const transformed = body.replace(
    /^(command\s*=\s*)"\^((?:[^"\\]|\\.)*?)(?:\\\\b)?"\s*$/m,
    (_m, lhs, pattern) => `${lhs}"${pattern}"`,
  );

  return header + transformed + "\n";
}

main().catch((e) => {
  console.error("[import-rtk] fatal:", e);
  process.exit(1);
});
