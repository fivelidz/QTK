// `Grep` tool compressor — opencode's built-in grep wraps ripgrep and
// formats output as:
//
//   src/foo.ts:
//     Line 17: useEffect(() => { ... })
//     Line 42: useEffect(() => { ... })
//
//   src/bar.ts:
//     Line 8: useEffect imported here
//
// Strategy: same as rg compressor — group by file, cap top 3 matches per
// file, total cap on files shown.

import type { Compressor } from "../types.ts";

const MAX_FILES_SHOWN = 15;
const MAX_MATCHES_PER_FILE = 3;

export const grepToolCompressor: Compressor = {
  name: "tool-grep",
  category: "built-in-tool",

  matches(tool: string): boolean {
    return tool.toLowerCase() === "grep";
  },

  compress(raw: string): string {
    if (!raw || raw.length < 500) return raw;

    const lines = raw.split("\n");
    type Match = { line: number; text: string };
    const byFile = new Map<string, Match[]>();

    let currentFile: string | null = null;
    for (const line of lines) {
      if (line.endsWith(":") && !line.includes(" ")) {
        currentFile = line.slice(0, -1).trim();
        if (currentFile) byFile.set(currentFile, []);
        continue;
      }
      const m = line.match(/^\s+Line\s+(\d+):\s*(.*)$/);
      if (m && currentFile) {
        const arr = byFile.get(currentFile) ?? [];
        arr.push({ line: Number.parseInt(m[1]!, 10), text: m[2]! });
        byFile.set(currentFile, arr);
      }
    }

    if (byFile.size === 0) return raw;

    const totalMatches = [...byFile.values()].reduce((a, b) => a + b.length, 0);
    if (totalMatches < 10) return raw; // already small

    const files = [...byFile.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    const out: string[] = [
      `${totalMatches} matches across ${byFile.size} files:`,
    ];
    for (const [path, matches] of files.slice(0, MAX_FILES_SHOWN)) {
      const header = matches.length > 1 ? `${path} (${matches.length})` : path;
      out.push(header);
      for (const m of matches.slice(0, MAX_MATCHES_PER_FILE)) {
        const text = m.text.length > 100 ? m.text.slice(0, 100) + "…" : m.text;
        out.push(`  L${m.line}: ${text.trimStart()}`);
      }
      if (matches.length > MAX_MATCHES_PER_FILE) {
        out.push(`  ... +${matches.length - MAX_MATCHES_PER_FILE} more`);
      }
    }
    if (files.length > MAX_FILES_SHOWN) {
      const remaining = files.length - MAX_FILES_SHOWN;
      const remainMatches = files
        .slice(MAX_FILES_SHOWN)
        .reduce((a, b) => a + b[1].length, 0);
      out.push(`... and ${remaining} more files (${remainMatches} matches)`);
    }

    const result = out.join("\n");
    if (result.length >= raw.length) return raw;
    return result;
  },
};
