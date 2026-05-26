// Tests for the pricing module + savings exporter.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lookupPricing,
  estimateUsdSaved,
  formatUsd,
  aggregateSavings,
  DEFAULT_PRICING,
} from "../src/pricing.ts";
import {
  SavingsExporter,
  SAVINGS_FILE_REL,
  type SavingsSnapshot,
} from "../src/savings-export.ts";

describe("pricing — lookupPricing", () => {
  test("exact match on a known model", () => {
    const p = lookupPricing("claude-sonnet-4-5");
    expect(p.inputUsdPer1M).toBe(3.0);
    expect(p.outputUsdPer1M).toBe(15.0);
  });

  test("case-insensitive match", () => {
    const p = lookupPricing("CLAUDE-SONNET-4-5");
    expect(p.inputUsdPer1M).toBe(3.0);
  });

  test("longest-prefix match (versioned model ids)", () => {
    const p = lookupPricing("claude-sonnet-4-5-20260101");
    expect(p.inputUsdPer1M).toBe(3.0);
  });

  test("opus has higher rates than sonnet", () => {
    expect(lookupPricing("claude-opus-4-5").inputUsdPer1M).toBeGreaterThan(
      lookupPricing("claude-sonnet-4-5").inputUsdPer1M,
    );
  });

  test("local models are zero-cost", () => {
    expect(lookupPricing("qwen2.5-coder").inputUsdPer1M).toBe(0);
    expect(lookupPricing("llama4-70b").outputUsdPer1M).toBe(0);
  });

  test("unknown model falls back to default", () => {
    const p = lookupPricing("some-unknown-model-xyz");
    expect(p).toEqual(DEFAULT_PRICING);
  });

  test("null / undefined / empty model id falls back to default", () => {
    expect(lookupPricing(null)).toEqual(DEFAULT_PRICING);
    expect(lookupPricing(undefined)).toEqual(DEFAULT_PRICING);
    expect(lookupPricing("")).toEqual(DEFAULT_PRICING);
  });
});

describe("pricing — estimateUsdSaved", () => {
  test("1M input tokens saved on Sonnet = $3", () => {
    const p = lookupPricing("claude-sonnet-4-5");
    expect(estimateUsdSaved(1_000_000, p)).toBeCloseTo(3.0, 5);
  });

  test("500k input tokens saved on Opus = $7.50", () => {
    const p = lookupPricing("claude-opus-4-5");
    expect(estimateUsdSaved(500_000, p)).toBeCloseTo(7.5, 5);
  });

  test("negative / zero token saves return 0", () => {
    expect(estimateUsdSaved(0)).toBe(0);
    expect(estimateUsdSaved(-100)).toBe(0);
  });

  test("local models save $0 regardless of token count", () => {
    expect(estimateUsdSaved(10_000_000, lookupPricing("qwen3"))).toBe(0);
  });
});

describe("pricing — formatUsd", () => {
  test("sub-cent formatting", () => {
    expect(formatUsd(0.0001)).toMatch(/¢/);
  });
  test("dollar formatting", () => {
    expect(formatUsd(4.92)).toBe("$4.92");
    expect(formatUsd(0.34)).toBe("$0.34");
  });
  test("large numbers", () => {
    expect(formatUsd(12345)).toMatch(/\$12,345/);
  });
});

describe("pricing — aggregateSavings", () => {
  test("sums tokens + bytes + USD across rows", () => {
    const rows = [
      {
        originalBytes: 1000,
        compressedBytes: 200,
        originalTokensEst: 250,
        compressedTokensEst: 50,
      },
      {
        originalBytes: 4000,
        compressedBytes: 800,
        originalTokensEst: 1000,
        compressedTokensEst: 200,
      },
    ];
    const agg = aggregateSavings(rows, "claude-sonnet-4-5");
    expect(agg.tokensSaved).toBe(1000); // (250-50) + (1000-200)
    expect(agg.bytesSaved).toBe(4000); // (1000-200) + (4000-800)
    expect(agg.usdSaved).toBeCloseTo(0.003, 5); // 1k / 1M * $3
    expect(agg.modelUsed).toBe("claude-sonnet-4-5");
  });

  test("handles empty input gracefully", () => {
    const agg = aggregateSavings([], "claude-sonnet-4-5");
    expect(agg.tokensSaved).toBe(0);
    expect(agg.usdSaved).toBe(0);
  });

  test("uses default pricing when model is null", () => {
    const agg = aggregateSavings(
      [{ originalBytes: 100, compressedBytes: 20, originalTokensEst: 25, compressedTokensEst: 5 }],
      null,
    );
    expect(agg.pricing).toEqual(DEFAULT_PRICING);
  });
});

describe("savings-export — SavingsExporter", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "qtk-savings-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test("records compressions and accumulates totals", () => {
    const exp = new SavingsExporter(tmpRoot, "test-session", 1_000_000);
    exp.record({
      compressor: "git-status",
      originalBytes: 1000,
      compressedBytes: 200,
      originalTokensEst: 250,
      compressedTokensEst: 50,
      ratio: 0.2,
      durationMs: 1,
      wasCacheHit: false,
      teeFile: null,
    });
    exp.record({
      compressor: "git-status",
      originalBytes: 800,
      compressedBytes: 150,
      originalTokensEst: 200,
      compressedTokensEst: 35,
      ratio: 0.19,
      durationMs: 1,
      wasCacheHit: false,
      teeFile: null,
    });
    const snap = exp.snapshot();
    expect(snap.totals.calls).toBe(2);
    expect(snap.totals.bytes_in).toBe(1800);
    expect(snap.totals.bytes_out).toBe(350);
    expect(snap.totals.tokens_saved).toBe(365);
    expect(snap.by_compressor[0]!.name).toBe("git-status");
    expect(snap.by_compressor[0]!.calls).toBe(2);
  });

  test("ranks compressors by tokens saved", () => {
    const exp = new SavingsExporter(tmpRoot, "test-session", 1_000_000);
    exp.record({
      compressor: "small-saver",
      originalBytes: 100,
      compressedBytes: 80,
      originalTokensEst: 25,
      compressedTokensEst: 20,
      ratio: 0.8,
      durationMs: 1,
      wasCacheHit: false,
      teeFile: null,
    });
    exp.record({
      compressor: "big-saver",
      originalBytes: 10000,
      compressedBytes: 200,
      originalTokensEst: 2500,
      compressedTokensEst: 50,
      ratio: 0.02,
      durationMs: 1,
      wasCacheHit: false,
      teeFile: null,
    });
    const snap = exp.snapshot();
    expect(snap.by_compressor[0]!.name).toBe("big-saver");
    expect(snap.by_compressor[1]!.name).toBe("small-saver");
  });

  test("flushNow writes the JSON file atomically with 0o644", async () => {
    const exp = new SavingsExporter(tmpRoot, "test-session-xyz", 1_000_000);
    exp.setModelId("claude-sonnet-4-5");
    exp.record({
      compressor: "rg",
      originalBytes: 5000,
      compressedBytes: 800,
      originalTokensEst: 1250,
      compressedTokensEst: 200,
      ratio: 0.16,
      durationMs: 2,
      wasCacheHit: false,
      teeFile: null,
    });
    await exp.flushNow();

    const path = join(tmpRoot, SAVINGS_FILE_REL);
    expect(existsSync(path)).toBe(true);

    const stat = statSync(path);
    // Mode check: lower 9 bits should be 0o644
    expect(stat.mode & 0o777).toBe(0o644);

    const snap = JSON.parse(readFileSync(path, "utf-8")) as SavingsSnapshot;
    expect(snap.schema).toBe(1);
    expect(snap.session_id).toBe("test-session-xyz");
    expect(snap.totals.tokens_saved).toBe(1050);
    expect(snap.totals.model).toBe("claude-sonnet-4-5");
    expect(snap.totals.usd_saved).toBeGreaterThan(0);
    expect(snap.totals.pricing.inputUsdPer1M).toBe(3.0);
    expect(snap.by_compressor[0]!.name).toBe("rg");
  });

  test("stop() flushes any pending writes", async () => {
    const exp = new SavingsExporter(tmpRoot, "test-stop", 1_000_000);
    exp.record({
      compressor: "ls",
      originalBytes: 200,
      compressedBytes: 100,
      originalTokensEst: 50,
      compressedTokensEst: 25,
      ratio: 0.5,
      durationMs: 1,
      wasCacheHit: false,
      teeFile: null,
    });
    await exp.stop();
    const path = join(tmpRoot, SAVINGS_FILE_REL);
    expect(existsSync(path)).toBe(true);
  });

  test("after stop(), record() is a no-op", async () => {
    const exp = new SavingsExporter(tmpRoot, "test-noop", 1_000_000);
    await exp.stop();
    exp.record({
      compressor: "x",
      originalBytes: 100,
      compressedBytes: 50,
      originalTokensEst: 25,
      compressedTokensEst: 12,
      ratio: 0.5,
      durationMs: 1,
      wasCacheHit: false,
      teeFile: null,
    });
    const snap = exp.snapshot();
    expect(snap.totals.calls).toBe(0);
  });

  test("setModelId triggers a flush so UI sees the model fast", async () => {
    const exp = new SavingsExporter(tmpRoot, "test-model", 50);
    exp.record({
      compressor: "x",
      originalBytes: 100,
      compressedBytes: 20,
      originalTokensEst: 25,
      compressedTokensEst: 5,
      ratio: 0.2,
      durationMs: 1,
      wasCacheHit: false,
      teeFile: null,
    });
    exp.setModelId("claude-opus-4-5");
    await exp.flushNow();
    const path = join(tmpRoot, SAVINGS_FILE_REL);
    const snap = JSON.parse(readFileSync(path, "utf-8")) as SavingsSnapshot;
    expect(snap.totals.model).toBe("claude-opus-4-5");
    expect(snap.totals.pricing.inputUsdPer1M).toBe(15.0);
  });
});
