// .opencode/qtk.toml loader. Path-safe — config paths are constrained to
// inside the project directory; env-var overrides are deliberately NOT
// honoured (see SECURITY.md §3.6).

import { resolve, isAbsolute } from "node:path";
import type { QtkConfig } from "./types.ts";

const DEFAULT_CONFIG: QtkConfig = {
  enabled: true,
  logLevel: "info",
  dedupTtlSeconds: 60,
  tee: {
    enabled: true,
    directory: ".opencode/qtk-tee",
    mode: "failures_and_compressed",
    pruneDays: 7,
  },
  stats: {
    enabled: true,
    database: ".opencode/qtk-stats.sqlite",
  },
  compressors: {},
  tools: {},
};

/**
 * Resolve a config-supplied path safely against the project root.
 *
 * @returns absolute path on success, or null if path escapes the project
 *          root (which we refuse — see SECURITY §3 / §5).
 */
export function resolveSafePath(
  projectRoot: string,
  configPath: string,
): string | null {
  if (!configPath) return null;
  const abs = isAbsolute(configPath)
    ? configPath
    : resolve(projectRoot, configPath);
  const root = resolve(projectRoot);
  if (!abs.startsWith(root + "/") && abs !== root) {
    return null;
  }
  return abs;
}

/**
 * Load and merge config from .opencode/qtk.toml (if present) with defaults.
 * Always returns a valid config — invalid TOML files log a warning and
 * fall back to defaults.
 */
export async function loadConfig(projectRoot: string): Promise<QtkConfig> {
  const path = resolve(projectRoot, ".opencode", "qtk.toml");
  const f = Bun.file(path);
  if (!(await f.exists())) return DEFAULT_CONFIG;

  try {
    const text = await f.text();
    const parsed = parseToml(text);
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch (e) {
    console.warn(`[qtk] config load failed for ${path}:`, e);
    return DEFAULT_CONFIG;
  }
}

// Minimal TOML parser — we don't pull in a dep for this. Supports:
// [section] / [section.subsection] headers
// key = "string" / key = 42 / key = true / key = ["a", "b"]
// Comments (#) and blank lines are skipped.
// Quotes: "double-quoted" only (no single, no triple).
// No inline tables, no datetime, no escapes beyond \" and \\.
// This is enough for our config format. Extend if needed.
function parseToml(src: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> = result;

  for (const rawLine of src.split("\n")) {
    const line = rawLine.replace(/(^|[^\\])#.*$/, "$1").trim();
    if (!line) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const path = line.slice(1, -1).trim().split(".");
      let target: Record<string, unknown> = result;
      for (const part of path) {
        const existing = target[part];
        if (
          existing &&
          typeof existing === "object" &&
          !Array.isArray(existing)
        ) {
          target = existing as Record<string, unknown>;
        } else {
          const next: Record<string, unknown> = {};
          target[part] = next;
          target = next;
        }
      }
      currentSection = target;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const valueText = line.slice(eq + 1).trim();
    currentSection[key] = parseValue(valueText);
  }

  return result;
}

function parseValue(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((p) => parseValue(p.trim()));
  }
  return text; // fallback: bare string
}

function mergeConfig(
  base: QtkConfig,
  override: Record<string, unknown>,
): QtkConfig {
  const qtk = (override.qtk as Record<string, unknown> | undefined) ?? {};
  const teeOverride = (qtk.tee as Record<string, unknown> | undefined) ?? {};
  const statsOverride =
    (qtk.stats as Record<string, unknown> | undefined) ?? {};
  const compOverride =
    (qtk.compressors as Record<string, Record<string, unknown>> | undefined) ??
    {};
  const toolsOverride =
    (qtk.tools as Record<string, Record<string, unknown>> | undefined) ?? {};

  return {
    enabled: (qtk.enabled as boolean | undefined) ?? base.enabled,
    logLevel:
      (qtk.log_level as QtkConfig["logLevel"] | undefined) ?? base.logLevel,
    dedupTtlSeconds:
      (qtk.dedup_ttl_seconds as number | undefined) ?? base.dedupTtlSeconds,
    tee: {
      enabled: (teeOverride.enabled as boolean | undefined) ?? base.tee.enabled,
      directory:
        (teeOverride.directory as string | undefined) ?? base.tee.directory,
      mode:
        (teeOverride.mode as QtkConfig["tee"]["mode"] | undefined) ??
        base.tee.mode,
      pruneDays:
        (teeOverride.prune_days as number | undefined) ?? base.tee.pruneDays,
    },
    stats: {
      enabled:
        (statsOverride.enabled as boolean | undefined) ?? base.stats.enabled,
      database:
        (statsOverride.database as string | undefined) ?? base.stats.database,
    },
    compressors: { ...base.compressors, ...compOverride },
    tools: { ...base.tools, ...toolsOverride },
  };
}
