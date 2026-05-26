// Validate a parsed TOML table into a typed FilterSpec.
//
// All regex compilation happens here, in a guarded form. If a regex doesn't
// compile, we throw FilterParseError — the caller catches and skips that
// filter, but other filters keep working.

import { basename } from "node:path";
import {
  FilterParseError,
  type FilterSpec,
  type UnmatchedBehavior,
  type DedupeMode,
} from "./types.ts";
import type { TomlTable, TomlValue } from "./parser.ts";

const DEFAULT_TRUNCATE_MESSAGE = "... and {dropped} more";
const DEFAULT_MIN_INPUT_LINES = 5;

export function validateFilterSpec(
  raw: TomlTable,
  sourcePath: string,
): FilterSpec {
  const name = filterNameFromPath(sourcePath);

  // command (required)
  const commands = readCommands(raw, sourcePath);

  // enabled (default true)
  const enabled = readBool(raw.enabled, true, "enabled", sourcePath);
  if (!enabled) {
    return {
      source: sourcePath,
      name,
      commands,
      enabled: false,
      // remaining fields don't matter when disabled, but provide defaults
      minInputLines: DEFAULT_MIN_INPUT_LINES,
      passThroughIf: null,
      strip: [],
      dedupe: "none",
      match: null,
      unmatched: "drop",
      groupBy: null,
      template: null,
      header: null,
      footer: null,
      truncate: null,
      truncateMessage: DEFAULT_TRUNCATE_MESSAGE,
    };
  }

  // pass_through_if
  const passThroughIf = readOptionalRegex(
    raw.pass_through_if,
    "pass_through_if",
    sourcePath,
  );

  // strip — array of regexes
  const strip = readStripArray(raw.strip, sourcePath);

  // dedupe
  const dedupe = readDedupe(raw.dedupe, sourcePath);

  // match
  const match = readOptionalRegex(raw.match, "match", sourcePath);

  // unmatched
  const unmatched = readUnmatched(raw.unmatched, sourcePath);

  // group_by
  const groupBy = readOptionalString(raw.group_by, "group_by", sourcePath);

  // template
  const template = readOptionalString(raw.template, "template", sourcePath);

  // header / footer
  const header = readOptionalString(raw.header, "header", sourcePath);
  const footer = readOptionalString(raw.footer, "footer", sourcePath);

  // truncate / truncate_message
  const truncate = readOptionalPositiveInt(
    raw.truncate,
    "truncate",
    sourcePath,
  );
  const truncateMessage = readOptionalString(
    raw.truncate_message,
    "truncate_message",
    sourcePath,
  );

  // min_input_lines
  const minInputLines =
    readOptionalPositiveInt(
      raw.min_input_lines,
      "min_input_lines",
      sourcePath,
    ) ?? DEFAULT_MIN_INPUT_LINES;

  // Cross-field validation
  if (groupBy && !match) {
    throw new FilterParseError(
      "group_by requires match",
      sourcePath,
    );
  }
  if (groupBy && match && !regexHasNamedGroup(match, groupBy)) {
    throw new FilterParseError(
      `group_by="${groupBy}" but match has no named group "(?<${groupBy}>...)"`,
      sourcePath,
    );
  }

  return {
    source: sourcePath,
    name,
    commands,
    enabled: true,
    minInputLines,
    passThroughIf,
    strip,
    dedupe,
    match,
    unmatched,
    groupBy,
    template,
    header,
    footer,
    truncate,
    truncateMessage: truncateMessage ?? DEFAULT_TRUNCATE_MESSAGE,
  };
}

// ─── field readers ──────────────────────────────────────────────────────────

function readCommands(raw: TomlTable, source: string): readonly string[] {
  const v = raw.command;
  if (typeof v === "string") {
    if (!v.trim()) {
      throw new FilterParseError("command must not be empty", source);
    }
    return [v];
  }
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (typeof item !== "string" || !item.trim()) {
        throw new FilterParseError(
          "command array must contain non-empty strings",
          source,
        );
      }
      out.push(item);
    }
    if (out.length === 0) {
      throw new FilterParseError("command array must not be empty", source);
    }
    return out;
  }
  throw new FilterParseError(
    "command is required (string or array of strings)",
    source,
  );
}

function readBool(
  v: TomlValue | undefined,
  defaultVal: boolean,
  field: string,
  source: string,
): boolean {
  if (v === undefined) return defaultVal;
  if (typeof v === "boolean") return v;
  throw new FilterParseError(`${field} must be a boolean`, source);
}

function readOptionalString(
  v: TomlValue | undefined,
  field: string,
  source: string,
): string | null {
  if (v === undefined) return null;
  if (typeof v === "string") return v;
  throw new FilterParseError(`${field} must be a string`, source);
}

function readOptionalPositiveInt(
  v: TomlValue | undefined,
  field: string,
  source: string,
): number | null {
  if (v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new FilterParseError(
      `${field} must be a positive integer`,
      source,
    );
  }
  return v;
}

function readOptionalRegex(
  v: TomlValue | undefined,
  field: string,
  source: string,
): RegExp | null {
  if (v === undefined) return null;
  if (typeof v !== "string") {
    throw new FilterParseError(`${field} must be a regex string`, source);
  }
  return compileRegex(v, field, source);
}

function readStripArray(
  v: TomlValue | undefined,
  source: string,
): readonly RegExp[] {
  if (v === undefined) return [];
  if (typeof v === "string") {
    // Allow `strip = "pattern"` as a convenience for a single pattern
    return [compileRegex(v, "strip", source)];
  }
  if (!Array.isArray(v)) {
    throw new FilterParseError("strip must be a string or array", source);
  }
  return v.map((p, i) => {
    if (typeof p !== "string") {
      throw new FilterParseError(
        `strip[${i}] must be a string`,
        source,
      );
    }
    return compileRegex(p, `strip[${i}]`, source);
  });
}

function readDedupe(v: TomlValue | undefined, source: string): DedupeMode {
  if (v === undefined) return "none";
  if (v === "lines" || v === "count" || v === "none") return v;
  throw new FilterParseError(
    `dedupe must be "lines", "count", or "none"`,
    source,
  );
}

function readUnmatched(
  v: TomlValue | undefined,
  source: string,
): UnmatchedBehavior {
  if (v === undefined) return "drop";
  if (v === "drop" || v === "keep" || v === "truncate") return v;
  throw new FilterParseError(
    `unmatched must be "drop", "keep", or "truncate"`,
    source,
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function compileRegex(pattern: string, field: string, source: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new FilterParseError(
      `${field}: invalid regex "${pattern}": ${(e as Error).message}`,
      source,
    );
  }
}

function regexHasNamedGroup(re: RegExp, name: string): boolean {
  // Look at the source string for `(?<name>` — quick and accurate enough.
  // RegExp doesn't expose its named-group set on older runtimes.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\(\\?<${escaped}>`).test(re.source);
}

function filterNameFromPath(p: string): string {
  const base = basename(p);
  return base.endsWith(".toml") ? base.slice(0, -5) : base;
}
