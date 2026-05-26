// `git status` (full porcelain form) compressor.
//
// Raw output (example, ~1.6 KB):
//   On branch main
//   Your branch is up to date with 'origin/main'.
//
//   Changes to be committed:
//     (use "git restore --staged <file>..." to unstage)
//   	modified:   foo.ts
//   	new file:   bar.ts
//
//   Changes not staged for commit:
//     (use "git add <file>..." to update what will be committed)
//   	modified:   baz.ts
//   	deleted:    qux.ts
//
//   Untracked files:
//     (use "git add <file>..." to include in what will be committed)
//   	new-file.ts
//   	another-untracked/
//
//   no changes added to commit (use "git add" and/or "git commit -a")
//
// Compressed form (~200 bytes):
//   branch=main (up to date with origin/main)
//   staged:   modified foo.ts, new bar.ts
//   unstaged: modified baz.ts, deleted qux.ts
//   untracked: new-file.ts, another-untracked/

import type { Compressor, CompressorContext } from "../types.ts";

const SECTION_RE = /^(.+?)\s+commit:?\s*$/;

export const gitStatusCompressor: Compressor = {
  name: "git-status",
  category: "git",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    // Match `git status` (not `git status --porcelain` or `--short` which
    // are already compact)
    return (
      /^git\s+status$/.test(cmd) || /^git\s+status\s+(--long)?\s*$/.test(cmd)
    );
  },

  compress(raw: string): string {
    if (!raw || raw.length < 80) return raw;

    const lines = raw.split("\n");
    let branch: string | null = null;
    let upstream: string | null = null;
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    type Section = "none" | "staged" | "unstaged" | "untracked";
    let section: Section = "none";

    for (const line of lines) {
      // Branch
      const branchMatch = line.match(/^On branch (.+)$/);
      if (branchMatch) {
        branch = branchMatch[1]!;
        continue;
      }
      const upstreamMatch = line.match(/^Your branch (.+)$/);
      if (upstreamMatch) {
        upstream = upstreamMatch[1]!;
        continue;
      }

      // Section detection
      if (/^Changes to be committed:/.test(line)) {
        section = "staged";
        continue;
      }
      if (/^Changes not staged for commit:/.test(line)) {
        section = "unstaged";
        continue;
      }
      if (/^Untracked files:/.test(line)) {
        section = "untracked";
        continue;
      }
      if (SECTION_RE.test(line)) {
        section = "none";
        continue;
      }
      if (line.startsWith("  (") || line === "") {
        // Hint line in parens, or blank line — keep in same section
        continue;
      }
      if (/^no changes added/.test(line) || /^nothing to commit/.test(line)) {
        continue;
      }

      // File entries
      if (section === "staged" || section === "unstaged") {
        // Format: `\tmodified:   foo.ts` or `\tnew file:   bar.ts`
        const m = line.match(
          /^\t(modified|new file|deleted|renamed|copied|typechange):\s+(.+)$/,
        );
        if (m) {
          const flag = m[1]!
            .replace("new file", "new")
            .replace("typechange", "type");
          const entry = `${flag} ${m[2]!}`;
          if (section === "staged") staged.push(entry);
          else unstaged.push(entry);
        }
        continue;
      }
      if (section === "untracked") {
        const m = line.match(/^\t(.+)$/);
        if (m) untracked.push(m[1]!);
        continue;
      }
    }

    // If nothing parsed, return raw — better than wrong compact form
    if (
      !branch &&
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0
    ) {
      return raw;
    }

    const MAX_FILES_PER_SECTION = 15;
    const formatSection = (items: string[]): string => {
      if (items.length <= MAX_FILES_PER_SECTION) return items.join(", ");
      const head = items.slice(0, MAX_FILES_PER_SECTION).join(", ");
      return `${head}, ... +${items.length - MAX_FILES_PER_SECTION} more`;
    };

    const parts: string[] = [];
    if (branch) {
      parts.push(
        upstream ? `branch=${branch} (${upstream})` : `branch=${branch}`,
      );
    }
    if (staged.length > 0)
      parts.push(`staged (${staged.length}):   ${formatSection(staged)}`);
    if (unstaged.length > 0)
      parts.push(`unstaged (${unstaged.length}): ${formatSection(unstaged)}`);
    if (untracked.length > 0)
      parts.push(
        `untracked (${untracked.length}): ${formatSection(untracked)}`,
      );

    // Detect "clean" state
    if (
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0
    ) {
      parts.push("clean working tree");
    }

    const result = parts.join("\n");
    // Safety: never produce output larger than input
    if (result.length >= raw.length) return raw;
    return result;
  },
};

// Compressor for `git log` — converts multi-line commits to one-line summary.
export const gitLogCompressor: Compressor = {
  name: "git-log",
  category: "git",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    // Match `git log` but not `--oneline` (already compact) or `--stat`
    if (!/^git\s+log\b/.test(cmd)) return false;
    if (/--oneline\b/.test(cmd)) return false;
    return true;
  },

  compress(raw: string): string {
    if (!raw || raw.length < 100) return raw;

    const lines = raw.split("\n");
    const commits: {
      hash: string;
      author: string;
      date: string;
      subject: string;
    }[] = [];
    let cur: {
      hash?: string;
      author?: string;
      date?: string;
      subject?: string;
    } = {};

    for (const line of lines) {
      const hashMatch = line.match(/^commit ([a-f0-9]{7,40})/);
      if (hashMatch) {
        if (cur.hash && cur.subject) {
          commits.push({
            hash: cur.hash,
            author: cur.author ?? "?",
            date: cur.date ?? "?",
            subject: cur.subject,
          });
        }
        cur = { hash: hashMatch[1]!.slice(0, 7) };
        continue;
      }
      const authorMatch = line.match(/^Author:\s+(.+?)\s+</);
      if (authorMatch) {
        cur.author = authorMatch[1];
        continue;
      }
      const dateMatch = line.match(/^Date:\s+(.+)$/);
      if (dateMatch) {
        // Compact the date: "Mon May 20 14:23:01 2026 +1000" → "2026-05-20"
        const d = dateMatch[1]!;
        const ymd = d.match(/(\d{4})/);
        const mon = d.match(/^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d+)/);
        if (ymd && mon) {
          const months: Record<string, string> = {
            Jan: "01",
            Feb: "02",
            Mar: "03",
            Apr: "04",
            May: "05",
            Jun: "06",
            Jul: "07",
            Aug: "08",
            Sep: "09",
            Oct: "10",
            Nov: "11",
            Dec: "12",
          };
          cur.date = `${ymd[1]}-${months[mon[1]!] ?? "??"}-${mon[2]!.padStart(2, "0")}`;
        } else {
          cur.date = d;
        }
        continue;
      }
      // Subject is the first non-blank line after Date
      if (line.startsWith("    ") && cur.hash && !cur.subject) {
        cur.subject = line.trim();
        continue;
      }
    }
    if (cur.hash && cur.subject) {
      commits.push({
        hash: cur.hash,
        author: cur.author ?? "?",
        date: cur.date ?? "?",
        subject: cur.subject,
      });
    }

    if (commits.length === 0) return raw;

    const out = commits
      .map((c) => `${c.hash} ${c.date} ${c.author}: ${c.subject}`)
      .join("\n");
    if (out.length >= raw.length) return raw;
    return out;
  },
};

// Re-export both as a small array for the registry to pick up alongside
// git-status.
export const gitCompressors = [gitStatusCompressor, gitLogCompressor] as const;

// Suppress unused import warning while exporting a helper to keep this API stable.
export type _GitContextUnused = CompressorContext;
