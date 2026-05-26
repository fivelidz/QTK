// `Read` tool compressor.
//
// opencode's Read tool produces output like:
//
//   <file>
//   00001| import { z } from "zod"
//   00002| import { ai } from "ai"
//   ...
//   01200| // EOF
//   </file>
//
// For long files (> 200 lines by default) we replace the bulk with a
// signature outline — top-level imports, exports, function/class
// definitions. The agent can then ask for a specific range with offset/limit.

import type { Compressor } from "../types.ts";

const DEFAULT_THRESHOLD = 200;

// Patterns that identify "structural" lines worth keeping in an outline.
// These are heuristic — designed to capture the shape of code, not parse it.
const OUTLINE_PATTERNS: ReadonlyArray<RegExp> = [
  // Imports / requires
  /^\s*(import|from|require|use|using|include)\b/,
  // Exports
  /^\s*export\b/,
  // Function definitions (multi-lang)
  /^\s*(async\s+)?(function|fn|def|sub|fun)\b/,
  // Class / interface / type definitions
  /^\s*(class|interface|type|struct|enum|trait|impl)\b/,
  // Method definitions (indented function-like)
  /^\s*(public|private|protected)\s+(static\s+)?(async\s+)?[\w<>]+\s*\(/,
  // Top-level const/let/var that look like exports
  /^\s*(export\s+)?(const|let|var)\s+[A-Z_]/,
  // Decorators / annotations
  /^\s*(@\w+|#\[)/,
  // Section markers (// MARK:, // ====, etc.)
  /^\s*\/\/\s*(MARK|TODO|FIXME|XXX|NOTE):/,
  /^\s*\/\/\s*={3,}/,
  /^\s*#\s*={3,}/,
];

function isStructuralLine(line: string): boolean {
  for (const re of OUTLINE_PATTERNS) {
    if (re.test(line)) return true;
  }
  return false;
}

export const readToolCompressor: Compressor = {
  name: "tool-read",
  category: "built-in-tool",

  matches(tool: string): boolean {
    return tool.toLowerCase() === "read";
  },

  compress(raw: string): string {
    if (!raw || raw.length < 4000) return raw; // small files, leave alone

    // opencode's Read tool wraps content in <file>...</file> tags with
    // line-numbered content. We work inside that.
    const fileMatch = raw.match(/<file[^>]*>([\s\S]*)<\/file>/);
    const body = fileMatch ? fileMatch[1]! : raw;
    const lines = body.split("\n");

    // Identify line-numbered format: lines starting with `00001|` or similar
    const numberedPattern = /^\s*\d+\|/;
    const numberedCount = lines.filter((l) => numberedPattern.test(l)).length;
    if (numberedCount < lines.length * 0.5) {
      // Not the expected format — pass through
      return raw;
    }

    if (lines.length < DEFAULT_THRESHOLD) return raw;

    // Build outline: every structural line, plus context line numbers
    const outline: string[] = [];
    for (const line of lines) {
      // Strip the line-number prefix to test against patterns
      const stripped = line.replace(/^\s*\d+\|\s?/, "");
      if (isStructuralLine(stripped)) {
        outline.push(line);
      }
    }

    if (outline.length === 0 || outline.length > lines.length * 0.5) {
      // Couldn't outline confidently — fall back to head + tail
      const head = lines.slice(0, 40).join("\n");
      const tail = lines.slice(-20).join("\n");
      const result = `${head}\n... <${lines.length - 60} lines omitted; call Read with offset to see more> ...\n${tail}`;
      return result.length < raw.length
        ? wrapInOutline(result, lines.length)
        : raw;
    }

    // Cap outline size at 100 lines
    const MAX_OUTLINE = 100;
    const truncated = outline.length > MAX_OUTLINE;
    const shown = truncated ? outline.slice(0, MAX_OUTLINE) : outline;

    const out: string[] = [];
    out.push(
      `<file-outline lines=${lines.length} structural=${outline.length}>`,
    );
    out.push(...shown);
    if (truncated) {
      out.push(`... +${outline.length - MAX_OUTLINE} more structural lines`);
    }
    out.push("</file-outline>");
    out.push(
      `(${lines.length}-line file; call Read with offset=N&limit=M for any range)`,
    );

    const result = out.join("\n");
    if (result.length >= raw.length) return raw;
    return result;
  },
};

function wrapInOutline(content: string, totalLines: number): string {
  return `<file-outline lines=${totalLines} mode=head-tail>\n${content}\n</file-outline>`;
}
