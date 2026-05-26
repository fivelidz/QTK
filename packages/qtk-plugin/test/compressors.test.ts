// Compressor unit tests. Each test verifies:
//   1. The compressor actually compresses (output < input)
//   2. The compression ratio meets a reasonable threshold
//   3. Adversarial input doesn't crash or hang
//   4. Empty / tiny input passes through unchanged

import { describe, test, expect } from "bun:test";
import {
  gitStatusCompressor,
  gitLogCompressor,
} from "../src/compressors/git.ts";
import { lsCompressor } from "../src/compressors/ls.ts";
import { rgCompressor } from "../src/compressors/rg.ts";
import { pytestCompressor } from "../src/compressors/pytest.ts";
import { cargoTestCompressor } from "../src/compressors/cargo.ts";
import { readToolCompressor } from "../src/tools/read.ts";
import { grepToolCompressor } from "../src/tools/grep.ts";
import { globToolCompressor } from "../src/tools/glob.ts";
import { SessionCache } from "../src/cache.ts";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { _internal as teeInternal } from "../src/tee.ts";
import type { Compressor } from "../src/types.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

// Helper: assert that the compressor matches a given (tool, args) and
// actually reduces output size.
function expectCompresses(
  c: Compressor,
  tool: string,
  args: Record<string, unknown>,
  input: string,
  minRatioReduction: number,
) {
  expect(c.matches(tool, args)).toBe(true);
  const out = c.compress(input, { ...CTX, args });
  expect(out.length).toBeLessThan(input.length);
  const ratio = out.length / input.length;
  expect(ratio).toBeLessThan(1 - minRatioReduction); // e.g. 0.5 = at least 50% reduction
  return { out, ratio };
}

// ─── git status ─────────────────────────────────────────────────────────────

describe("git-status compressor", () => {
  test("matches `git status`", () => {
    expect(gitStatusCompressor.matches("bash", { command: "git status" })).toBe(
      true,
    );
    expect(
      gitStatusCompressor.matches("bash", { command: "git status   " }),
    ).toBe(true);
  });

  test("does NOT match `git status --short` (already compact)", () => {
    expect(
      gitStatusCompressor.matches("bash", { command: "git status --short" }),
    ).toBe(false);
    expect(
      gitStatusCompressor.matches("bash", {
        command: "git status --porcelain",
      }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(gitStatusCompressor.matches("read", { command: "git status" })).toBe(
      false,
    );
  });

  test("compresses a typical status by ≥ 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const { out, ratio } = expectCompresses(
      gitStatusCompressor,
      "bash",
      { command: "git status" },
      input,
      0.4,
    );
    // Sanity-check structure
    expect(out).toContain("branch=qalcode-offline-improvements");
    expect(out).toContain("staged (");
    expect(out).toContain("unstaged (");
    expect(out).toContain("untracked (");
    expect(ratio).toBeLessThan(0.6);
  });

  test("compresses a large status by ≥ 60%", () => {
    // Build a synthetic large status with many files (real-world common case)
    const filesA: string[] = [];
    const filesB: string[] = [];
    for (let i = 0; i < 50; i++) {
      filesA.push(`\tmodified:   packages/opencode/src/file-${i}.ts`);
      filesB.push(`\tmodified:   packages/ui/src/component-${i}.tsx`);
    }
    const input = `On branch main
Your branch is up to date with 'origin/main'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
${filesA.join("\n")}

Changes not staged for commit:
${filesB.join("\n")}

no changes added to commit
`;
    const out = gitStatusCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length * 0.4);
  });

  test("clean tree returns 'clean working tree'", () => {
    const input = `On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
`;
    const out = gitStatusCompressor.compress(input, CTX);
    expect(out).toContain("branch=main");
    expect(out).toContain("clean working tree");
  });

  test("tiny input passes through unchanged", () => {
    const input = "short";
    expect(gitStatusCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged (no parse → fallback)", () => {
    const garbage =
      "this is not git status output\nat all\nplease\nignore me\n".repeat(20);
    expect(gitStatusCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k random lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(`\tmodified: file-${i}.ts`);
    }
    const input =
      "On branch main\nChanges to be committed:\n" + lines.join("\n");
    const t0 = performance.now();
    gitStatusCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max even for adversarial
  });
});

// ─── git log ────────────────────────────────────────────────────────────────

describe("git-log compressor", () => {
  test("matches `git log`", () => {
    expect(gitLogCompressor.matches("bash", { command: "git log" })).toBe(true);
    expect(gitLogCompressor.matches("bash", { command: "git log -n 10" })).toBe(
      true,
    );
  });

  test("does NOT match `git log --oneline`", () => {
    expect(
      gitLogCompressor.matches("bash", { command: "git log --oneline" }),
    ).toBe(false);
  });

  test("compresses multi-line commits to one-liners", () => {
    const input = `commit 9af45436cb316cfc5372738ae26ad9d1cfcd4217
Author: Five Lidz <fivelidz@example.com>
Date:   Mon Apr 14 16:51:02 2026 +1000

    fix: upgrade anthropic auth plugin to @ex-machina

commit 8bba32f7e8d9c12a4b5c6d7e8f9a0b1c2d3e4f5a
Author: Five Lidz <fivelidz@example.com>
Date:   Mon Apr 14 14:30:21 2026 +1000

    Auth: fall back to Claude Code credentials
`;
    const out = gitLogCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("9af4543");
    expect(out).toContain("2026-04-14");
    expect(out).toContain("fix:");
  });
});

// ─── ls ─────────────────────────────────────────────────────────────────────

describe("ls compressor", () => {
  test("matches `ls -la`", () => {
    expect(lsCompressor.matches("bash", { command: "ls -la" })).toBe(true);
    expect(lsCompressor.matches("bash", { command: "ls" })).toBe(true);
    expect(lsCompressor.matches("bash", { command: "ls /tmp" })).toBe(true);
  });

  test("does NOT match piped ls", () => {
    expect(lsCompressor.matches("bash", { command: "ls | grep foo" })).toBe(
      false,
    );
    expect(lsCompressor.matches("bash", { command: "ls && cat" })).toBe(false);
  });

  test("compresses ls -la output", () => {
    const input = `total 48
drwxr-xr-x  6 user user  4096 May 20 14:23 .
drwxr-xr-x 25 user user  4096 May 20 14:20 ..
-rw-r--r--  1 user user   168 Jan 21 15:20 .gitignore
drwxr-xr-x 14 user user  4096 May 20 14:23 .git
-rw-r--r--  1 user user  3284 May 20 14:23 README.md
-rw-r--r--  1 user user  1024 May 20 14:23 BRIEF.md
drwxr-xr-x  5 user user  4096 May 20 14:23 packages
drwxr-xr-x  2 user user  4096 May 20 14:23 docs
drwxr-xr-x  2 user user  4096 May 20 14:23 scripts
-rw-r--r--  1 user user  1086 May 20 14:23 LICENSE
-rw-r--r--  1 user user   141 May 20 14:23 .opencodeignore
-rw-r--r--  1 user user   183 May 20 14:23 package.json
-rw-r--r--  1 user user    93 May 20 14:23 .gitignore
`;
    const out = lsCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("packages/");
    expect(out).toContain("README.md");
  });
});

// ─── rg ─────────────────────────────────────────────────────────────────────

describe("rg compressor", () => {
  test("matches `rg <pattern>`", () => {
    expect(rgCompressor.matches("bash", { command: "rg useEffect" })).toBe(
      true,
    );
    expect(
      rgCompressor.matches("bash", { command: "rg -i pattern src/" }),
    ).toBe(true);
  });

  test("matches `grep -r`", () => {
    expect(rgCompressor.matches("bash", { command: "grep -r foo src/" })).toBe(
      true,
    );
    expect(rgCompressor.matches("bash", { command: "grep -rn foo src/" })).toBe(
      true,
    );
  });

  test("compresses no-heading format", () => {
    const lines: string[] = [];
    for (let f = 0; f < 10; f++) {
      for (let m = 0; m < 5; m++) {
        lines.push(
          `src/file-${f}.ts:${m * 17}:some matching content here ${m}`,
        );
      }
    }
    const input = lines.join("\n");
    const out = rgCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("50 matches across 10 files");
  });
});

// ─── pytest ─────────────────────────────────────────────────────────────────

describe("pytest compressor", () => {
  test("matches pytest invocations", () => {
    expect(pytestCompressor.matches("bash", { command: "pytest" })).toBe(true);
    expect(pytestCompressor.matches("bash", { command: "pytest tests/" })).toBe(
      true,
    );
    expect(
      pytestCompressor.matches("bash", { command: "python -m pytest" }),
    ).toBe(true);
  });

  test("passing run → just the summary line", () => {
    const input = `============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0
rootdir: /home/user/project
collected 42 items

tests/test_foo.py ..........                                             [ 23%]
tests/test_bar.py ......................                                 [ 76%]
tests/test_baz.py ..........                                             [100%]

============================== 42 passed in 4.21s ==============================
`;
    const out = pytestCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("42 passed");
    expect(out).toContain("4.21s");
    expect(out).not.toContain("tests/test_foo.py");
  });

  test("failing run → keeps FAILED lines", () => {
    const input = `============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0
collected 5 items

tests/test_thing.py .F.F.

=================================== FAILURES ===================================
______________________________ test_addition ____________________________________

    def test_addition():
>       assert 1 + 1 == 3
E       assert 2 == 3

tests/test_thing.py:5: AssertionError
______________________________ test_subtraction _________________________________

    def test_subtraction():
>       assert 10 - 5 == 4
E       assert 5 == 4

tests/test_thing.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_thing.py::test_addition - assert 2 == 3
FAILED tests/test_thing.py::test_subtraction - assert 5 == 4
============================== 2 failed, 3 passed in 0.51s ==============================
`;
    const out = pytestCompressor.compress(input, CTX);
    expect(out).toContain("2 failed");
    expect(out).toContain("test_addition");
    expect(out).toContain("test_subtraction");
  });
});

// ─── cargo ──────────────────────────────────────────────────────────────────

describe("cargo compressor", () => {
  test("matches cargo subcommands", () => {
    expect(cargoTestCompressor.matches("bash", { command: "cargo test" })).toBe(
      true,
    );
    expect(
      cargoTestCompressor.matches("bash", { command: "cargo build --release" }),
    ).toBe(true);
    expect(
      cargoTestCompressor.matches("bash", { command: "cargo clippy" }),
    ).toBe(true);
  });

  test("strips Compiling lines", () => {
    const input = `   Compiling proc-macro2 v1.0.95
   Compiling unicode-ident v1.0.13
   Compiling quote v1.0.40
   Compiling syn v2.0.103
   Compiling serde_derive v1.0.228
   Compiling serde v1.0.228
   Compiling foo v0.1.0 (/home/user/project)
    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 12.34s
     Running unittests src/main.rs (target/debug/deps/foo-abc)

running 5 tests
test test_a ... ok
test test_b ... ok
test test_c ... ok
test test_d ... ok
test test_e ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
`;
    const out = cargoTestCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("compiled 7 crates");
    expect(out).toContain("Finished");
    expect(out).toContain("test result");
  });
});

// ─── Read tool ──────────────────────────────────────────────────────────────

describe("Read tool compressor", () => {
  test("matches read tool", () => {
    expect(readToolCompressor.matches("read", {})).toBe(true);
    expect(readToolCompressor.matches("Read", {})).toBe(true);
    expect(readToolCompressor.matches("bash", {})).toBe(false);
  });

  test("compresses long file into outline", () => {
    const lines: string[] = ["<file>"];
    for (let i = 1; i <= 500; i++) {
      const num = String(i).padStart(5, "0");
      if (i === 1) lines.push(`${num}| import { foo } from "bar"`);
      else if (i === 17) lines.push(`${num}| export function main() {`);
      else if (i === 42) lines.push(`${num}| class MyService {`);
      else if (i === 100) lines.push(`${num}| export const CONFIG = {`);
      else if (i === 200) lines.push(`${num}| interface Options {`);
      else lines.push(`${num}|     // some code here ${i}`);
    }
    lines.push("</file>");
    const input = lines.join("\n");

    const out = readToolCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("<file-outline");
    expect(out).toContain("import");
    expect(out).toContain("export function main");
    expect(out).toContain("class MyService");
  });

  test("short file passes through unchanged", () => {
    const input = `<file>
00001| short file
00002| nothing to compress
</file>`;
    expect(readToolCompressor.compress(input, CTX)).toBe(input);
  });
});

// ─── Grep tool ──────────────────────────────────────────────────────────────

describe("Grep tool compressor", () => {
  test("matches grep tool", () => {
    expect(grepToolCompressor.matches("grep", {})).toBe(true);
    expect(grepToolCompressor.matches("Grep", {})).toBe(true);
  });

  test("compresses multi-file grep results", () => {
    const lines: string[] = [];
    for (let f = 0; f < 8; f++) {
      lines.push(`src/file-${f}.ts:`);
      for (let m = 0; m < 4; m++) {
        lines.push(`  Line ${m * 12}: matching text ${m}`);
      }
      lines.push("");
    }
    const input = lines.join("\n");
    const out = grepToolCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("matches across");
  });
});

// ─── Glob tool ──────────────────────────────────────────────────────────────

describe("Glob tool compressor", () => {
  test("matches glob tool", () => {
    expect(globToolCompressor.matches("glob", {})).toBe(true);
    expect(globToolCompressor.matches("Glob", {})).toBe(true);
  });

  test("clusters paths by common directory", () => {
    const paths: string[] = [];
    for (let i = 0; i < 20; i++)
      paths.push(`packages/opencode/src/file-${i}.ts`);
    for (let i = 0; i < 15; i++) paths.push(`packages/ui/src/comp-${i}.tsx`);
    for (let i = 0; i < 10; i++) paths.push(`packages/sdk/src/thing-${i}.ts`);
    const input = paths.join("\n");
    const out = globToolCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("45 paths in");
    expect(out).toContain("packages/opencode/");
  });

  test("small lists pass through", () => {
    const input = ["src/a.ts", "src/b.ts", "src/c.ts"].join("\n");
    expect(globToolCompressor.compress(input, CTX)).toBe(input);
  });
});

// ─── Cache ──────────────────────────────────────────────────────────────────

describe("SessionCache", () => {
  test("fingerprint is stable for same args (key-order invariant)", () => {
    const c = new SessionCache();
    const fp1 = c.fingerprint("bash", { command: "git status", cwd: "/x" });
    const fp2 = c.fingerprint("bash", { cwd: "/x", command: "git status" });
    expect(fp1).toBe(fp2);
  });

  test("lookup returns null when output hash differs", () => {
    const c = new SessionCache();
    const fp = c.fingerprint("bash", { command: "x" });
    c.put(fp, "hash-A", "compressed-A");
    expect(c.lookup(fp, "hash-A", 60_000)).not.toBeNull();
    expect(c.lookup(fp, "hash-B", 60_000)).toBeNull();
  });

  test("LRU prunes when over capacity", () => {
    const c = new SessionCache();
    for (let i = 0; i < 600; i++) {
      const fp = c.fingerprint("bash", { command: `cmd-${i}` });
      c.put(fp, `h${i}`, `c${i}`);
    }
    expect(c.size()).toBeLessThanOrEqual(500);
  });
});

// ─── Circuit breaker ────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  test("disables compressor after 3 failures", () => {
    const cb = new CircuitBreaker();
    expect(cb.isDisabled("foo")).toBe(false);
    cb.recordFailure("foo");
    cb.recordFailure("foo");
    expect(cb.isDisabled("foo")).toBe(false);
    const justDisabled = cb.recordFailure("foo");
    expect(justDisabled).toBe(true);
    expect(cb.isDisabled("foo")).toBe(true);
  });

  test("multiple compressors are independent", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure("a");
    cb.recordFailure("a");
    cb.recordFailure("a");
    expect(cb.isDisabled("a")).toBe(true);
    expect(cb.isDisabled("b")).toBe(false);
  });
});

// ─── Tee secrets redaction ──────────────────────────────────────────────────

describe("Tee secret redaction", () => {
  test("redacts AWS keys", () => {
    const input = "AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE found in env";
    const out = teeInternal.redact(input);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("redacted");
  });

  test("redacts GitHub PATs", () => {
    const input = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABC";
    const out = teeInternal.redact(input);
    expect(out).not.toContain("ghp_abcdefghij");
  });

  test("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer sk-veryverysecret";
    const out = teeInternal.redact(input);
    expect(out).toContain("Bearer <redacted>");
    expect(out).not.toContain("veryverysecret");
  });

  test("leaves benign output unchanged", () => {
    const input = "hello world\nnothing to see here\n";
    expect(teeInternal.redact(input)).toBe(input);
  });
});
