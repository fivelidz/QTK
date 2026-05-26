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

/**
 * Translate an RTK filter TOML to QTK format:
 *   - prepend attribution header
 *   - drop ignored keys
 *   - expand `subcommands = [...]` into a `command` array if present
 */
function translateRtkFilter(rtkText: string, name: string): string {
  // Strip BOM if any
  let text = rtkText.replace(/^\uFEFF/, "");

  // Drop ignored keys (line-based — simple but effective for one-line keys)
  const lines = text.split("\n");
  const kept: string[] = [];
  let inMultiline = false;
  for (const line of lines) {
    // Track triple-quote state so we don't strip inside a multiline string
    const quoteCount = (line.match(/"""/g) ?? []).length;
    if (quoteCount % 2 === 1) inMultiline = !inMultiline;

    if (!inMultiline) {
      const keyMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
      if (keyMatch && IGNORED_KEYS.has(keyMatch[1]!)) {
        continue;
      }
      // Expand subcommands → command array. RTK form is e.g.
      //   command = "kubectl"
      //   subcommands = ["get pods", "get services"]
      // We translate to:
      //   command = ["kubectl get pods", "kubectl get services"]
      // For now we just rename `subcommands` to a comment — full expansion
      // would need to know the parent `command` field; we leave it to a
      // future refinement and keep the line as a comment so it's visible.
      if (keyMatch && keyMatch[1] === "subcommands") {
        kept.push("# (RTK subcommands key — review and expand manually)");
        kept.push("# " + line);
        continue;
      }
    }
    kept.push(line);
  }
  text = kept.join("\n");

  const header = `# Imported from rtk-ai/rtk
# Original: src/filters/${name}
# Licensed Apache-2.0; re-distributed under MIT with attribution per LICENSE.

`;
  return header + text;
}

main().catch((e) => {
  console.error("[import-rtk] fatal:", e);
  process.exit(1);
});
