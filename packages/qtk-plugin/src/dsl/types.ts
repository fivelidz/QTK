// DSL filter type definitions. A FilterSpec is the parsed, validated form
// of a TOML filter file — what `parser.ts` produces and `runtime.ts` consumes.
//
// See docs/FILTER-DSL.md for the full reference.

export type UnmatchedBehavior = "drop" | "keep" | "truncate";
export type DedupeMode = "lines" | "count" | "none";

export interface FilterSpec {
  /** Filename the filter came from (for error messages and stats). */
  readonly source: string;

  /** Stable name used in stats / `qtk gain`. Derived from `source`. */
  readonly name: string;

  /** One or more command patterns (literal prefix or with `*` wildcard). */
  readonly commands: readonly string[];

  /** Filter is disabled if false (default true). */
  readonly enabled: boolean;

  /** Smallest input that should be compressed; smaller passes through. */
  readonly minInputLines: number;

  /** If raw output matches this regex, pass through unchanged. */
  readonly passThroughIf: RegExp | null;

  /** Lines matching any of these regexes are dropped entirely. */
  readonly strip: readonly RegExp[];

  /** Deduplication of repeated lines. */
  readonly dedupe: DedupeMode;

  /** Regex with optional named groups; lines must match to become records. */
  readonly match: RegExp | null;

  /** What to do with lines that don't match `match`. */
  readonly unmatched: UnmatchedBehavior;

  /** Group records by this captured field name. */
  readonly groupBy: string | null;

  /** Mustache-style output template; null = field=value form. */
  readonly template: string | null;

  /** Optional prepended string (template-evaluated). */
  readonly header: string | null;

  /** Optional appended string (template-evaluated). */
  readonly footer: string | null;

  /** Maximum output lines; excess collapsed into `truncateMessage`. */
  readonly truncate: number | null;

  /** Template for the "truncated" message. Default: "... and {dropped} more". */
  readonly truncateMessage: string;
}

/** Errors from parsing a filter file. */
export class FilterParseError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly line?: number,
  ) {
    super(`${source}${line != null ? `:${line}` : ""}: ${message}`);
    this.name = "FilterParseError";
  }
}
