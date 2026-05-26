// Runtime: turn a FilterSpec into a Compressor.
//
// Pipeline (each step is a no-op if the relevant spec field is absent):
//
//   raw text
//   ── split into lines
//   ── pass_through_if: if regex matches anywhere in raw, return raw unchanged
//   ── strip:           drop lines matching any strip regex
//   ── dedupe:          collapse repeated lines (modes: "lines" or "count")
//   ── match:           keep only lines matching `match`, extract named groups
//   ── (unmatched=keep also passes non-matching lines through verbatim)
//   ── group_by:        aggregate records by a named group field
//   ── template:        format each record (or group) into a line
//   ── header/footer:   prepend/append
//   ── truncate:        cap output lines, replace excess with truncate_message
//
// Cardinal rules (the compressor contract):
//   - NEVER throw — wrap everything in try/catch, return raw on error
//   - NEVER produce output longer than input — final length check
//   - NEVER do I/O — pure string→string

import type { Compressor } from "../types.ts";
import type { FilterSpec } from "./types.ts";

const MAX_GROUP_FIELD_LEN = 200;
const MAX_JOINED_VALUES_LEN = 100;

interface MatchRecord {
  /** Named capture groups; empty object if `match` has no named groups. */
  readonly groups: Record<string, string>;
  /** Original line (for unmatched=keep when used after match). */
  readonly line: string;
  /** True if this line actually matched the `match` regex. */
  readonly matched: boolean;
}

type AggregateValues = {
  /** Pre-computed values available to header/footer/truncate templates. */
  total: number; // input lines
  matched: number; // lines that matched the `match` regex
  dropped: number; // for truncate message
  tee: string; // tee filename (set externally; "" by default)
  [key: string]: string | number;
};

/** Compile a FilterSpec into a Compressor. */
export function compileFilter(spec: FilterSpec): Compressor {
  const commandMatchers = spec.commands.map(compileCommandPattern);

  const compressor: Compressor = {
    name: `dsl:${spec.name}`,
    category: "dsl",

    matches(tool: string, args: Record<string, unknown>): boolean {
      if (!spec.enabled) return false;
      // DSL filters only run for Bash for now (commands are shell strings).
      // Built-in tool compressors live in TS.
      if (tool.toLowerCase() !== "bash") return false;
      const cmd =
        typeof args.command === "string" ? args.command.trim() : "";
      if (!cmd) return false;
      for (const m of commandMatchers) {
        if (m(cmd)) return true;
      }
      return false;
    },

    compress(raw: string): string {
      try {
        return runPipeline(raw, spec);
      } catch {
        return raw; // Cardinal rule: never throw
      }
    },
  };
  return compressor;
}

// ─── command matching ──────────────────────────────────────────────────────

/**
 * Compile a command pattern into a predicate. Supports:
 *   - literal prefix: "git status" matches "git status", "git status --short"
 *   - wildcard:       "kubectl get *" matches any "kubectl get whatever"
 *   - any:            "*" matches any command (use sparingly)
 */
function compileCommandPattern(pattern: string): (cmd: string) => boolean {
  const trimmed = pattern.trim();
  if (trimmed === "*") return () => true;

  if (trimmed.includes("*")) {
    // Translate glob to anchored regex; escape regex meta except `*`
    const re = new RegExp(
      "^" +
        trimmed
          .split("*")
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "(\\b|$)",
    );
    return (cmd) => re.test(cmd);
  }

  // Literal prefix match — must match either exactly or be followed by
  // whitespace (so "git" doesn't match "github").
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped + "($|\\s)");
  return (cmd) => re.test(cmd);
}

// ─── pipeline ──────────────────────────────────────────────────────────────

function runPipeline(raw: string, spec: FilterSpec): string {
  if (!raw) return raw;

  // pass_through_if: if regex matches anywhere in raw, short-circuit
  if (spec.passThroughIf && spec.passThroughIf.test(raw)) {
    return raw;
  }

  // Trim trailing newline so we don't count an empty last line
  const trimmed =
    raw.endsWith("\n") && raw.length > 0 ? raw.slice(0, -1) : raw;
  let lines = trimmed.split("\n");

  // min_input_lines short-circuit
  if (lines.length < spec.minInputLines) return raw;

  const totalLinesIn = lines.length;

  // strip
  if (spec.strip.length > 0) {
    const stripRes = spec.strip;
    lines = lines.filter((l) => !stripRes.some((re) => re.test(l)));
  }

  // dedupe (operates on raw lines, before match)
  if (spec.dedupe === "lines") {
    lines = dedupeLines(lines);
  } else if (spec.dedupe === "count") {
    lines = dedupeCount(lines);
  }

  // match + unmatched handling
  let records: MatchRecord[];
  let matchedCount = 0;
  if (spec.match) {
    records = [];
    for (const line of lines) {
      const m = line.match(spec.match);
      if (m) {
        const groups = m.groups
          ? Object.fromEntries(
              Object.entries(m.groups).map(([k, v]) => [
                k,
                (v ?? "").slice(0, MAX_GROUP_FIELD_LEN),
              ]),
            )
          : {};
        records.push({ groups, line, matched: true });
        matchedCount++;
      } else if (spec.unmatched === "keep") {
        records.push({ groups: {}, line, matched: false });
      } else if (spec.unmatched === "truncate") {
        // We'll collapse non-matching tail later in `renderRecords`
        records.push({ groups: {}, line, matched: false });
      }
      // unmatched === "drop": skip
    }
  } else {
    // No `match`: every line is a record with no fields
    records = lines.map((l) => ({ groups: {}, line: l, matched: true }));
    matchedCount = records.length;
  }

  // group_by + template (rendered together)
  const aggregates: AggregateValues = {
    total: totalLinesIn,
    matched: matchedCount,
    dropped: 0,
    tee: "",
  };

  let body: string[];
  if (spec.groupBy && spec.match) {
    body = renderGrouped(records, spec);
  } else {
    body = renderRecords(records, spec);
  }

  // truncate
  if (spec.truncate != null && body.length > spec.truncate) {
    const dropped = body.length - spec.truncate;
    body = body.slice(0, spec.truncate);
    body.push(
      applyTemplate(spec.truncateMessage, {
        ...aggregates,
        dropped,
      }),
    );
  }

  // header / footer
  const out: string[] = [];
  if (spec.header) {
    out.push(applyTemplate(spec.header, aggregates));
  }
  out.push(...body);
  if (spec.footer) {
    out.push(applyTemplate(spec.footer, aggregates));
  }

  // If, after all that, nothing was produced — return raw (don't emit empty)
  if (out.length === 0) return raw;

  const result = out.join("\n");

  // RTK-style safety: if output is more than 2x input (DSL ran amok somehow),
  // return raw. Also our standard contract: output ≤ input.
  if (result.length >= raw.length) return raw;
  return result;
}

// ─── dedupe ────────────────────────────────────────────────────────────────

function dedupeLines(lines: string[]): string[] {
  // Collapse runs of identical adjacent lines into "<line> (x42)"
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run++;
    if (run > 1) out.push(`${lines[i]} (x${run})`);
    else out.push(lines[i]!);
    i += run;
  }
  return out;
}

function dedupeCount(lines: string[]): string[] {
  // Output each unique line once, with total count of all
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const l of lines) {
    if (!seen.has(l)) {
      seen.add(l);
      ordered.push(l);
    }
  }
  return ordered;
}

// ─── rendering ─────────────────────────────────────────────────────────────

function renderRecords(records: MatchRecord[], spec: FilterSpec): string[] {
  if (!spec.template) {
    // Field=value form (or just the line if no fields)
    return records.map((r) => {
      if (Object.keys(r.groups).length === 0) return r.line;
      return Object.entries(r.groups)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    });
  }
  return records.map((r) =>
    applyTemplate(spec.template!, r.matched ? r.groups : { _line: r.line }),
  );
}

function renderGrouped(records: MatchRecord[], spec: FilterSpec): string[] {
  const groupKey = spec.groupBy!;
  const groups = new Map<string, MatchRecord[]>();
  // Preserve insertion order
  for (const r of records) {
    if (!r.matched) continue; // group_by ignores unmatched
    const k = r.groups[groupKey] ?? "(none)";
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }

  const out: string[] = [];
  for (const [key, rs] of groups) {
    const ctx = buildGroupTemplateContext(key, rs, groupKey);
    out.push(
      applyTemplate(
        spec.template ?? "{" + groupKey + "}: {n}",
        ctx,
      ),
    );
  }
  return out;
}

function buildGroupTemplateContext(
  key: string,
  records: MatchRecord[],
  groupKey: string,
): Record<string, string | number> {
  const ctx: Record<string, string | number> = {
    [groupKey]: key,
    n: records.length,
  };

  // Collect all field names from the first record (template might reference
  // `first.field`, `last.field`, `joined.field`)
  const fieldNames = new Set<string>();
  for (const r of records) {
    for (const f of Object.keys(r.groups)) fieldNames.add(f);
  }

  for (const f of fieldNames) {
    const first = records[0]!.groups[f] ?? "";
    const last = records[records.length - 1]!.groups[f] ?? "";
    ctx[`first.${f}`] = first;
    ctx[`last.${f}`] = last;
    const joined = records
      .map((r) => r.groups[f] ?? "")
      .filter((v) => v.length > 0)
      .join(", ");
    ctx[`joined.${f}`] =
      joined.length > MAX_JOINED_VALUES_LEN
        ? joined.slice(0, MAX_JOINED_VALUES_LEN) + "…"
        : joined;
  }
  return ctx;
}

// ─── template ──────────────────────────────────────────────────────────────

/**
 * Mustache-lite: `{key}` and `{key.field}` are substituted from ctx.
 * Missing keys become empty string (RTK behaviour). No conditionals,
 * no inverted sections, no escaping needed.
 */
function applyTemplate(
  template: string,
  ctx: Record<string, string | number>,
): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, key) => {
    const v = ctx[key];
    if (v == null) return "";
    return String(v);
  });
}
