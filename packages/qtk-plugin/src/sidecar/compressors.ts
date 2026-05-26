// Build TS `Compressor` instances that route through the Rust sidecar.
//
// Each sidecar compressor:
//   - matches() identifies the tool+command it handles
//   - compress() calls the client async, but the Compressor contract is
//     synchronous string-in/string-out. We bridge this by NOT registering
//     the compressors normally; instead the main index.ts uses an
//     async-aware path for sidecar candidates.
//
// We expose this as an *async* compressor interface (`AsyncCompressor`)
// distinct from the sync `Compressor`, so the type system makes the
// boundary explicit and we can't accidentally call .compress() in a
// hot path that expects sync.

import type { SidecarClient } from "./client.ts";

export interface AsyncCompressor {
  readonly name: string;
  readonly category?: string;
  /** Pure pattern match — same contract as sync `Compressor.matches`. */
  matches(tool: string, args: Record<string, unknown>): boolean;
  /** Async compress; must NEVER throw, must NEVER produce > input. */
  compress(raw: string, ctx: { args: Record<string, unknown> }): Promise<string>;
}

interface BuildOpts {
  client: SidecarClient;
}

/** Detect `terraform plan` (and a few common subcommands that produce a plan). */
function matchesTerraformPlan(tool: string, args: Record<string, unknown>): boolean {
  if (tool.toLowerCase() !== "bash") return false;
  const cmd = typeof args.command === "string" ? args.command.trim() : "";
  if (!cmd) return false;
  return /^terraform\s+(plan|apply\s+-auto-approve)/.test(cmd);
}

/** Detect kubectl get -o yaml/json (the volume-producing forms). */
function matchesKubectlGetStructured(
  tool: string,
  args: Record<string, unknown>,
): { matched: boolean; mode: "yaml" | "json" | null } {
  if (tool.toLowerCase() !== "bash") return { matched: false, mode: null };
  const cmd = typeof args.command === "string" ? args.command.trim() : "";
  if (!cmd) return { matched: false, mode: null };
  // kubectl get ... -o yaml | --output yaml | -o=yaml
  const yamlRe = /^kubectl\s+(get|describe)\s+.+\b(-o(?:utput)?[ =]yaml|-oyaml)\b/;
  const jsonRe = /^kubectl\s+(get|describe)\s+.+\b(-o(?:utput)?[ =]json|-ojson)\b/;
  if (yamlRe.test(cmd)) return { matched: true, mode: "yaml" };
  if (jsonRe.test(cmd)) return { matched: true, mode: "json" };
  return { matched: false, mode: null };
}

/** Detect cargo --message-format=json invocations. */
function matchesCargoJson(tool: string, args: Record<string, unknown>): boolean {
  if (tool.toLowerCase() !== "bash") return false;
  const cmd = typeof args.command === "string" ? args.command.trim() : "";
  if (!cmd) return false;
  return /^cargo\s+(build|check|test|clippy|run).*--message-format[ =]json/.test(cmd);
}

/** Detect raw JUnit XML by content sniffing — used when reading a junit file. */
function looksLikeJunit(raw: string): boolean {
  // We sniff in the compress() call rather than matches(), because the
  // command shape varies wildly (`cat junit.xml`, `xmllint junit.xml`, etc).
  // matches() returns true for any `cat ... .xml` or `cat ... junit*`.
  return raw.includes("<testsuite") || raw.includes("<testsuites");
}

function matchesJunitFile(tool: string, args: Record<string, unknown>): boolean {
  if (tool.toLowerCase() !== "bash") return false;
  const cmd = typeof args.command === "string" ? args.command.trim() : "";
  if (!cmd) return false;
  // `cat <something>.xml`, `cat <something>/junit*`, similar
  if (/^cat\s+.+\.(xml|junit)\b/i.test(cmd)) return true;
  if (/^cat\s+.+junit/i.test(cmd)) return true;
  return false;
}

/**
 * Build the set of AsyncCompressors that the main plugin should consult
 * BEFORE the regular sync registry. They use the sidecar; if it's not
 * available they degrade to returning the input unchanged.
 */
export function buildSidecarCompressors({ client }: BuildOpts): AsyncCompressor[] {
  return [
    {
      name: "sidecar:terraform-plan",
      category: "infra",
      matches: matchesTerraformPlan,
      compress: async (raw) => {
        if (raw.length < 200) return raw;
        const res = await client.compress("terraform-plan", raw);
        if (!res || res.output.length >= raw.length) return raw;
        return res.output;
      },
    },
    {
      name: "sidecar:kubectl-structured",
      category: "infra",
      matches: (t, a) => matchesKubectlGetStructured(t, a).matched,
      compress: async (raw, ctx) => {
        if (raw.length < 200) return raw;
        const { mode } = matchesKubectlGetStructured("bash", ctx.args);
        const name = mode === "json" ? "kubectl-json" : "kubectl-yaml";
        const res = await client.compress(name, raw);
        if (!res || res.output.length >= raw.length) return raw;
        return res.output;
      },
    },
    {
      name: "sidecar:cargo-json",
      category: "test-runner",
      matches: matchesCargoJson,
      compress: async (raw) => {
        if (raw.length < 200) return raw;
        const res = await client.compress("cargo-json", raw);
        if (!res || res.output.length >= raw.length) return raw;
        return res.output;
      },
    },
    {
      name: "sidecar:junit-xml",
      category: "test-runner",
      matches: matchesJunitFile,
      compress: async (raw) => {
        if (raw.length < 200) return raw;
        if (!looksLikeJunit(raw)) return raw;
        const res = await client.compress("junit-xml", raw);
        if (!res || res.output.length >= raw.length) return raw;
        return res.output;
      },
    },
  ];
}


