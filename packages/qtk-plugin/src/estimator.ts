// Token count estimation. Matches opencode's own heuristic from
// packages/opencode/src/util/token.ts — chars / 4. Imprecise but consistent
// with how opencode itself estimates token costs.

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
