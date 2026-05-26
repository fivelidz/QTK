// scripts/benchmark-sidecar.ts
//
// Throughput + latency benchmark for the qtk-core Rust sidecar.
//
// Measures:
//   - First-call latency (spawn + hello + first response)
//   - Steady-state requests per second (single-client, serial pipeline)
//   - Steady-state requests per second (concurrent — Promise.all batches)
//   - Per-compressor compression ratios on representative inputs
//
// Usage:
//   bun run scripts/benchmark-sidecar.ts             # default 2000 iters
//   bun run scripts/benchmark-sidecar.ts --iters=10000

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SidecarClient } from "../packages/qtk-plugin/src/sidecar/client.ts";

const QTK_CORE = resolve(
  import.meta.dir,
  "../packages/qtk-core/target/release/qtk-core",
);

const ITERS = Number(
  process.argv
    .find((a) => a.startsWith("--iters="))
    ?.slice("--iters=".length) ?? 2000,
);

if (!existsSync(QTK_CORE)) {
  console.error(`qtk-core not found at ${QTK_CORE}.`);
  console.error(`Run \`cargo build --release\` in packages/qtk-core/.`);
  process.exit(1);
}

interface Inputs {
  name: string;
  compressor: string;
  input: string;
}

function makeInputs(): Inputs[] {
  // Terraform plan — synthetic 20-resource plan
  const tfLines: string[] = [
    "Terraform will perform the following actions:",
    "",
  ];
  for (let i = 0; i < 10; i++) {
    tfLines.push(`  # aws_instance.svc_${i} will be updated in-place`);
    tfLines.push(`  ~ resource "aws_instance" "svc_${i}" {`);
    tfLines.push(`        ami           = "ami-0c55"`);
    tfLines.push(`      ~ instance_type = "t3.micro" -> "t3.small"`);
    tfLines.push(`      ~ tags          = { "Name" = "svc-${i}" }`);
    tfLines.push(`    }`);
    tfLines.push("");
  }
  for (let i = 0; i < 10; i++) {
    tfLines.push(`  # aws_eip.new_${i} will be created`);
    tfLines.push(`  + resource "aws_eip" "new_${i}" {`);
    tfLines.push(`      + name = "eip-${i}"`);
    tfLines.push(`    }`);
    tfLines.push("");
  }
  tfLines.push("Plan: 10 to add, 10 to change, 0 to destroy.");
  const terraform = tfLines.join("\n");

  // Kubectl pod list (JSON)
  const pods: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    pods.push({
      kind: "Pod",
      metadata: {
        name: `pod-${i.toString().padStart(3, "0")}`,
        namespace: "default",
      },
      status: { phase: i % 7 === 0 ? "Pending" : "Running" },
    });
  }
  const kubectl = JSON.stringify({ kind: "PodList", items: pods });

  // Cargo JSON — 30 artifacts + 1 error
  const cargoLines: string[] = [];
  for (let i = 0; i < 30; i++) {
    cargoLines.push(
      JSON.stringify({
        reason: "compiler-artifact",
        package_id: `pkg-${i} 0.1.0 (registry+x)`,
        target: {},
        profile: {},
        features: [],
        filenames: [],
        executable: null,
        fresh: true,
      }),
    );
  }
  cargoLines.push(
    JSON.stringify({
      reason: "compiler-message",
      package_id: "my_crate 0.1.0",
      target: {},
      message: {
        rendered: "error[E0277]: trait bound not satisfied",
        level: "error",
        spans: [{ file_name: "src/x.rs", line_start: 42, column_start: 5 }],
      },
    }),
  );
  cargoLines.push(JSON.stringify({ reason: "build-finished", success: false }));
  const cargo = cargoLines.join("\n");

  // JUnit XML — 40 passing + 3 failing
  const junitCases: string[] = [];
  for (let i = 0; i < 40; i++) {
    junitCases.push(
      `    <testcase classname="x.y" name="test_${i}" time="0.01"/>`,
    );
  }
  junitCases.push(
    `    <testcase classname="x.y" name="test_fail_a"><failure message="assert 1 == 2"/></testcase>`,
  );
  junitCases.push(
    `    <testcase classname="x.y" name="test_fail_b"><failure message="NullPointerException"/></testcase>`,
  );
  junitCases.push(
    `    <testcase classname="x.y" name="test_fail_c"><failure message="timeout after 30s"/></testcase>`,
  );
  const junit = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="x.y" tests="43" failures="3" errors="0">
${junitCases.join("\n")}
  </testsuite>
</testsuites>`;

  return [
    { name: "terraform-plan", compressor: "terraform-plan", input: terraform },
    { name: "kubectl-json", compressor: "kubectl-json", input: kubectl },
    { name: "cargo-json", compressor: "cargo-json", input: cargo },
    { name: "junit-xml", compressor: "junit-xml", input: junit },
  ];
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
  console.log(`qtk-core sidecar benchmark (${ITERS} iters per case)\n`);

  const inputs = makeInputs();

  // ─── First-call latency: spawn + hello + first compress ───────────────
  console.log("Cold start latency (spawn → hello → first compress):");
  for (let trial = 0; trial < 3; trial++) {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    const t0 = performance.now();
    await c.start();
    const tReady = performance.now() - t0;
    const tFirst = performance.now();
    await c.compress("terraform-plan", inputs[0]!.input);
    const tCompress = performance.now() - tFirst;
    await c.stop();
    console.log(
      `  trial ${trial + 1}: start=${tReady.toFixed(1)}ms, first compress=${tCompress.toFixed(2)}ms, total cold=${(tReady + tCompress).toFixed(1)}ms`,
    );
  }
  console.log("");

  // ─── Throughput: serial requests on a warm client ─────────────────────
  console.log("Throughput (serial, one client):");
  console.log(
    "case".padEnd(20),
    "in".padStart(8),
    "out".padStart(8),
    "saved".padStart(7),
    "p50".padStart(8),
    "p99".padStart(8),
    "ops/s".padStart(10),
  );
  console.log("-".repeat(80));

  for (const c of inputs) {
    const client = new SidecarClient({ binaryPath: QTK_CORE });
    await client.start();
    // Warm-up
    for (let i = 0; i < 50; i++) await client.compress(c.compressor, c.input);

    const timings: number[] = [];
    const tStart = performance.now();
    let lastOut = "";
    for (let i = 0; i < ITERS; i++) {
      const t0 = performance.now();
      const r = await client.compress(c.compressor, c.input);
      timings.push(performance.now() - t0);
      if (r) lastOut = r.output;
    }
    const tEnd = performance.now();
    timings.sort((a, b) => a - b);
    const opsPerSec = (ITERS * 1000) / (tEnd - tStart);
    const ratio = lastOut.length / c.input.length;
    console.log(
      c.name.padEnd(20),
      fmt(c.input.length).padStart(8),
      fmt(lastOut.length).padStart(8),
      pct(1 - ratio).padStart(7),
      ms(timings[Math.floor(timings.length * 0.5)] ?? 0).padStart(8),
      ms(timings[Math.floor(timings.length * 0.99)] ?? 0).padStart(8),
      opsPerSec.toFixed(0).padStart(10),
    );
    await client.stop();
  }

  console.log("");

  // ─── Throughput: concurrent (batches of 50) ───────────────────────────
  console.log("Throughput (concurrent batches of 50):");
  const client = new SidecarClient({ binaryPath: QTK_CORE });
  await client.start();
  for (const c of inputs) {
    // Warm
    await client.compress(c.compressor, c.input);
    const BATCH = 50;
    const BATCHES = Math.ceil(ITERS / BATCH);
    const tStart = performance.now();
    for (let b = 0; b < BATCHES; b++) {
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < BATCH; i++) {
        promises.push(client.compress(c.compressor, c.input));
      }
      await Promise.all(promises);
    }
    const tEnd = performance.now();
    const totalReq = BATCHES * BATCH;
    const opsPerSec = (totalReq * 1000) / (tEnd - tStart);
    console.log(
      `  ${c.name.padEnd(20)} ${opsPerSec.toFixed(0).padStart(10)} ops/s (over ${totalReq} requests)`,
    );
  }
  await client.stop();
}

await main();
