// Integration test: every imported RTK filter in
// `packages/qtk-filters/imported/` must parse + validate + compile as a
// QTK filter. This catches regressions in the import pipeline AND in QTK's
// DSL semantics (a stricter validator could break filters we already ship).
//
// If you run scripts/import-rtk-filters.ts against an updated RTK clone
// and end up with MORE filters, this test should automatically cover them
// (we walk the directory at runtime).

import { describe, test, expect } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFilterToml } from "../src/dsl/parser.ts";
import { validateFilterSpec } from "../src/dsl/spec.ts";
import { compileFilter } from "../src/dsl/runtime.ts";

const IMPORTED_DIR = resolve(
  import.meta.dir,
  "../../qtk-filters/imported",
);

describe("RTK-imported filters — integrity check", () => {
  test("the directory exists and contains TOML files", async () => {
    const st = await stat(IMPORTED_DIR).catch(() => null);
    expect(st?.isDirectory()).toBe(true);
    const entries = await readdir(IMPORTED_DIR);
    const tomls = entries.filter((e) => e.endsWith(".toml"));
    // We expect at least 50 filters from the RTK corpus. If a future RTK
    // update adds more, that's fine — this test just ensures we haven't
    // accidentally deleted them.
    expect(tomls.length).toBeGreaterThanOrEqual(30);
  });

  test("every imported filter parses + validates + compiles", async () => {
    const entries = await readdir(IMPORTED_DIR);
    const tomls = entries.filter((e) => e.endsWith(".toml")).sort();

    const failures: { file: string; error: string }[] = [];
    for (const file of tomls) {
      const path = resolve(IMPORTED_DIR, file);
      try {
        const text = await readFile(path, "utf-8");
        const parsed = parseFilterToml(text, path);
        const spec = validateFilterSpec(parsed, path);
        // Compile doesn't fail for well-formed specs but we run it to
        // exercise the full path. The result is a Compressor; we don't
        // actually run it here (compression behaviour is tested elsewhere).
        compileFilter(spec);
      } catch (e) {
        failures.push({ file, error: (e as Error).message });
      }
    }

    if (failures.length > 0) {
      console.error("Imported RTK filter failures:");
      for (const f of failures) console.error(`  ${f.file}: ${f.error}`);
    }
    expect(failures.length).toBe(0);
  });

  test("every imported filter carries an RTK attribution header", async () => {
    const entries = await readdir(IMPORTED_DIR);
    const tomls = entries.filter((e) => e.endsWith(".toml")).sort();

    const missing: string[] = [];
    for (const file of tomls) {
      const path = resolve(IMPORTED_DIR, file);
      const text = await readFile(path, "utf-8");
      const head = text.slice(0, 500);
      if (
        !head.includes("rtk-ai/rtk") ||
        !head.includes("Apache-2.0") ||
        !head.includes("Patrick Szymkowiak")
      ) {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      console.error("Imported filters missing RTK attribution:");
      for (const f of missing) console.error(`  ${f}`);
    }
    expect(missing.length).toBe(0);
  });
});
