// Phase 3 sidecar integration tests.
//
// These tests SPAWN THE REAL qtk-core BINARY. If the binary hasn't been
// built (no `cargo build --release` in packages/qtk-core/), the suite
// auto-skips with a warning — we don't want to break CI when the Rust
// toolchain isn't around.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SidecarClient } from "../src/sidecar/client.ts";
import { locateQtkCore } from "../src/sidecar/locator.ts";

const QTK_CORE = resolve(
  import.meta.dir,
  "../../qtk-core/target/release/qtk-core",
);

const haveBinary = existsSync(QTK_CORE);

if (!haveBinary) {
  console.warn(
    `[sidecar.test] skipping integration tests — qtk-core not built at ${QTK_CORE}\n` +
      `              run \`cargo build --release\` in packages/qtk-core/ to enable`,
  );
}

const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

describeIf(haveBinary)("SidecarClient — integration", () => {
  test("starts, reports hello, lists expected compressors", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    expect(c.isReady()).toBe(true);
    const compressors = c.availableCompressors();
    expect(compressors).toContain("terraform-plan");
    expect(compressors).toContain("kubectl-yaml");
    expect(compressors).toContain("kubectl-json");
    expect(compressors).toContain("cargo-json");
    expect(compressors).toContain("junit-xml");
    await c.stop();
  });

  test("compresses a real terraform plan", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    const input = `Terraform will perform the following actions:

  # aws_instance.web will be updated in-place
  ~ resource "aws_instance" "web" {
        ami                          = "ami-0c55"
      ~ instance_type                = "t3.micro" -> "t3.small"
      ~ tags                         = {}
    }

  # aws_security_group.api will be created
  + resource "aws_security_group" "api" {
      + name = "api-sg"
    }

Plan: 1 to add, 1 to change, 0 to destroy.
`;
    const res = await c.compress("terraform-plan", input);
    expect(res).not.toBeNull();
    expect(res!.output).toContain("Plan: 1 add, 1 change, 0 destroy");
    expect(res!.output).toContain("aws_instance.web");
    expect(res!.output.length).toBeLessThan(input.length);
    expect(res!.ratio).toBeLessThan(1);
    await c.stop();
  });

  test("compresses a kubectl pod list (JSON)", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    const input = JSON.stringify({
      kind: "PodList",
      items: [
        {
          kind: "Pod",
          metadata: { name: "web-1", namespace: "default" },
          status: { phase: "Running" },
        },
        {
          kind: "Pod",
          metadata: { name: "web-2", namespace: "default" },
          status: { phase: "Running" },
        },
        {
          kind: "Pod",
          metadata: { name: "db-1", namespace: "default" },
          status: { phase: "Pending" },
        },
      ],
    });
    const res = await c.compress("kubectl-json", input);
    expect(res).not.toBeNull();
    expect(res!.output).toContain("3 item(s)");
    expect(res!.output).toContain("Pod/web-1");
    expect(res!.output.length).toBeLessThan(input.length);
    await c.stop();
  });

  test("compresses cargo JSON output", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(
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
    lines.push(
      JSON.stringify({
        reason: "compiler-message",
        package_id: "my_crate 0.1.0",
        target: {},
        message: {
          rendered: "error: type mismatch",
          level: "error",
          spans: [{ file_name: "src/x.rs", line_start: 1, column_start: 1 }],
        },
      }),
    );
    lines.push(JSON.stringify({ reason: "build-finished", success: false }));
    const input = lines.join("\n") + "\n";
    const res = await c.compress("cargo-json", input);
    expect(res).not.toBeNull();
    expect(res!.output).toContain("25 artifact");
    expect(res!.output).toContain("ERROR my_crate");
    expect(res!.output).toContain("success=false");
    expect(res!.output.length).toBeLessThan(input.length / 3);
    await c.stop();
  });

  test("compresses JUnit XML (large)", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    // Use a realistic CI-sized JUnit doc (40 passing + 3 failing) — small
    // ones get caught by the length-monotonicity guard in dispatch().
    const cases: string[] = [];
    for (let i = 0; i < 40; i++) {
      cases.push(
        `    <testcase classname="alpha.module.submodule" name="test_passing_case_${i}" time="0.012"/>`,
      );
    }
    cases.push(
      `    <testcase classname="alpha.module.submodule" name="test_assertion_failure" time="0.05">
      <failure message="assert 2 + 2 == 5" type="AssertionError">
        Traceback (most recent call last):
          File "/x/y/test_alpha.py", line 42, in test_assertion_failure
            assert 2 + 2 == 5
        AssertionError: assert 4 == 5
      </failure>
    </testcase>`,
    );
    cases.push(
      `    <testcase classname="alpha.module.submodule" name="test_division_by_zero" time="0.01"><failure message="ZeroDivisionError: division by zero"/></testcase>`,
    );
    cases.push(
      `    <testcase classname="alpha.module.submodule" name="test_type_mismatch" time="0.01"><failure message="TypeError: unsupported operand type(s)"/></testcase>`,
    );
    const input = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="alpha.module.submodule" tests="43" failures="3" errors="0" skipped="0" time="3.14">
${cases.join("\n")}
  </testsuite>
</testsuites>`;
    const res = await c.compress("junit-xml", input);
    expect(res).not.toBeNull();
    expect(res!.output).toContain("40/43 passed");
    expect(res!.output).toContain("3 failed");
    expect(res!.output).toContain("test_assertion_failure");
    expect(res!.output).toContain("test_division_by_zero");
    expect(res!.output.length).toBeLessThan(input.length / 2);
    await c.stop();
  });

  test("unknown compressor returns null (no crash)", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    const res = await c.compress("does-not-exist", "hello world");
    expect(res).toBeNull();
    expect(c.isReady()).toBe(true); // still ready for more requests
    await c.stop();
  });

  test("concurrent requests don't interleave (id correlation)", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    const inputs = [
      "Terraform will perform the following actions:\n  # a will be created\n  + resource \"a\" \"b\" {}\nPlan: 1 to add, 0 to change, 0 to destroy.\n",
      "Terraform will perform the following actions:\n  # x will be created\n  + resource \"x\" \"y\" {}\nPlan: 2 to add, 0 to change, 0 to destroy.\n",
      "Terraform will perform the following actions:\n  # m will be created\n  + resource \"m\" \"n\" {}\nPlan: 3 to add, 0 to change, 0 to destroy.\n",
    ];
    const results = await Promise.all(
      inputs.map((i) => c.compress("terraform-plan", i)),
    );
    expect(results[0]!.output).toContain("1 add");
    expect(results[1]!.output).toContain("2 add");
    expect(results[2]!.output).toContain("3 add");
    await c.stop();
  });

  test("stop() halts the subprocess and rejects further requests", async () => {
    const c = new SidecarClient({ binaryPath: QTK_CORE });
    await c.start();
    await c.stop();
    const res = await c.compress("terraform-plan", "anything");
    expect(res).toBeNull();
  });
});

describe("locateQtkCore", () => {
  test("returns null when nothing matches", async () => {
    // Make sure env var doesn't trick us
    const orig = process.env.QTK_CORE_PATH;
    delete process.env.QTK_CORE_PATH;
    try {
      const result = await locateQtkCore("/nonexistent-project-root-xyz");
      // It might still find one via PATH or the dev layout — we just check
      // it either returns null or an existing absolute path, never something
      // garbage.
      if (result !== null) {
        expect(existsSync(result)).toBe(true);
      }
    } finally {
      if (orig != null) process.env.QTK_CORE_PATH = orig;
    }
  });

  test("respects QTK_CORE_PATH env override", async () => {
    if (!haveBinary) return; // skip if no binary
    process.env.QTK_CORE_PATH = QTK_CORE;
    try {
      const result = await locateQtkCore("/nonexistent");
      expect(result).toBe(QTK_CORE);
    } finally {
      delete process.env.QTK_CORE_PATH;
    }
  });
});
