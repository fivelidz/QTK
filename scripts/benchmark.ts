// scripts/benchmark.ts
//
// Measure compression ratios and latency percentiles across every
// compressor against the fixture corpus. Intended for local CI and
// quick regression checks during compressor development.
//
// Usage:
//   bun run scripts/benchmark.ts                  # all compressors
//   bun run scripts/benchmark.ts --iters=1000     # repeat for percentile data

import { resolve } from "node:path";
import {
  gitStatusCompressor,
  gitLogCompressor,
} from "../packages/qtk-plugin/src/compressors/git.ts";
import { lsCompressor } from "../packages/qtk-plugin/src/compressors/ls.ts";
import { rgCompressor } from "../packages/qtk-plugin/src/compressors/rg.ts";
import { pytestCompressor } from "../packages/qtk-plugin/src/compressors/pytest.ts";
import { cargoTestCompressor } from "../packages/qtk-plugin/src/compressors/cargo.ts";
import { readToolCompressor } from "../packages/qtk-plugin/src/tools/read.ts";
import { grepToolCompressor } from "../packages/qtk-plugin/src/tools/grep.ts";
import { globToolCompressor } from "../packages/qtk-plugin/src/tools/glob.ts";
import { compileFilter } from "../packages/qtk-plugin/src/dsl/runtime.ts";
import { validateFilterSpec } from "../packages/qtk-plugin/src/dsl/spec.ts";
import type { Compressor } from "../packages/qtk-plugin/src/types.ts";

// Pre-compile a representative DSL filter (kubectl get pods) for benchmarking
const kubectlPodsCompressor = compileFilter(
  validateFilterSpec(
    {
      command: "kubectl get pods",
      strip: ["^NAME\\s+READY"],
      match:
        "^(?<name>\\S+)\\s+(?<ready>\\d+/\\d+)\\s+(?<status>\\S+)\\s+(?<restarts>\\d+)\\s+(?<age>\\S+)$",
      group_by: "status",
      template: "{status}: {n} pods",
      header: "{matched} pods total",
      min_input_lines: 1,
    },
    "/bench/kubectl-pods.toml",
  ),
);

const ITERS = Number(
  process.argv
    .find((a) => a.startsWith("--iters="))
    ?.slice("--iters=".length) ?? 200,
);
const CTX = { args: {}, cwd: "/tmp", config: {} };

interface BenchCase {
  name: string;
  compressor: Compressor;
  tool: string;
  args: Record<string, unknown>;
  inputProvider: () => Promise<string>;
}

const CASES: BenchCase[] = [
  {
    name: "git status (real opencode-fork output)",
    compressor: gitStatusCompressor,
    tool: "bash",
    args: { command: "git status" },
    inputProvider: () =>
      Bun.file(
        resolve(
          import.meta.dir,
          "../packages/qtk-plugin/test/fixtures/git/status-long.input.txt",
        ),
      ).text(),
  },
  {
    name: "git status (synthetic large)",
    compressor: gitStatusCompressor,
    tool: "bash",
    args: { command: "git status" },
    inputProvider: async () => {
      const filesA: string[] = [],
        filesB: string[] = [];
      for (let i = 0; i < 50; i++) {
        filesA.push(`\tmodified:   packages/opencode/src/file-${i}.ts`);
        filesB.push(`\tmodified:   packages/ui/src/comp-${i}.tsx`);
      }
      return `On branch main
Your branch is up to date with 'origin/main'.

Changes to be committed:
${filesA.join("\n")}

Changes not staged for commit:
${filesB.join("\n")}
`;
    },
  },
  {
    name: "rg (50 matches, 10 files)",
    compressor: rgCompressor,
    tool: "bash",
    args: { command: "rg useEffect src/" },
    inputProvider: async () => {
      const lines: string[] = [];
      for (let f = 0; f < 10; f++)
        for (let m = 0; m < 5; m++)
          lines.push(
            `src/file-${f}.ts:${m * 17}:some matching content with useEffect callback example ${m}`,
          );
      return lines.join("\n");
    },
  },
  {
    name: "Read tool (500-line file)",
    compressor: readToolCompressor,
    tool: "read",
    args: {},
    inputProvider: async () => {
      const lines: string[] = ["<file>"];
      for (let i = 1; i <= 500; i++) {
        const num = String(i).padStart(5, "0");
        if (i === 1) lines.push(`${num}| import { foo } from "bar"`);
        else if (i === 17) lines.push(`${num}| export function main() {`);
        else if (i === 42) lines.push(`${num}| class MyService {`);
        else lines.push(`${num}|     // some code here ${i}`);
      }
      lines.push("</file>");
      return lines.join("\n");
    },
  },
  {
    name: "DSL: kubectl get pods (60 rows)",
    compressor: kubectlPodsCompressor,
    tool: "bash",
    args: { command: "kubectl get pods" },
    inputProvider: async () => {
      const lines: string[] = ["NAME    READY   STATUS    RESTARTS   AGE"];
      const statuses = ["Running", "Running", "Running", "Pending", "CrashLoopBackOff"];
      for (let i = 0; i < 60; i++) {
        const s = statuses[i % statuses.length]!;
        lines.push(
          `pod-deployment-7d8c9b7f5-${("000" + i).slice(-4)}   1/1     ${s}     ${i % 5}          ${i}d`,
        );
      }
      return lines.join("\n");
    },
  },
  {
    name: "Glob (45 paths in 3 clusters)",
    compressor: globToolCompressor,
    tool: "glob",
    args: {},
    inputProvider: async () => {
      const paths: string[] = [];
      for (let i = 0; i < 20; i++)
        paths.push(`packages/opencode/src/file-${i}.ts`);
      for (let i = 0; i < 15; i++) paths.push(`packages/ui/src/comp-${i}.tsx`);
      for (let i = 0; i < 10; i++) paths.push(`packages/sdk/src/thing-${i}.ts`);
      return paths.join("\n");
    },
  },
];

interface Result {
  name: string;
  inputBytes: number;
  outputBytes: number;
  ratio: number;
  saved: number;
  p50: number;
  p90: number;
  p99: number;
}

async function bench(c: BenchCase): Promise<Result> {
  const input = await c.inputProvider();
  const timings: number[] = [];
  let out = "";
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    out = c.compressor.compress(input, { ...CTX, args: c.args });
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  return {
    name: c.name,
    inputBytes: input.length,
    outputBytes: out.length,
    ratio: out.length / input.length,
    saved: 1 - out.length / input.length,
    p50: timings[Math.floor(timings.length * 0.5)] ?? 0,
    p90: timings[Math.floor(timings.length * 0.9)] ?? 0,
    p99: timings[Math.floor(timings.length * 0.99)] ?? 0,
  };
}

function fmt(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function ms(n: number): string {
  if (n < 1) return `${(n * 1000).toFixed(0)}µs`;
  return `${n.toFixed(2)}ms`;
}

async function main() {
  console.log(`QTK benchmark (${ITERS} iters per case)\n`);
  console.log(
    "name".padEnd(42),
    "in".padStart(7),
    "out".padStart(7),
    "saved".padStart(7),
    "p50".padStart(8),
    "p90".padStart(8),
    "p99".padStart(8),
  );
  console.log("-".repeat(95));
  for (const c of CASES) {
    const r = await bench(c);
    console.log(
      r.name.padEnd(42),
      fmt(r.inputBytes).padStart(7),
      fmt(r.outputBytes).padStart(7),
      pct(r.saved).padStart(7),
      ms(r.p50).padStart(8),
      ms(r.p90).padStart(8),
      ms(r.p99).padStart(8),
    );
  }

  // Touch unused imports so they remain in the build
  const _unused = [
    gitLogCompressor,
    lsCompressor,
    pytestCompressor,
    cargoTestCompressor,
    grepToolCompressor,
  ];
  void _unused;
}

await main();
