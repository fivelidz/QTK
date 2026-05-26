// Periodic export of session savings to a JSON sidecar file.
//
// This file is read by external dashboards (gmux's tmux status bar, the
// gmuxtest Tauri UI, a phone PWA, etc.) so they can show a "QTK saved
// this much" widget without having to query the SQLite DB themselves.
//
// Path: <projectRoot>/.opencode/qtk-savings.json
// Permissions: 0o644 (intentionally readable by group/other — this is
//   intended to be consumed by sibling processes; nothing in it is secret)
// Update frequency: every 10s (debounced); also on plugin shutdown
//
// Schema:
//   {
//     "schema": 1,
//     "ts": 1716700000000,             // epoch ms of this snapshot
//     "project": "/path/to/project",
//     "session_id": "...",
//     "totals": {
//       "calls": 4872,
//       "bytes_in": 5128304,
//       "bytes_out": 1289432,
//       "tokens_saved": 805719,
//       "usd_saved": 4.92,
//       "model": "claude-sonnet-4-5"
//     },
//     "by_compressor": [
//       { "name": "read-tool", "calls": 283, "tokens_saved": 847000 },
//       ...
//     ],
//     "last_compression_ts": 1716699995000
//   }
//
// Errors are best-effort: a write failure logs a warning but doesn't
// break the plugin. The file is rewritten atomically (write to .tmp +
// rename) so external readers never see a half-written file.

import { resolve, dirname } from "node:path";
import { mkdir, rename, writeFile, chmod } from "node:fs/promises";
import type { CompressionOutcome } from "./types.ts";
import { aggregateSavings, type ModelPricing } from "./pricing.ts";

export const SAVINGS_FILE_REL = ".opencode/qtk-savings.json";
export const SAVINGS_SCHEMA_VERSION = 1;

interface PerCompressorRunningTotals {
  calls: number;
  bytesIn: number;
  bytesOut: number;
  tokensIn: number;
  tokensOut: number;
}

export interface SavingsSnapshot {
  schema: number;
  ts: number;
  project: string;
  session_id: string;
  totals: {
    calls: number;
    bytes_in: number;
    bytes_out: number;
    tokens_in: number;
    tokens_out: number;
    tokens_saved: number;
    bytes_saved: number;
    usd_saved: number;
    model: string;
    pricing: ModelPricing;
  };
  by_compressor: Array<{
    name: string;
    calls: number;
    tokens_saved: number;
    bytes_saved: number;
  }>;
  last_compression_ts: number;
}

/**
 * Accumulates session totals in memory, periodically flushes to JSON.
 * One instance per opencode session — caller owns the lifetime.
 */
export class SavingsExporter {
  private readonly absPath: string;
  private readonly projectRoot: string;
  private readonly sessionId: string;

  // Running totals (in-memory, source of truth)
  private calls = 0;
  private bytesIn = 0;
  private bytesOut = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private lastCompressionTs = 0;
  private modelId: string | null = null;
  private readonly perCompressor = new Map<string, PerCompressorRunningTotals>();

  // Debounced flush
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushIntervalMs: number;
  private flushPending = false;
  private stopped = false;

  constructor(
    projectRoot: string,
    sessionId: string,
    flushIntervalMs = 10_000,
  ) {
    this.projectRoot = resolve(projectRoot);
    this.sessionId = sessionId;
    this.absPath = resolve(this.projectRoot, SAVINGS_FILE_REL);
    this.flushIntervalMs = flushIntervalMs;
  }

  /** Set the model id (typically learned later in the session). */
  setModelId(modelId: string | null | undefined): void {
    if (modelId && modelId !== this.modelId) {
      this.modelId = modelId;
      this.scheduleFlush();
    }
  }

  /** Record one compression outcome. Fast in-memory accumulation only. */
  record(outcome: CompressionOutcome): void {
    if (this.stopped) return;
    this.calls += 1;
    this.bytesIn += outcome.originalBytes;
    this.bytesOut += outcome.compressedBytes;
    this.tokensIn += outcome.originalTokensEst;
    this.tokensOut += outcome.compressedTokensEst;
    this.lastCompressionTs = Date.now();

    const entry = this.perCompressor.get(outcome.compressor) ?? {
      calls: 0,
      bytesIn: 0,
      bytesOut: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    entry.calls += 1;
    entry.bytesIn += outcome.originalBytes;
    entry.bytesOut += outcome.compressedBytes;
    entry.tokensIn += outcome.originalTokensEst;
    entry.tokensOut += outcome.compressedTokensEst;
    this.perCompressor.set(outcome.compressor, entry);

    this.scheduleFlush();
  }

  /** Stop the exporter; flushes one last time. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** Force-flush immediately (e.g. for tests). */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** Build the snapshot object (also used by tests). */
  snapshot(): SavingsSnapshot {
    const rows = Array.from(this.perCompressor.values()).map((v) => ({
      originalBytes: v.bytesIn,
      compressedBytes: v.bytesOut,
      originalTokensEst: v.tokensIn,
      compressedTokensEst: v.tokensOut,
    }));
    const agg = aggregateSavings(rows, this.modelId);

    const byCompressor = Array.from(this.perCompressor.entries())
      .map(([name, v]) => ({
        name,
        calls: v.calls,
        tokens_saved: Math.max(0, v.tokensIn - v.tokensOut),
        bytes_saved: Math.max(0, v.bytesIn - v.bytesOut),
      }))
      .sort((a, b) => b.tokens_saved - a.tokens_saved);

    return {
      schema: SAVINGS_SCHEMA_VERSION,
      ts: Date.now(),
      project: this.projectRoot,
      session_id: this.sessionId,
      totals: {
        calls: this.calls,
        bytes_in: this.bytesIn,
        bytes_out: this.bytesOut,
        tokens_in: this.tokensIn,
        tokens_out: this.tokensOut,
        tokens_saved: agg.tokensSaved,
        bytes_saved: agg.bytesSaved,
        usd_saved: Number(agg.usdSaved.toFixed(6)),
        model: this.modelId ?? "default",
        pricing: agg.pricing,
      },
      by_compressor: byCompressor,
      last_compression_ts: this.lastCompressionTs,
    };
  }

  // ─── internals ────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.stopped) return;
    this.flushPending = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    if (!this.flushPending) return;
    this.flushPending = false;
    const snap = this.snapshot();
    try {
      await mkdir(dirname(this.absPath), { recursive: true, mode: 0o700 });
      const tmp = this.absPath + ".tmp";
      await writeFile(tmp, JSON.stringify(snap, null, 2), { mode: 0o644 });
      await rename(tmp, this.absPath);
      // chmod after rename so umask doesn't strip group/other read
      await chmod(this.absPath, 0o644);
    } catch (e) {
      console.warn(`[qtk] savings-export: flush failed: ${(e as Error).message}`);
    }
  }
}
