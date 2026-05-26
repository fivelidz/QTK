// Compressor registry — maps (tool, args) to the right compressor.
// First-match wins. Built-in tool compressors (Read/Grep/Glob) check the
// tool name; command compressors check args.command.

import type { Compressor } from "./types.ts";

// Compressors imported here — each is a small module exporting a single
// instance.
import { gitStatusCompressor } from "./compressors/git.ts";
import { lsCompressor } from "./compressors/ls.ts";
import { rgCompressor } from "./compressors/rg.ts";
import { pytestCompressor } from "./compressors/pytest.ts";
import { cargoTestCompressor } from "./compressors/cargo.ts";
import { readToolCompressor } from "./tools/read.ts";
import { grepToolCompressor } from "./tools/grep.ts";
import { globToolCompressor } from "./tools/glob.ts";

/**
 * Default registry. Order matters — first match wins.
 */
export const DEFAULT_COMPRESSORS: readonly Compressor[] = [
  // Built-in tools first (most specific)
  readToolCompressor,
  grepToolCompressor,
  globToolCompressor,
  // Then shell command compressors
  gitStatusCompressor,
  lsCompressor,
  rgCompressor,
  pytestCompressor,
  cargoTestCompressor,
];

export class CompressorRegistry {
  private compressors: Compressor[];

  constructor(compressors: readonly Compressor[] = DEFAULT_COMPRESSORS) {
    this.compressors = [...compressors];
  }

  /**
   * Find the first compressor that wants to handle (tool, args).
   * Returns null if nothing matches — caller decides what to do
   * (e.g. leave output unchanged or fall back to generic heuristics).
   */
  lookup(tool: string, args: Record<string, unknown>): Compressor | null {
    for (const c of this.compressors) {
      if (c.matches(tool, args)) return c;
    }
    return null;
  }

  /**
   * Prepend user-defined compressors (e.g. DSL filters loaded from
   * `.opencode/qtk/filters/`) so they take priority over built-ins
   * when both could handle the same command.
   */
  prepend(extras: readonly Compressor[]): void {
    this.compressors = [...extras, ...this.compressors];
  }

  /**
   * Replace all user-defined compressors (those previously added via
   * `prepend`). Used by hot-reload to swap the DSL set without
   * disturbing built-ins. Built-ins are identified by reference equality
   * with DEFAULT_COMPRESSORS.
   */
  replaceUserCompressors(extras: readonly Compressor[]): void {
    const builtins = this.compressors.filter((c) =>
      DEFAULT_COMPRESSORS.includes(c),
    );
    this.compressors = [...extras, ...builtins];
  }

  /** Total registered compressors. */
  size(): number {
    return this.compressors.length;
  }

  /** Names of all registered compressors, in order. */
  names(): readonly string[] {
    return this.compressors.map((c) => c.name);
  }
}
