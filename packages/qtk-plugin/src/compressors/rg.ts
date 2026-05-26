// `rg <pattern>` / `grep -r` compressor.
//
// Raw rg output looks like:
//   src/foo.ts
//   17:export const useEffect = ...
//   42:  useEffect(() => { ... })
//
//   src/bar.ts
//   8:useEffect imported here
//
// Or with `--no-heading`:
//   src/foo.ts:17:export const useEffect = ...
//   src/foo.ts:42:  useEffect(() => { ... })
//   src/bar.ts:8:useEffect imported here
//
// Compressed: group by file, show top 3 matches per file by default,
// then `... N more matches`.

import type { Compressor } from "../types.ts";

const MAX_FILES_SHOWN = 15;
const MAX_MATCHES_PER_FILE = 3;

export const rgCompressor: Compressor = {
  name: "rg",
  category: "search",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/^rg(\s|$)/.test(cmd)) return true;
    // Also match `grep -r` / `grep -R`
    if (/^grep\s+(-[rRn]+\s|-{2}recursive\s)/.test(cmd)) return true;
    return false;
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");
    // Detect format. Heuristic: if most lines start with `<path>:<num>:` it's
    // no-heading format; otherwise it's heading format.
    const noHeadingPattern = /^[^:\s][^:]*:\d+:/;
    const noHeadingCount = lines.filter((l) => noHeadingPattern.test(l)).length;
    const isNoHeading = noHeadingCount > lines.length * 0.5;

    type Match = { line: number; text: string };
    const byFile = new Map<string, Match[]>();

    if (isNoHeading) {
      for (const line of lines) {
        const m = line.match(/^([^:]+):(\d+):(.*)$/);
        if (!m) continue;
        const path = m[1]!;
        const ln = Number.parseInt(m[2]!, 10);
        const arr = byFile.get(path) ?? [];
        arr.push({ line: ln, text: m[3]! });
        byFile.set(path, arr);
      }
    } else {
      // Heading format
      let currentFile: string | null = null;
      for (const line of lines) {
        if (line === "") {
          currentFile = null;
          continue;
        }
        // A path line: doesn't start with digits-colon
        if (!/^\d+[-:]/.test(line) && !line.startsWith(" ")) {
          currentFile = line.trim();
          if (currentFile) byFile.set(currentFile, []);
          continue;
        }
        // Match line: `LINE:text` or `LINE-text` (-context)
        const m = line.match(/^(\d+)[-:](.*)$/);
        if (m && currentFile) {
          const arr = byFile.get(currentFile) ?? [];
          arr.push({ line: Number.parseInt(m[1]!, 10), text: m[2]! });
          byFile.set(currentFile, arr);
        }
      }
    }

    if (byFile.size === 0) return raw;

    const totalMatches = [...byFile.values()].reduce((a, b) => a + b.length, 0);
    const files = [...byFile.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    const out: string[] = [];
    out.push(`${totalMatches} matches across ${byFile.size} files:`);

    for (const [path, matches] of files.slice(0, MAX_FILES_SHOWN)) {
      const header =
        matches.length > 1 ? `${path} (${matches.length} matches)` : path;
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
