// Filter loader. Walks `.opencode/qtk/filters/*.toml`, parses + validates each
// file, returns an array of compiled Compressors.
//
// Errors are isolated per-file: a syntax error in one filter doesn't break
// the others. Errors are surfaced as warnings on stdout (matches the rest
// of QTK's logging convention).
//
// Path safety: filter files MUST live under `<projectRoot>/.opencode/qtk/filters/`.
// We refuse symlinks that point outside that directory.

import { resolve, join } from "node:path";
import { readdir, stat, realpath } from "node:fs/promises";
import { parseFilterToml } from "./parser.ts";
import { validateFilterSpec } from "./spec.ts";
import { compileFilter } from "./runtime.ts";
import { FilterParseError, type FilterSpec } from "./types.ts";
import type { Compressor } from "../types.ts";

export interface LoadedFilter {
  readonly spec: FilterSpec;
  readonly compressor: Compressor;
}

export interface LoadResult {
  readonly filters: readonly LoadedFilter[];
  readonly errors: readonly { source: string; error: string }[];
}

/** Default filter directory relative to project root. */
export const DEFAULT_FILTER_DIR = ".opencode/qtk/filters";

/**
 * Load all filters from `<projectRoot>/<filterDir>/*.toml`.
 * Sorted in lexicographic order of filename (so `00-` prefix runs first).
 * Returns at most one filter per file; failed files are returned in `errors`.
 */
export async function loadFilters(
  projectRoot: string,
  filterDir: string = DEFAULT_FILTER_DIR,
): Promise<LoadResult> {
  const dir = resolve(projectRoot, filterDir);
  const projectRootResolved = resolve(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { filters: [], errors: [] };
  }

  const tomlFiles = entries.filter((n) => n.endsWith(".toml")).sort();

  const filters: LoadedFilter[] = [];
  const errors: { source: string; error: string }[] = [];

  for (const name of tomlFiles) {
    const filePath = join(dir, name);

    // Path-confinement: refuse files that resolve outside the project
    try {
      const realFile = await realpath(filePath);
      if (!realFile.startsWith(projectRootResolved + "/")) {
        errors.push({
          source: filePath,
          error: `refusing filter that resolves outside project root: ${realFile}`,
        });
        continue;
      }
      const st = await stat(realFile);
      if (!st.isFile()) {
        errors.push({
          source: filePath,
          error: "not a regular file",
        });
        continue;
      }
    } catch (e) {
      errors.push({ source: filePath, error: (e as Error).message });
      continue;
    }

    try {
      const text = await Bun.file(filePath).text();
      const raw = parseFilterToml(text, filePath);
      const spec = validateFilterSpec(raw, filePath);
      if (!spec.enabled) continue;
      const compressor = compileFilter(spec);
      filters.push({ spec, compressor });
    } catch (e) {
      const msg =
        e instanceof FilterParseError ? e.message : (e as Error).message;
      errors.push({ source: filePath, error: msg });
    }
  }

  return { filters, errors };
}
