// `pytest` compressor.
//
// pytest output has a predictable structure:
//   - Header: platform, python version, rootdir, plugins
//   - Per-test progress dots / verbose names
//   - "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
//   - Tracebacks (very long)
//   - Final summary: `===== 3 passed, 1 failed in 4.2s =====`
//
// For passing runs, all the model needs to know is the summary line.
// For failing runs, the model needs the FAILED lines + first 10 lines of
// each traceback. The 500+ lines of header/progress can go.

import type { Compressor } from "../types.ts";

const TRACE_HEAD_LINES = 8;

export const pytestCompressor: Compressor = {
  name: "pytest",
  category: "test-runner",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    return /^(python\s+-m\s+pytest|pytest)\b/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    // Find the final summary line, which is the most reliable anchor.
    // Format: "= N passed in T.Ts =" or "= N failed, M passed in T.Ts ="
    let summary: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (/^=+\s+\d+\s+(passed|failed|error)/.test(line)) {
        summary = line.replace(/=+/g, "").trim();
        break;
      }
    }
    if (!summary) return raw;

    // Did anything fail?
    const allPassed = !/(\d+\s+failed)|(\d+\s+error)/.test(summary);
    if (allPassed) {
      // Best case: just the summary line.
      return `pytest: ${summary}`;
    }

    // Failures present. Collect FAILED/ERROR lines and their immediate
    // traceback context.
    const failedLines: string[] = [];
    const failureBlocks: string[] = [];
    let inFailureBlock = false;
    let blockBuffer: string[] = [];

    for (const line of lines) {
      const failedMatch = line.match(/^FAILED\s+(.+?)(?:\s+-\s+(.+))?$/);
      if (failedMatch) {
        failedLines.push(
          `FAILED ${failedMatch[1]!}${failedMatch[2] ? ` - ${failedMatch[2]}` : ""}`,
        );
        continue;
      }
      // Failure section header looks like "____ test_name ____"
      const sectionMatch = line.match(/^_{3,}\s+(.+?)\s+_{3,}$/);
      if (sectionMatch) {
        if (blockBuffer.length > 0) {
          failureBlocks.push(blockBuffer.slice(0, TRACE_HEAD_LINES).join("\n"));
          blockBuffer = [];
        }
        inFailureBlock = true;
        blockBuffer.push(`── ${sectionMatch[1]!}`);
        continue;
      }
      if (inFailureBlock) {
        // End of failures section is "= short test summary info ="
        if (/^=+/.test(line)) {
          if (blockBuffer.length > 0) {
            failureBlocks.push(
              blockBuffer.slice(0, TRACE_HEAD_LINES).join("\n"),
            );
            blockBuffer = [];
          }
          inFailureBlock = false;
          continue;
        }
        blockBuffer.push(line);
      }
    }
    if (blockBuffer.length > 0) {
      failureBlocks.push(blockBuffer.slice(0, TRACE_HEAD_LINES).join("\n"));
    }

    const out: string[] = [`pytest: ${summary}`];
    if (failureBlocks.length > 0) {
      out.push("");
      for (const block of failureBlocks) {
        out.push(block);
        out.push("");
      }
    } else if (failedLines.length > 0) {
      out.push("");
      out.push(...failedLines);
    }

    const result = out.join("\n").trimEnd();
    if (result.length >= raw.length) return raw;
    return result;
  },
};
