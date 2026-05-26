// TOML parser for QTK filter files.
//
// Subset supported (covers everything in docs/FILTER-DSL.md):
//   - `key = "string"` (double-quoted, with \\, \" and \n escapes)
//   - `key = """multiline string"""` (basic multiline, escapes still active)
//   - `key = 42` / `key = 3.14`
//   - `key = true` / `key = false`
//   - `key = ["a", "b"]` (homogeneous string array; numeric array also OK)
//   - Comments with `#` (must not be inside a quoted string)
//   - Section headers `[section]` (we only really use top-level; sections
//     are accepted but flattened into the top-level result)
//   - Blank lines and trailing whitespace
//
// NOT supported (intentionally; throws FilterParseError):
//   - Inline tables `{ key = ... }`
//   - Datetimes
//   - Arrays of tables `[[name]]`
//   - Literal strings (single-quoted)
//
// The parser is hand-written and never pulls a dependency. It targets the
// shape of filter files specifically, not full TOML. If a filter file fails
// to parse here, we log a warning and skip that filter — never crash.

import { FilterParseError } from "./types.ts";

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

interface Cursor {
  src: string;
  pos: number;
  line: number;
  source: string; // file name for error messages
}

export function parseFilterToml(text: string, source: string): TomlTable {
  const cur: Cursor = { src: text, pos: 0, line: 1, source };
  const result: TomlTable = {};
  let currentTable: TomlTable = result;

  while (cur.pos < cur.src.length) {
    skipBlankAndComments(cur);
    if (cur.pos >= cur.src.length) break;

    const c = cur.src[cur.pos];

    // Section header
    if (c === "[") {
      if (cur.src[cur.pos + 1] === "[") {
        throw new FilterParseError(
          "Array-of-tables [[name]] not supported",
          cur.source,
          cur.line,
        );
      }
      currentTable = parseSectionHeader(cur, result);
      consumeRestOfLine(cur);
      continue;
    }

    // Key-value pair
    const key = parseKey(cur);
    skipInlineSpaces(cur);
    expectChar(cur, "=");
    skipInlineSpaces(cur);
    const value = parseValue(cur);
    currentTable[key] = value;
    consumeRestOfLine(cur);
  }

  return result;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function skipBlankAndComments(cur: Cursor): void {
  while (cur.pos < cur.src.length) {
    const c = cur.src[cur.pos];
    if (c === " " || c === "\t") {
      cur.pos++;
    } else if (c === "\n") {
      cur.pos++;
      cur.line++;
    } else if (c === "\r") {
      cur.pos++;
    } else if (c === "#") {
      // Comment until end of line
      while (cur.pos < cur.src.length && cur.src[cur.pos] !== "\n") cur.pos++;
    } else {
      return;
    }
  }
}

function skipInlineSpaces(cur: Cursor): void {
  while (cur.pos < cur.src.length) {
    const c = cur.src[cur.pos];
    if (c === " " || c === "\t") cur.pos++;
    else return;
  }
}

function consumeRestOfLine(cur: Cursor): void {
  // After a key=value pair, allow optional inline comment + newline
  skipInlineSpaces(cur);
  if (cur.pos < cur.src.length && cur.src[cur.pos] === "#") {
    while (cur.pos < cur.src.length && cur.src[cur.pos] !== "\n") cur.pos++;
  }
  if (cur.pos < cur.src.length && cur.src[cur.pos] === "\r") cur.pos++;
  if (cur.pos < cur.src.length && cur.src[cur.pos] === "\n") {
    cur.pos++;
    cur.line++;
  }
}

function expectChar(cur: Cursor, ch: string): void {
  if (cur.src[cur.pos] !== ch) {
    throw new FilterParseError(
      `expected '${ch}', got '${cur.src[cur.pos] ?? "EOF"}'`,
      cur.source,
      cur.line,
    );
  }
  cur.pos++;
}

function parseKey(cur: Cursor): string {
  const start = cur.pos;
  while (cur.pos < cur.src.length) {
    const c = cur.src[cur.pos]!;
    if (/[A-Za-z0-9_\-.]/.test(c)) cur.pos++;
    else break;
  }
  if (cur.pos === start) {
    throw new FilterParseError("expected key", cur.source, cur.line);
  }
  return cur.src.slice(start, cur.pos);
}

function parseSectionHeader(cur: Cursor, root: TomlTable): TomlTable {
  expectChar(cur, "[");
  skipInlineSpaces(cur);
  const path: string[] = [];
  while (cur.pos < cur.src.length && cur.src[cur.pos] !== "]") {
    skipInlineSpaces(cur);
    const part = parseKey(cur);
    path.push(part);
    skipInlineSpaces(cur);
    if (cur.src[cur.pos] === ".") {
      cur.pos++;
      continue;
    }
    break;
  }
  skipInlineSpaces(cur);
  expectChar(cur, "]");

  let target = root;
  for (const part of path) {
    const existing = target[part];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      target = existing as TomlTable;
    } else {
      const next: TomlTable = {};
      target[part] = next;
      target = next;
    }
  }
  return target;
}

function parseValue(cur: Cursor): TomlValue {
  const c = cur.src[cur.pos];
  if (c === '"') return parseString(cur);
  if (c === "[") return parseArray(cur);
  if (c === "t" || c === "f") return parseBool(cur);
  if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
    return parseNumber(cur);
  }
  throw new FilterParseError(
    `unexpected value char '${c ?? "EOF"}'`,
    cur.source,
    cur.line,
  );
}

function parseString(cur: Cursor): string {
  // Detect triple-quoted multiline
  if (
    cur.src[cur.pos] === '"' &&
    cur.src[cur.pos + 1] === '"' &&
    cur.src[cur.pos + 2] === '"'
  ) {
    return parseMultilineString(cur);
  }
  // Single-line double-quoted string
  expectChar(cur, '"');
  let out = "";
  while (cur.pos < cur.src.length) {
    const c = cur.src[cur.pos]!;
    if (c === '"') {
      cur.pos++;
      return out;
    }
    if (c === "\n") {
      throw new FilterParseError(
        "unterminated string",
        cur.source,
        cur.line,
      );
    }
    if (c === "\\") {
      const nxt = cur.src[cur.pos + 1];
      // We DO NOT decode \\s, \\d, etc. — those are regex meta-sequences,
      // we want the raw 2-char string ("\\s") to reach the user. We DO
      // decode \" (so users can put quotes in strings), \\ (so they can
      // put a literal backslash), \n (newline), and \t (tab).
      if (nxt === '"') {
        out += '"';
        cur.pos += 2;
        continue;
      }
      if (nxt === "\\") {
        // Two literal backslashes in source become one backslash in the
        // resulting string. This means a user writing "\\s" gets "\s",
        // and "\\\\s" gets "\\s". RTK-compatible behavior.
        out += "\\";
        cur.pos += 2;
        continue;
      }
      if (nxt === "n") {
        out += "\n";
        cur.pos += 2;
        continue;
      }
      if (nxt === "t") {
        out += "\t";
        cur.pos += 2;
        continue;
      }
      // Unknown escape — keep both chars (regex-friendly).
      out += c;
      cur.pos++;
      continue;
    }
    out += c;
    cur.pos++;
  }
  throw new FilterParseError("unterminated string", cur.source, cur.line);
}

function parseMultilineString(cur: Cursor): string {
  cur.pos += 3; // consume opening """
  // TOML spec says a newline immediately after """ is trimmed
  if (cur.src[cur.pos] === "\n") {
    cur.pos++;
    cur.line++;
  } else if (
    cur.src[cur.pos] === "\r" &&
    cur.src[cur.pos + 1] === "\n"
  ) {
    cur.pos += 2;
    cur.line++;
  }
  let out = "";
  while (cur.pos < cur.src.length) {
    if (
      cur.src[cur.pos] === '"' &&
      cur.src[cur.pos + 1] === '"' &&
      cur.src[cur.pos + 2] === '"'
    ) {
      cur.pos += 3;
      return out;
    }
    const c = cur.src[cur.pos]!;
    if (c === "\\") {
      const nxt = cur.src[cur.pos + 1];
      if (nxt === '"' || nxt === "\\") {
        out += nxt === "\\" ? "\\" : '"';
        cur.pos += 2;
        continue;
      }
      if (nxt === "n") {
        out += "\n";
        cur.pos += 2;
        continue;
      }
      // Unknown escape: keep both
      out += c;
      cur.pos++;
      continue;
    }
    if (c === "\n") cur.line++;
    out += c;
    cur.pos++;
  }
  throw new FilterParseError(
    "unterminated multiline string",
    cur.source,
    cur.line,
  );
}

function parseArray(cur: Cursor): TomlValue[] {
  expectChar(cur, "[");
  const out: TomlValue[] = [];
  while (cur.pos < cur.src.length) {
    skipBlankAndComments(cur);
    if (cur.src[cur.pos] === "]") {
      cur.pos++;
      return out;
    }
    out.push(parseValue(cur));
    skipBlankAndComments(cur);
    if (cur.src[cur.pos] === ",") {
      cur.pos++;
      continue;
    }
    if (cur.src[cur.pos] === "]") {
      cur.pos++;
      return out;
    }
    throw new FilterParseError(
      `expected ',' or ']' in array, got '${cur.src[cur.pos] ?? "EOF"}'`,
      cur.source,
      cur.line,
    );
  }
  throw new FilterParseError("unterminated array", cur.source, cur.line);
}

function parseBool(cur: Cursor): boolean {
  if (cur.src.startsWith("true", cur.pos)) {
    cur.pos += 4;
    return true;
  }
  if (cur.src.startsWith("false", cur.pos)) {
    cur.pos += 5;
    return false;
  }
  throw new FilterParseError("expected true/false", cur.source, cur.line);
}

function parseNumber(cur: Cursor): number {
  const start = cur.pos;
  if (cur.src[cur.pos] === "-") cur.pos++;
  while (
    cur.pos < cur.src.length &&
    /[0-9._]/.test(cur.src[cur.pos] as string)
  ) {
    cur.pos++;
  }
  const text = cur.src.slice(start, cur.pos).replace(/_/g, "");
  if (text.includes(".")) {
    const n = Number.parseFloat(text);
    if (Number.isNaN(n))
      throw new FilterParseError(
        `bad number ${text}`,
        cur.source,
        cur.line,
      );
    return n;
  }
  const n = Number.parseInt(text, 10);
  if (Number.isNaN(n))
    throw new FilterParseError(`bad number ${text}`, cur.source, cur.line);
  return n;
}
