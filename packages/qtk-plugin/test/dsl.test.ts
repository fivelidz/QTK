// Phase 2 DSL filter tests — parser, spec validator, runtime, loader.

import { describe, test, expect } from "bun:test";
import { parseFilterToml } from "../src/dsl/parser.ts";
import { validateFilterSpec } from "../src/dsl/spec.ts";
import { compileFilter } from "../src/dsl/runtime.ts";
import { loadFilters } from "../src/dsl/loader.ts";
import { FilterParseError } from "../src/dsl/types.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CTX = { args: {}, cwd: "/tmp", config: {} };

// ─── Parser ─────────────────────────────────────────────────────────────────

describe("DSL parser", () => {
  test("parses basic key-values", () => {
    const t = parseFilterToml(
      `command = "git status"\nenabled = true\ntruncate = 30\n`,
      "test.toml",
    );
    expect(t.command).toBe("git status");
    expect(t.enabled).toBe(true);
    expect(t.truncate).toBe(30);
  });

  test("parses arrays of strings", () => {
    const t = parseFilterToml(
      `strip = ["^foo", "^bar", "^baz"]\n`,
      "test.toml",
    );
    expect(t.strip).toEqual(["^foo", "^bar", "^baz"]);
  });

  test("parses array of commands", () => {
    const t = parseFilterToml(
      `command = ["docker ps", "docker container ls"]\n`,
      "test.toml",
    );
    expect(t.command).toEqual(["docker ps", "docker container ls"]);
  });

  test("preserves regex backslashes (single backslash escape)", () => {
    // User writes "\\s+" in TOML — wants the resulting regex string to be "\s+"
    const t = parseFilterToml(`match = "^(?<name>\\\\S+)\\\\s+"\n`, "test.toml");
    // Two backslashes in source → one backslash in result
    expect(t.match).toBe("^(?<name>\\S+)\\s+");
  });

  test("handles comments and blank lines", () => {
    const t = parseFilterToml(
      `# header\ncommand = "ls"  # inline comment\n\nenabled = false\n`,
      "test.toml",
    );
    expect(t.command).toBe("ls");
    expect(t.enabled).toBe(false);
  });

  test("rejects array-of-tables [[name]]", () => {
    expect(() =>
      parseFilterToml(`[[group]]\nname = "x"\n`, "test.toml"),
    ).toThrow(FilterParseError);
  });

  test("supports sections (flattened-into-key access)", () => {
    const t = parseFilterToml(
      `[outer]\nkey = "value"\n`,
      "test.toml",
    );
    expect((t.outer as Record<string, unknown>).key).toBe("value");
  });

  test("triple-quoted multiline strings", () => {
    const t = parseFilterToml(
      `template = """line1\nline2"""\n`,
      "test.toml",
    );
    expect(t.template).toBe("line1\nline2");
  });

  test("rejects unterminated string", () => {
    expect(() =>
      parseFilterToml(`command = "unclosed\n`, "test.toml"),
    ).toThrow(FilterParseError);
  });

  test("parses negative and float numbers", () => {
    const t = parseFilterToml(`a = -42\nb = 3.14\n`, "test.toml");
    expect(t.a).toBe(-42);
    expect(t.b).toBe(3.14);
  });
});

// ─── Spec validator ─────────────────────────────────────────────────────────

describe("DSL spec validator", () => {
  test("validates a minimal spec", () => {
    const spec = validateFilterSpec(
      { command: "git status" },
      "/tmp/test.toml",
    );
    expect(spec.commands).toEqual(["git status"]);
    expect(spec.enabled).toBe(true);
    expect(spec.dedupe).toBe("none");
    expect(spec.unmatched).toBe("drop");
    expect(spec.name).toBe("test");
  });

  test("requires command field", () => {
    expect(() => validateFilterSpec({}, "/tmp/x.toml")).toThrow(
      FilterParseError,
    );
  });

  test("compiles regex fields", () => {
    const spec = validateFilterSpec(
      {
        command: "ls",
        match: "^(?<file>.+)$",
        strip: ["^total\\s"],
        pass_through_if: "^Error:",
      },
      "/tmp/test.toml",
    );
    expect(spec.match).toBeInstanceOf(RegExp);
    expect(spec.passThroughIf).toBeInstanceOf(RegExp);
    expect(spec.strip.length).toBe(1);
  });

  test("rejects invalid regex", () => {
    expect(() =>
      validateFilterSpec(
        { command: "ls", match: "(unclosed" },
        "/tmp/test.toml",
      ),
    ).toThrow(FilterParseError);
  });

  test("rejects group_by without match", () => {
    expect(() =>
      validateFilterSpec(
        { command: "ls", group_by: "x" },
        "/tmp/test.toml",
      ),
    ).toThrow(FilterParseError);
  });

  test("rejects group_by referring to missing named group", () => {
    expect(() =>
      validateFilterSpec(
        { command: "ls", match: "^(?<x>.+)$", group_by: "y" },
        "/tmp/test.toml",
      ),
    ).toThrow(FilterParseError);
  });

  test("disabled filter returns enabled=false but no validation errors", () => {
    const spec = validateFilterSpec(
      { command: "ls", enabled: false, match: "(broken" },
      "/tmp/test.toml",
    );
    expect(spec.enabled).toBe(false);
  });

  test("dedupe accepts lines/count/none", () => {
    for (const d of ["lines", "count", "none"] as const) {
      const spec = validateFilterSpec(
        { command: "ls", dedupe: d },
        "/tmp/test.toml",
      );
      expect(spec.dedupe).toBe(d);
    }
    expect(() =>
      validateFilterSpec(
        { command: "ls", dedupe: "nope" },
        "/tmp/test.toml",
      ),
    ).toThrow(FilterParseError);
  });
});

// ─── Runtime ────────────────────────────────────────────────────────────────

describe("DSL runtime: command matching", () => {
  test("literal prefix match", () => {
    const c = compileFilter(
      validateFilterSpec({ command: "git status" }, "/tmp/x.toml"),
    );
    expect(c.matches("bash", { command: "git status" })).toBe(true);
    expect(c.matches("bash", { command: "git status --short" })).toBe(true);
    expect(c.matches("bash", { command: "git statuses" })).toBe(false);
    expect(c.matches("bash", { command: "git diff" })).toBe(false);
  });

  test("wildcard match", () => {
    const c = compileFilter(
      validateFilterSpec({ command: "kubectl get *" }, "/tmp/x.toml"),
    );
    expect(c.matches("bash", { command: "kubectl get pods" })).toBe(true);
    expect(c.matches("bash", { command: "kubectl get services -n foo" })).toBe(
      true,
    );
    expect(c.matches("bash", { command: "kubectl delete pods" })).toBe(false);
  });

  test("multiple commands (array)", () => {
    const c = compileFilter(
      validateFilterSpec(
        { command: ["docker ps", "docker container ls"] },
        "/tmp/x.toml",
      ),
    );
    expect(c.matches("bash", { command: "docker ps" })).toBe(true);
    expect(c.matches("bash", { command: "docker container ls" })).toBe(true);
    expect(c.matches("bash", { command: "docker run" })).toBe(false);
  });

  test("only matches bash tool", () => {
    const c = compileFilter(
      validateFilterSpec({ command: "ls" }, "/tmp/x.toml"),
    );
    expect(c.matches("read", { command: "ls" })).toBe(false);
  });
});

describe("DSL runtime: strip", () => {
  test("drops lines matching strip patterns", () => {
    const spec = validateFilterSpec(
      {
        command: "test",
        strip: ["^Compiling ", "^\\s*$"],
        min_input_lines: 1,
      },
      "/tmp/x.toml",
    );
    const c = compileFilter(spec);
    const input =
      "Compiling foo\nKeep this\n\nCompiling bar\nAlso keep\nfinal line\n";
    const out = c.compress(input, CTX);
    expect(out).not.toContain("Compiling");
    expect(out).toContain("Keep this");
    expect(out).toContain("Also keep");
  });
});

describe("DSL runtime: pass_through_if", () => {
  test("returns raw when pattern matches", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          pass_through_if: "^ERROR:",
          strip: ["."],
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const input = "ERROR: something blew up\nmore detail here\nstack trace\n";
    expect(c.compress(input, CTX)).toBe(input);
  });
});

describe("DSL runtime: match + template", () => {
  test("renders named groups via template", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          match: "^(?<file>\\S+):(?<line>\\d+):(?<text>.+)$",
          template: "{file}:{line}  {text}",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const input = `src/foo.ts:42:hello world
src/bar.ts:17:another match
not a match line here at all
src/baz.ts:99:final hit
`;
    const out = c.compress(input, CTX);
    expect(out).toContain("src/foo.ts:42  hello world");
    expect(out).toContain("src/bar.ts:17  another match");
    expect(out).toContain("src/baz.ts:99  final hit");
    expect(out).not.toContain("not a match line");
  });
});

describe("DSL runtime: group_by", () => {
  test("aggregates records by named group", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          match: "^(?<status>\\S+)\\s+(?<file>.+)$",
          group_by: "status",
          template: "{status}: {n} files",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const input = `modified foo.ts
modified bar.ts
new baz.ts
modified qux.ts
new another.ts
`;
    const out = c.compress(input, CTX);
    expect(out).toContain("modified: 3 files");
    expect(out).toContain("new: 2 files");
  });

  test("joined.<field> shows comma-joined values", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          match: "^(?<status>\\S+)\\s+(?<file>.+)$",
          group_by: "status",
          template: "{status}: {joined.file}",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const out = c.compress(`M a.ts\nM b.ts\nM c.ts\n`, CTX);
    expect(out).toContain("M: a.ts, b.ts, c.ts");
  });
});

describe("DSL runtime: header / footer", () => {
  test("header has {matched} and {total}", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          match: "^(?<file>\\S+)$",
          template: "  {file}",
          header: "{matched}/{total} files matched:",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    // Make file names long enough that compression is a net win
    const out = c.compress(
      `verylongfilenameone\nverylongfilenametwo\nverylongfilenamethree\nbad line with embedded spaces\nverylongfilenamefour\nverylongfilenamefive\n`,
      CTX,
    );
    expect(out.split("\n")[0]).toBe("5/6 files matched:");
    expect(out).toContain("  verylongfilenameone");
  });
});

describe("DSL runtime: truncate", () => {
  test("caps output and shows truncate message", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          truncate: 3,
          truncate_message: "... +{dropped} more",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const out = c.compress(`a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n`, CTX);
    const lines = out.split("\n");
    expect(lines.length).toBe(4); // 3 + truncate message
    expect(lines[3]).toBe("... +7 more");
  });
});

describe("DSL runtime: dedupe", () => {
  test("dedupe=lines collapses adjacent duplicates with count", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          dedupe: "lines",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const input = `same\nsame\nsame\nother\nthird\nthird\nfinal_unique_line\n`;
    const out = c.compress(input, CTX);
    expect(out).toContain("same (x3)");
    expect(out).toContain("third (x2)");
    expect(out).toContain("other");
  });

  test("dedupe=count keeps unique lines only", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          dedupe: "count",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const input = `a\nb\na\nc\nb\na\nlonger_unique_line\n`;
    const out = c.compress(input, CTX);
    // Each line appears at most once
    expect(out.split("\n").filter((l) => l === "a").length).toBe(1);
    expect(out.split("\n").filter((l) => l === "b").length).toBe(1);
  });
});

describe("DSL runtime: safety", () => {
  test("never produces output larger than input", () => {
    // A bad filter that would otherwise blow up size
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          match: "^(?<x>.)$",
          template:
            "PREFIX_VERY_VERY_VERY_VERY_LONG_PREFIX_THAT_BLOWS_UP_SIZE: {x}",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    const input = "a\nb\nc\n";
    const out = c.compress(input, CTX);
    // Should fall back to raw
    expect(out).toBe(input);
  });

  test("doesn't throw on garbage input", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          match: "^(?<x>.+)$",
          group_by: "x",
          template: "{x}: {n}",
          min_input_lines: 1,
        },
        "/tmp/x.toml",
      ),
    );
    // Some adversarial inputs
    expect(c.compress("", CTX)).toBe("");
    expect(c.compress("\x00\x01\x02\n", CTX)).toBeDefined();
    expect(() => c.compress("a".repeat(50_000), CTX)).not.toThrow();
  });

  test("min_input_lines short-circuits", () => {
    const c = compileFilter(
      validateFilterSpec(
        {
          command: "test",
          min_input_lines: 10,
          strip: ["."],
        },
        "/tmp/x.toml",
      ),
    );
    const small = "a\nb\nc\n";
    expect(c.compress(small, CTX)).toBe(small);
  });
});

// ─── Loader ─────────────────────────────────────────────────────────────────

describe("DSL loader", () => {
  test("loads filters from filter directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-dsl-test-"));
    try {
      const filterDir = join(root, ".opencode", "qtk", "filters");
      mkdirSync(filterDir, { recursive: true });
      writeFileSync(
        join(filterDir, "git-short.toml"),
        `command = "git status --short"\nmatch = "^(?<flags>\\\\S+)\\\\s+(?<file>.+)$"\ngroup_by = "flags"\ntemplate = "{flags}: {n} files"\nmin_input_lines = 1\n`,
      );
      writeFileSync(
        join(filterDir, "ls-noop.toml"),
        `command = "ls -la"\nenabled = false\n`,
      );

      const result = await loadFilters(root);
      expect(result.errors.length).toBe(0);
      expect(result.filters.length).toBe(1);
      expect(result.filters[0]!.spec.name).toBe("git-short");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns empty when filter directory doesn't exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-dsl-test-"));
    try {
      const result = await loadFilters(root);
      expect(result.filters.length).toBe(0);
      expect(result.errors.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("isolates errors per-file (one bad file doesn't break others)", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-dsl-test-"));
    try {
      const filterDir = join(root, ".opencode", "qtk", "filters");
      mkdirSync(filterDir, { recursive: true });
      writeFileSync(
        join(filterDir, "good.toml"),
        `command = "ls"\n`,
      );
      writeFileSync(
        join(filterDir, "bad.toml"),
        `command = "ls"\nmatch = "(unclosed regex"\n`,
      );

      const result = await loadFilters(root);
      expect(result.filters.length).toBe(1);
      expect(result.filters[0]!.spec.name).toBe("good");
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.source).toContain("bad.toml");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads in lexicographic order (so 00- prefix runs first)", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-dsl-test-"));
    try {
      const filterDir = join(root, ".opencode", "qtk", "filters");
      mkdirSync(filterDir, { recursive: true });
      writeFileSync(join(filterDir, "zzz.toml"), `command = "z"\n`);
      writeFileSync(join(filterDir, "aaa.toml"), `command = "a"\n`);
      writeFileSync(join(filterDir, "00-first.toml"), `command = "f"\n`);

      const result = await loadFilters(root);
      expect(result.filters.map((f) => f.spec.name)).toEqual([
        "00-first",
        "aaa",
        "zzz",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── End-to-end: realistic kubectl filter ───────────────────────────────────

describe("DSL end-to-end: kubectl get pods", () => {
  test("groups pods by status with full pipeline", () => {
    const spec = validateFilterSpec(
      {
        command: "kubectl get pods",
        strip: ["^NAME\\s+READY"],
        match:
          "^(?<name>\\S+)\\s+(?<ready>\\d+/\\d+)\\s+(?<status>\\S+)\\s+(?<restarts>\\d+)\\s+(?<age>\\S+)$",
        group_by: "status",
        template: "{status}: {n}",
        header: "{matched} pods total",
        min_input_lines: 1,
      },
      "/tmp/kubectl-pods.toml",
    );
    const c = compileFilter(spec);
    const input = `NAME                    READY   STATUS    RESTARTS   AGE
nginx-7d8c9b7f5-abc12   1/1     Running   0          3d
nginx-7d8c9b7f5-def34   1/1     Running   0          3d
nginx-7d8c9b7f5-ghi56   1/1     Running   2          3d
api-server-789abc       1/1     Running   0          12d
worker-failure-xyz      0/1     CrashLoopBackOff 5    1h
worker-pending-uvw      0/1     Pending   0          30s
`;
    const out = c.compress(input, CTX);
    expect(out).toContain("6 pods total");
    expect(out).toContain("Running: 4");
    expect(out).toContain("CrashLoopBackOff: 1");
    expect(out).toContain("Pending: 1");
    expect(out.length).toBeLessThan(input.length);
  });
});
