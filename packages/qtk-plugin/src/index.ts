// QTK — Qalarc Token Killer (also a backronym for "Quantised Token Killer").
//
// Output-side token compression for opencode (and compatible fork) tool calls.
//
// Built downstream of RTK (Rust Token Killer; rtk-ai/rtk) — see
// docs/RTK-COMPARISON.md for the design diff. RTK proved the thesis at
// scale and ships the upstream filter corpus QTK imports from.
//
// Hooks into `tool.execute.after` and rewrites `result.output` in place.
// Read docs/ for the full design.

import type { Plugin } from "@opencode-ai/plugin";
import { resolve } from "node:path";
import { CompressorRegistry } from "./registry.ts";
import { SessionCache } from "./cache.ts";
import { TeeWriter } from "./tee.ts";
import { StatsTracker, commandHead } from "./stats.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { loadConfig } from "./config.ts";
import { estimateTokens } from "./estimator.ts";
import { loadFilters, DEFAULT_FILTER_DIR } from "./dsl/loader.ts";
import { watchFilters } from "./dsl/watcher.ts";
import { SidecarClient } from "./sidecar/client.ts";
import { locateQtkCore } from "./sidecar/locator.ts";
import {
  buildSidecarCompressors,
  type AsyncCompressor,
} from "./sidecar/compressors.ts";
import { SavingsExporter } from "./savings-export.ts";
import type { CompressionOutcome } from "./types.ts";

export const QtkPlugin: Plugin = async ({ directory }) => {
  const projectRoot = directory ?? process.cwd();
  const config = await loadConfig(projectRoot);

  if (!config.enabled) {
    console.log("[qtk] disabled via .opencode/qtk.toml");
    return {};
  }

  const registry = new CompressorRegistry();
  const cache = new SessionCache();
  const breaker = new CircuitBreaker();

  // Load TOML DSL filters from .opencode/qtk/filters/*.toml — these run
  // BEFORE built-in compressors (first-match wins) so users can override.
  try {
    const { filters, errors } = await loadFilters(projectRoot);
    if (filters.length > 0) {
      registry.prepend(filters.map((f) => f.compressor));
      console.log(
        `[qtk] loaded ${filters.length} DSL filter(s): ${filters
          .map((f) => f.spec.name)
          .join(", ")}`,
      );
    }
    for (const e of errors) {
      console.warn(`[qtk] filter load failed: ${e.source}: ${e.error}`);
    }

    // Hot-reload watcher — picks up new/edited/deleted filter files
    // without a restart. Best-effort: a failed watcher just means no
    // hot-reload; the loaded-at-startup set keeps working.
    watchFilters(projectRoot, DEFAULT_FILTER_DIR, (result) => {
      registry.replaceUserCompressors(result.filters.map((f) => f.compressor));
      console.log(
        `[qtk] hot-reload: ${result.filters.length} DSL filter(s) active`,
      );
      for (const e of result.errors) {
        console.warn(`[qtk] filter load failed: ${e.source}: ${e.error}`);
      }
    });
  } catch (e) {
    console.warn("[qtk] filter loader failed:", e);
  }

  let tee: TeeWriter | null = null;
  if (config.tee.enabled) {
    try {
      tee = new TeeWriter({ projectRoot, teeDir: config.tee.directory });
      // Prune old tee files from prior sessions (best-effort)
      tee.pruneOlderThan(config.tee.pruneDays).then((n) => {
        if (n > 0) console.log(`[qtk] pruned ${n} stale tee files`);
      });
    } catch (e) {
      console.warn("[qtk] tee disabled:", e);
    }
  }

  let stats: StatsTracker | null = null;
  if (config.stats.enabled) {
    stats = new StatsTracker(projectRoot, config.stats.database);
    await stats.init();
  }

  // ─── Savings exporter (cross-tool integration: gmux, dashboards) ─────────
  // Writes <project>/.opencode/qtk-savings.json every 10s (debounced).
  // External consumers (gmux status bar, gmuxtest Tauri UI, phone PWA)
  // read this file to display "QTK saved X tokens ($Y)".
  //
  // Sessions get their id from the first tool.execute.after call's
  // `input.sessionID`. Until that arrives we use a placeholder.
  const savingsExporter = new SavingsExporter(projectRoot, "unknown");

  // ─── Sidecar (Phase 3) — optional Rust binary for heavy parsers ─────────
  let sidecarCompressors: AsyncCompressor[] = [];
  try {
    const binPath = await locateQtkCore(projectRoot);
    if (binPath) {
      const client = new SidecarClient({ binaryPath: binPath });
      // Lazy-start: don't block plugin init waiting for the binary.
      // The first compress() call will await readiness.
      client.start().then(
        () => console.log(`[qtk] sidecar ready (${binPath})`),
        (e) =>
          console.warn(
            `[qtk] sidecar startup failed (${binPath}): ${(e as Error).message}; using TS-only`,
          ),
      );
      sidecarCompressors = buildSidecarCompressors({ client });
      console.log(
        `[qtk] sidecar enabled — ${sidecarCompressors.length} compressors via qtk-core`,
      );
    } else {
      console.log("[qtk] sidecar: qtk-core binary not found; using TS-only");
    }
  } catch (e) {
    console.warn("[qtk] sidecar setup failed:", e);
  }

  console.log(`[qtk] active — ${registry.size()} compressors registered`);
  console.log(`[qtk] compressors: ${registry.names().join(", ")}`);

  // Best-effort: flush the savings file when the process is about to exit.
  // Bun/Node `beforeExit` is the latest hook that's still inside an async
  // context, so we can await the rename.
  process.on?.("beforeExit", () => {
    void savingsExporter.stop();
  });

  return {
    "tool.execute.after": async (input, output) => {
      // Defensive: never throw out of this hook.
      try {
        await processCall(input, output, {
          projectRoot,
          registry,
          sidecarCompressors,
          cache,
          breaker,
          tee,
          stats,
          savingsExporter,
          dedupTtlMs: config.dedupTtlSeconds * 1000,
          teeMode: config.tee.mode,
        });
      } catch (e) {
        console.warn("[qtk] hook failed (output unchanged):", e);
      }
    },
  };
};

interface ProcessContext {
  projectRoot: string;
  registry: CompressorRegistry;
  sidecarCompressors: readonly AsyncCompressor[];
  cache: SessionCache;
  breaker: CircuitBreaker;
  tee: TeeWriter | null;
  stats: StatsTracker | null;
  savingsExporter: SavingsExporter;
  dedupTtlMs: number;
  teeMode: "always" | "failures_and_compressed" | "never";
}

interface HookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface HookOutput {
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

async function processCall(
  input: HookInput,
  output: HookOutput,
  ctx: ProcessContext,
): Promise<void> {
  if (typeof output.output !== "string" || !output.output) return;
  const raw = output.output;
  if (raw.length < 200) return; // small outputs not worth compressing

  // Pull `args` from metadata if present, otherwise empty
  const args = (output.metadata?.args as Record<string, unknown>) ?? {};

  // Compute fingerprint and output hash
  const fp = ctx.cache.fingerprint(input.tool, args);
  const outHash = ctx.cache.outputHash(raw);

  // Learn the session id from the first hook call (used by the savings exporter)
  // Best-effort — if input.sessionID isn't set, we just skip.
  if (input.sessionID) {
    ctx.savingsExporter.setModelId(extractModelId(output));
  }

  // Cache lookup — same call, same output, within TTL?
  const cacheHit = ctx.cache.lookup(fp, outHash, ctx.dedupTtlMs);
  if (cacheHit) {
    const elapsed = Math.round((Date.now() - cacheHit.ts) / 1000);
    output.output = `<qtk-unchanged tool=${input.tool} since=${elapsed}s_ago>\n${cacheHit.compressed}\n</qtk-unchanged>`;
    const cacheOutcome: CompressionOutcome = {
      compressor: "session-cache",
      originalBytes: raw.length,
      compressedBytes: output.output.length,
      originalTokensEst: estimateTokens(raw),
      compressedTokensEst: estimateTokens(output.output),
      ratio: output.output.length / raw.length,
      durationMs: 0,
      wasCacheHit: true,
      teeFile: null,
    };
    if (ctx.stats) {
      ctx.stats.log({
        sessionID: input.sessionID,
        tool: input.tool,
        commandHead: extractCommandHead(input.tool, args),
        outcome: cacheOutcome,
      });
    }
    ctx.savingsExporter.record(cacheOutcome);
    return;
  }

  // First chance: sidecar (async) compressors. These handle heavy parsers
  // (terraform plan, kubectl YAML/JSON, cargo --message-format=json, JUnit XML).
  // If a sidecar compressor matches but the Rust process isn't ready or
  // returns nothing, it returns `raw` unchanged and we fall through to the
  // regular sync registry.
  let compressed: string | null = null;
  let compressorName = "";
  let durationMs = 0;
  for (const sc of ctx.sidecarCompressors) {
    if (!sc.matches(input.tool, args)) continue;
    if (ctx.breaker.isDisabled(sc.name)) break;
    const t0 = performance.now();
    let candidate: string;
    try {
      candidate = await sc.compress(raw, { args });
    } catch (e) {
      const newlyDisabled = ctx.breaker.recordFailure(sc.name);
      if (newlyDisabled) {
        console.warn(
          `[qtk] disabling sidecar compressor '${sc.name}' after 3 failures`,
        );
      }
      break;
    }
    durationMs = Math.round(performance.now() - t0);
    if (candidate !== raw && candidate.length < raw.length) {
      compressed = candidate;
      compressorName = sc.name;
    }
    break; // first matching sidecar wins (matches sync registry semantics)
  }

  // Fall through to sync registry if sidecar didn't compress
  if (compressed === null) {
    const compressor = ctx.registry.lookup(input.tool, args);
    if (!compressor) {
      // No compressor matched. Still cache (raw stays as-is) so we catch
      // identical repeats next time.
      ctx.cache.put(fp, outHash, raw);
      return;
    }
    if (ctx.breaker.isDisabled(compressor.name)) {
      return; // circuit-broken: pass through
    }

    const t0 = performance.now();
    let candidate: string;
    try {
      candidate = compressor.compress(raw, {
        args,
        cwd: ctx.projectRoot,
        config: {},
      });
    } catch (e) {
      const newlyDisabled = ctx.breaker.recordFailure(compressor.name);
      if (newlyDisabled) {
        console.warn(
          `[qtk] disabling compressor '${compressor.name}' after 3 failures`,
        );
      }
      return; // output unchanged
    }
    durationMs = Math.round(performance.now() - t0);
    compressed = candidate;
    compressorName = compressor.name;
  }

  // Safety: compressor must produce ≤ input length
  if (compressed.length > raw.length) {
    console.warn(
      `[qtk] compressor '${compressorName}' produced larger output, ignoring`,
    );
    return;
  }
  // No actual compression
  if (compressed === raw) return;

  const ratio = compressed.length / raw.length;

  // Decide whether to tee
  let teeFile: string | null = null;
  const shouldTee =
    (ctx.tee && ctx.teeMode === "always") ||
    (ctx.teeMode === "failures_and_compressed" && ratio < 0.7);
  if (shouldTee && ctx.tee) {
    teeFile = await ctx.tee.write(input.callID, raw);
  }

  // Wrap compressed output in an envelope so the model can find the tee if needed
  const origLines = raw.split("\n").length;
  const envelopeOpen =
    `<qtk-compressed compressor=${compressorName} orig_lines=${origLines} ratio=${ratio.toFixed(2)}` +
    (teeFile ? ` tee=${pathToRelative(teeFile, ctx.projectRoot)}` : "") +
    `>`;

  output.output = `${envelopeOpen}\n${compressed}\n</qtk-compressed>`;

  // Cache the (raw) hash + the compressed body, so repeats short-circuit
  ctx.cache.put(fp, outHash, compressed);

  // Log to stats + savings export (always — exporter is required)
  const outcome: CompressionOutcome = {
    compressor: compressorName,
    originalBytes: raw.length,
    compressedBytes: output.output.length,
    originalTokensEst: estimateTokens(raw),
    compressedTokensEst: estimateTokens(output.output),
    ratio,
    durationMs,
    wasCacheHit: false,
    teeFile,
  };
  if (ctx.stats) {
    ctx.stats.log({
      sessionID: input.sessionID,
      tool: input.tool,
      commandHead: extractCommandHead(input.tool, args),
      outcome,
    });
  }
  ctx.savingsExporter.record(outcome);
}

function extractCommandHead(
  tool: string,
  args: Record<string, unknown>,
): string {
  if (tool.toLowerCase() === "bash" && typeof args.command === "string") {
    return commandHead(args.command);
  }
  return tool.toLowerCase();
}

/**
 * Try to read the model id from opencode's tool-call output metadata.
 * opencode plugins receive an `output.metadata` field which sometimes
 * contains `model` (and adjacent fields). If we can't find it, returns
 * null — the savings exporter will use its default pricing.
 */
function extractModelId(output: HookOutput): string | null {
  const meta = output.metadata;
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const key of ["model", "modelID", "model_id", "modelId"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function pathToRelative(abs: string, root: string): string {
  const r = resolve(root);
  if (abs.startsWith(r + "/")) return abs.slice(r.length + 1);
  return abs;
}

// Default export for opencode plugin loader convention
export default QtkPlugin;
