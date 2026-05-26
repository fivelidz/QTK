// `ls` / `ls -la` compressor.
//
// Raw `ls -la` includes permission strings, owner, group, size, date — most
// of which are noise to the LLM. We collapse to entry names with type hints.
//
// Strategy:
//   - For `ls -la`: parse entries, output `name (size, mtime)` or
//     directory indicator `name/`
//   - For plain `ls`: pass through if < 30 entries; otherwise group by
//     extension
//
// If we can't parse confidently, return raw.

import type { Compressor } from "../types.ts";

export const lsCompressor: Compressor = {
  name: "ls",
  category: "filesystem",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    // Match `ls`, `ls -X`, `ls /path` but not `ls | grep` or `ls && something`
    return /^ls(\s|$)/.test(cmd) && !/[|&;><]/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 80) return raw;

    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return raw;

    // Detect long format: line starts with permission string like `drwxr-xr-x`
    const isLongFormat =
      /^[-dlbcps][-rwxstST]{9}/.test(lines[0]!) ||
      /^total\s+\d+/.test(lines[0]!);

    if (isLongFormat) {
      return compressLongFormat(raw, lines);
    }
    return compressShortFormat(raw, lines);
  },
};

function compressLongFormat(raw: string, lines: string[]): string {
  type Entry = {
    kind: "d" | "l" | "f";
    name: string;
    size: string;
    mtime: string;
  };
  const entries: Entry[] = [];
  let totalLine: string | null = null;

  for (const line of lines) {
    if (/^total\s+/.test(line)) {
      totalLine = line;
      continue;
    }
    // Format: drwxr-xr-x  N user group  SIZE  MMM DD HH:MM name
    //         OR        drwxr-xr-x  N user group  SIZE  MMM DD  YYYY name
    const m = line.match(
      /^([-dlbcps])[-rwxstST]{9}[+@.]?\s+\d+\s+\S+\s+\S+\s+(\d+(?:[.,]\d+)?[KMG]?)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/,
    );
    if (m) {
      const t = m[1]!;
      const kind: "d" | "l" | "f" = t === "d" ? "d" : t === "l" ? "l" : "f";
      entries.push({ kind, size: m[2]!, mtime: m[3]!, name: m[4]! });
    }
  }

  if (entries.length === 0) return raw;

  // Skip . and ..
  const real = entries.filter((e) => e.name !== "." && e.name !== "..");
  if (real.length === 0) return raw;

  // Sort: dirs first, then alphabetically
  real.sort((a, b) => {
    if (a.kind === "d" && b.kind !== "d") return -1;
    if (a.kind !== "d" && b.kind === "d") return 1;
    return a.name.localeCompare(b.name);
  });

  const out: string[] = [];
  if (totalLine) {
    out.push(`(${real.length} entries)`);
  }
  for (const e of real) {
    const suffix = e.kind === "d" ? "/" : e.kind === "l" ? "@" : "";
    out.push(`${e.name}${suffix}  ${e.size}  ${e.mtime}`);
  }

  // Truncate if very long
  const MAX = 40;
  if (out.length > MAX + 1) {
    const head = out.slice(0, MAX);
    const dropped = out.length - MAX;
    head.push(`... ${dropped} more entries`);
    return head.join("\n");
  }

  const result = out.join("\n");
  if (result.length >= raw.length) return raw;
  return result;
}

function compressShortFormat(raw: string, lines: string[]): string {
  // Plain `ls` output — already pretty compact. Just collapse multi-column
  // and group by extension if > 30 entries.
  const tokens: string[] = [];
  for (const line of lines) {
    for (const tok of line.split(/\s+/)) {
      if (tok) tokens.push(tok);
    }
  }
  if (tokens.length < 30) return raw; // already short

  const byExt = new Map<string, string[]>();
  for (const t of tokens) {
    const dot = t.lastIndexOf(".");
    const ext = dot > 0 ? t.slice(dot) : "(no-ext)";
    const arr = byExt.get(ext) ?? [];
    arr.push(t);
    byExt.set(ext, arr);
  }
  const groups = [...byExt.entries()].sort((a, b) => b[1].length - a[1].length);
  const out: string[] = [`${tokens.length} entries:`];
  for (const [ext, names] of groups.slice(0, 10)) {
    const show = names.slice(0, 5).join(", ");
    const more = names.length > 5 ? `, ... +${names.length - 5}` : "";
    out.push(`  ${ext} (${names.length}): ${show}${more}`);
  }
  if (groups.length > 10) {
    out.push(`  ... and ${groups.length - 10} more extensions`);
  }

  const result = out.join("\n");
  if (result.length >= raw.length) return raw;
  return result;
}
