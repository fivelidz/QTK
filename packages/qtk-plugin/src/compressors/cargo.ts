// `cargo test` / `cargo build` / `cargo clippy` compressor.
//
// cargo output is highly verbose:
//   - Lots of `Compiling foo v0.1.0 (...)` lines — pure noise
//   - "Finished" / "Running" status — keep summarised
//   - Test progress per-test — noise on success, important on failure
//   - Errors / warnings — keep
//   - Final test summary - keep
//
// Strategy: strip Compiling lines, keep Finished/Running summaries, keep
// errors/warnings, keep test failures.

import type { Compressor } from "../types.ts";

const COMPILING_RE = /^\s*Compiling\s+\S+\s+v[\d.]+/;
const DOWNLOADING_RE = /^\s*(Downloading|Downloaded|Updating|Locking|Fresh)\s+/;
const FINISHED_RE = /^\s*Finished\s+/;
const RUNNING_RE = /^\s*Running\s+/;

export const cargoTestCompressor: Compressor = {
  name: "cargo",
  category: "test-runner",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    return /^cargo\s+(test|build|check|clippy|run)\b/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");
    const out: string[] = [];

    let compilingCount = 0;
    let downloadingCount = 0;
    let inTestRun = false;
    const testFailures: string[] = [];
    const errorBlocks: string[] = [];
    let currentErrorBlock: string[] = [];
    let inErrorBlock = false;

    for (const line of lines) {
      if (COMPILING_RE.test(line)) {
        compilingCount++;
        continue;
      }
      if (DOWNLOADING_RE.test(line)) {
        downloadingCount++;
        continue;
      }

      // Error/warning blocks span until a blank line
      if (/^(error(\[E\d+\])?|warning(\[E\d+\])?):/.test(line)) {
        if (currentErrorBlock.length > 0) {
          errorBlocks.push(currentErrorBlock.join("\n"));
          currentErrorBlock = [];
        }
        inErrorBlock = true;
        currentErrorBlock.push(line);
        continue;
      }
      if (inErrorBlock) {
        if (line.trim() === "") {
          errorBlocks.push(currentErrorBlock.join("\n"));
          currentErrorBlock = [];
          inErrorBlock = false;
        } else {
          // Limit block length
          if (currentErrorBlock.length < 8) currentErrorBlock.push(line);
        }
        continue;
      }

      // Test output
      if (/^running \d+ tests?/.test(line)) {
        inTestRun = true;
        continue;
      }
      if (inTestRun) {
        if (/^test .+ \.\.\. (ok|FAILED|ignored)$/.test(line)) {
          if (line.endsWith("FAILED")) {
            const m = line.match(/^test (.+?) \.\.\. FAILED$/);
            if (m) testFailures.push(`FAILED: ${m[1]!}`);
          }
          continue;
        }
        if (/^test result:/.test(line)) {
          inTestRun = false;
          out.push(line); // summary line — always keep
          continue;
        }
      }

      // Keep Finished, Running summaries
      if (FINISHED_RE.test(line) || RUNNING_RE.test(line)) {
        out.push(line);
        continue;
      }

      // Failed lines in test summary section
      if (/^failures:$/.test(line)) {
        // Keep this and the next ~5 lines
        out.push("(see failures detail in raw output)");
        continue;
      }

      // Anything else: keep if it looks meaningful, drop blank
      if (line.trim() === "") continue;
      // Skip "warning: unused..." etc that are caught above; otherwise keep
      // important diagnostic lines
      out.push(line);
    }

    if (currentErrorBlock.length > 0) {
      errorBlocks.push(currentErrorBlock.join("\n"));
    }

    const header: string[] = [];
    if (compilingCount > 0) header.push(`(compiled ${compilingCount} crates)`);
    if (downloadingCount > 0)
      header.push(`(${downloadingCount} download steps)`);

    const sections: string[] = [];
    if (header.length > 0) sections.push(header.join(" "));
    if (errorBlocks.length > 0) {
      sections.push(`\n${errorBlocks.length} error(s):`);
      sections.push(errorBlocks.slice(0, 5).join("\n\n"));
      if (errorBlocks.length > 5) {
        sections.push(`... +${errorBlocks.length - 5} more errors`);
      }
    }
    if (testFailures.length > 0) {
      sections.push(`\n${testFailures.length} test failure(s):`);
      sections.push(testFailures.slice(0, 20).join("\n"));
      if (testFailures.length > 20) {
        sections.push(`... +${testFailures.length - 20} more`);
      }
    }
    if (out.length > 0) {
      sections.push("");
      sections.push(out.join("\n"));
    }

    const result = sections.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
