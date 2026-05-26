// Per-model token pricing table (USD per 1M tokens).
//
// Used to convert QTK's "tokens saved" estimate into a "dollars saved"
// estimate so the savings shows up as a real number for users. Pricing
// numbers are best-effort snapshots from the providers' published pricing
// pages — they're conservative (using the standard/published rates, not
// any discount tier the user might have).
//
// We use the SAME table shape as gmux's MODEL_COST in
// gmuxtest/src/index.html so a future shared library can host this one
// table for both projects.
//
// Sources (as of 2026-05):
//   - Anthropic: anthropic.com/pricing  (Claude Sonnet 4.5/4.6, Opus 4.5)
//   - OpenAI:    openai.com/pricing      (GPT-5.x, o-series)
//   - xAI:       x.ai/api               (Grok 4)
//   - DeepSeek:  api-docs.deepseek.com  (V3, R1)
//   - Local:     $0 for input AND output (the user pays in electricity + VRAM)
//
// If the model isn't in this table, we fall back to the default rate
// (Claude Sonnet 4.5 — a sensible mid-range estimate that errs on the
// side of "the user is saving more than this if anything").

export interface ModelPricing {
  /** USD per 1M input tokens. */
  readonly inputUsdPer1M: number;
  /** USD per 1M output tokens. */
  readonly outputUsdPer1M: number;
  /** Optional discounted cache-read rate (Anthropic cache). */
  readonly cacheReadUsdPer1M?: number;
}

/**
 * Table keyed by canonical model id. Match is case-insensitive and uses
 * `startsWith` so e.g. `"claude-sonnet-4-5-20260101"` matches the
 * `"claude-sonnet-4-5"` row.
 */
const PRICING: Record<string, ModelPricing> = {
  // ─── Anthropic ────────────────────────────────────────────────────────
  "claude-sonnet-4-5": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0, cacheReadUsdPer1M: 0.3 },
  "claude-sonnet-4-6": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0, cacheReadUsdPer1M: 0.3 },
  "claude-sonnet-4-7": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0, cacheReadUsdPer1M: 0.3 },
  "claude-opus-4-5":   { inputUsdPer1M: 15.0, outputUsdPer1M: 75.0, cacheReadUsdPer1M: 1.5 },
  "claude-opus-4-7":   { inputUsdPer1M: 15.0, outputUsdPer1M: 75.0, cacheReadUsdPer1M: 1.5 },
  "claude-haiku-4":    { inputUsdPer1M: 0.8,  outputUsdPer1M: 4.0,  cacheReadUsdPer1M: 0.08 },

  // ─── OpenAI ───────────────────────────────────────────────────────────
  "gpt-5":             { inputUsdPer1M: 5.0,  outputUsdPer1M: 20.0 },
  "gpt-5.1":           { inputUsdPer1M: 5.0,  outputUsdPer1M: 20.0 },
  "gpt-5.2":           { inputUsdPer1M: 5.0,  outputUsdPer1M: 20.0 },
  "gpt-5-codex":       { inputUsdPer1M: 5.0,  outputUsdPer1M: 20.0 },
  "gpt-5.2-codex":     { inputUsdPer1M: 5.0,  outputUsdPer1M: 20.0 },
  "o3":                { inputUsdPer1M: 60.0, outputUsdPer1M: 240.0 },
  "o4-mini":           { inputUsdPer1M: 1.0,  outputUsdPer1M: 4.0 },
  "gpt-4o":            { inputUsdPer1M: 2.5,  outputUsdPer1M: 10.0 },

  // ─── xAI ──────────────────────────────────────────────────────────────
  "grok-4":            { inputUsdPer1M: 5.0,  outputUsdPer1M: 15.0 },
  "grok-4-fast":       { inputUsdPer1M: 0.5,  outputUsdPer1M: 1.5 },

  // ─── DeepSeek ─────────────────────────────────────────────────────────
  "deepseek-v3":       { inputUsdPer1M: 0.27, outputUsdPer1M: 1.10 },
  "deepseek-r1":       { inputUsdPer1M: 0.55, outputUsdPer1M: 2.19 },
  "deepseek-chat":     { inputUsdPer1M: 0.27, outputUsdPer1M: 1.10 },

  // ─── Google ───────────────────────────────────────────────────────────
  "gemini-2.5-pro":    { inputUsdPer1M: 1.25, outputUsdPer1M: 10.0 },
  "gemini-2.5-flash":  { inputUsdPer1M: 0.30, outputUsdPer1M: 2.5 },

  // ─── Local (Ollama, llama.cpp, vLLM) ──────────────────────────────────
  "qwen":              { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "qwen2.5":           { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "qwen3":             { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "llama":             { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "llama3":            { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "llama4":            { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "phi":               { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "phi4":              { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "gemma":             { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "gemma2":            { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "mistral":           { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
  "codestral":         { inputUsdPer1M: 0.0,  outputUsdPer1M: 0.0 },
};

/** Default fallback when the model is unknown. Chosen to be the median
 *  of the cloud frontier models — not too greedy, not too cheap. */
export const DEFAULT_PRICING: ModelPricing = {
  inputUsdPer1M: 3.0,
  outputUsdPer1M: 15.0,
  cacheReadUsdPer1M: 0.3,
};

/**
 * Look up pricing for a model id. Returns `DEFAULT_PRICING` if unknown.
 * Matching is case-insensitive and falls back to longest-prefix match
 * (so `claude-sonnet-4-5-20260101` matches `claude-sonnet-4-5`).
 */
export function lookupPricing(modelId: string | null | undefined): ModelPricing {
  if (!modelId) return DEFAULT_PRICING;
  const id = modelId.toLowerCase();
  // Exact match
  if (id in PRICING) return PRICING[id]!;
  // Longest-prefix match
  let best: { prefix: string; pricing: ModelPricing } | null = null;
  for (const [prefix, pricing] of Object.entries(PRICING)) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, pricing };
    }
  }
  return best?.pricing ?? DEFAULT_PRICING;
}

/**
 * Estimate USD saved given an input-token count that QTK eliminated.
 *
 * QTK saves tokens by replacing verbose tool output (which would have
 * been an INPUT to the model) with a compressed form. So all savings
 * are at the input rate, NOT the output rate.
 *
 * The Anthropic cache-read tier is *not* applied here even though some
 * of these tokens would have been cached — we deliberately use the full
 * input rate because:
 *   (a) the first read of any new tool output isn't cached anyway
 *   (b) cache reads still cost something, and QTK eliminates that cost too
 *   (c) the user almost always wants the optimistic "you saved this much"
 *       framing, and at-input-rate is the right floor.
 */
export function estimateUsdSaved(
  tokensSaved: number,
  pricing: ModelPricing = DEFAULT_PRICING,
): number {
  if (tokensSaved <= 0) return 0;
  return (tokensSaved / 1_000_000) * pricing.inputUsdPer1M;
}

/**
 * Format a USD amount for display. < $1 → cents with 2 decimals; up to
 * $999 → 2 decimals; above → whole dollars.
 */
export function formatUsd(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}¢`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

/**
 * Aggregate savings for a list of compressions. The model id is taken
 * from the first row's metadata if provided; otherwise the default is used.
 */
export interface SavingsAggregate {
  readonly tokensSaved: number;
  readonly bytesSaved: number;
  readonly usdSaved: number;
  readonly modelUsed: string;
  readonly pricing: ModelPricing;
}

export function aggregateSavings(
  rows: Array<{
    originalBytes: number;
    compressedBytes: number;
    originalTokensEst: number;
    compressedTokensEst: number;
  }>,
  modelId?: string | null,
): SavingsAggregate {
  let tokensSaved = 0;
  let bytesSaved = 0;
  for (const r of rows) {
    tokensSaved += Math.max(0, r.originalTokensEst - r.compressedTokensEst);
    bytesSaved += Math.max(0, r.originalBytes - r.compressedBytes);
  }
  const pricing = lookupPricing(modelId);
  return {
    tokensSaved,
    bytesSaved,
    usdSaved: estimateUsdSaved(tokensSaved, pricing),
    modelUsed: modelId ?? "default",
    pricing,
  };
}
