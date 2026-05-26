// QTK shared type definitions.

/**
 * A compressor is a pure string-in-string-out transformer. It must NEVER
 * throw, NEVER do I/O, and NEVER produce output larger than its input.
 *
 * The cardinal rule: if anything goes wrong, return `raw` unchanged.
 */
export interface Compressor {
  /** Stable identifier for stats and config overrides. */
  readonly name: string;

  /**
   * Optional category for grouping in dashboards. Free-form string.
   * Examples: "git", "filesystem", "test-runner", "package-manager".
   */
  readonly category?: string;

  /**
   * Does this compressor want to handle (tool, args)?
   * Pure function. Returning true commits — registry stops searching.
   */
  matches(tool: string, args: Record<string, unknown>): boolean;

  /**
   * Synchronous, deterministic transformation of raw output → compact output.
   * Must NEVER throw. If something goes wrong, return `raw` unchanged.
   * Must NEVER do I/O. Pure string-in-string-out.
   */
  compress(raw: string, ctx: CompressorContext): string;
}

export interface CompressorContext {
  /** The full tool args, in case compressor wants to inspect flags. */
  readonly args: Record<string, unknown>;
  /** Project root (Instance.directory equivalent). */
  readonly cwd: string;
  /** Optional config snapshot for this compressor. */
  readonly config: Record<string, unknown>;
}

/** Result of attempting to compress an output. */
export interface CompressionOutcome {
  readonly compressor: string;
  readonly originalBytes: number;
  readonly compressedBytes: number;
  readonly originalTokensEst: number;
  readonly compressedTokensEst: number;
  readonly ratio: number;
  readonly durationMs: number;
  readonly wasCacheHit: boolean;
  readonly teeFile: string | null;
}

/** What the LLM sees if a tool call was compressed. */
export interface CompressedEnvelope {
  readonly origLines: number;
  readonly origBytes: number;
  readonly ratio: number;
  readonly teeFile: string | null;
  readonly compressor: string;
  readonly body: string;
}

/** Loaded QTK config (subset of .opencode/qtk.toml). */
export interface QtkConfig {
  readonly enabled: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly dedupTtlSeconds: number;

  readonly tee: {
    readonly enabled: boolean;
    readonly directory: string;
    readonly mode: "always" | "failures_and_compressed" | "never";
    readonly pruneDays: number;
  };

  readonly stats: {
    readonly enabled: boolean;
    readonly database: string;
  };

  /** Per-compressor overrides. Free-form map; each compressor reads its own keys. */
  readonly compressors: Record<string, Record<string, unknown>>;

  /** Per-built-in-tool overrides (Read, Grep, Glob). */
  readonly tools: Record<string, Record<string, unknown>>;
}
