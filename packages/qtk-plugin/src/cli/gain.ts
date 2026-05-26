// `qtk gain` — print session-totals analytics from .opencode/qtk-stats.sqlite
//
// Usage:
//   bun packages/qtk-plugin/src/cli/gain.ts [--all|--session=<id>|--days=N] [--model=<id>]
//
// Run from the opencode project root, or pass the project root as an env:
//   QTK_PROJECT_ROOT=/path/to/opencode-project bun packages/qtk-plugin/src/cli/gain.ts
//
// Cost figures use the pricing table in src/pricing.ts. Override the model
// (and thus the rate) with --model=<id>, e.g. --model=claude-sonnet-4-5.

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  lookupPricing,
  estimateUsdSaved,
  formatUsd,
} from "../pricing.ts";

interface CompressionRow {
  ts: number;
  session_id: string;
  tool: string;
  command_head: string;
  compressor: string;
  original_bytes: number;
  compressed_bytes: number;
  original_tokens_est: number;
  compressed_tokens_est: number;
  ratio: number;
  was_cache_hit: number;
  duration_ms: number;
}

interface SummaryRow {
  compressor: string;
  n: number;
  total_in: number;
  total_out: number;
  tokens_saved: number;
  median_ratio: number;
}

function findDb(): string {
  const cwd = process.cwd();
  const candidates = [
    resolve(cwd, ".opencode", "qtk-stats.sqlite"),
    resolve(cwd, "qtk-stats.sqlite"),
  ];
  for (const c of candidates) {
    if (Bun.file(c).size > 0) return c;
  }
  console.error(
    `No QTK stats DB found. Looked at:\n  ${candidates.join("\n  ")}`,
  );
  process.exit(1);
}

function fmt(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function main() {
  const args = process.argv.slice(2);
  const sinceArg = args.find((a) => a.startsWith("--days="));
  const sessionArg = args.find((a) => a.startsWith("--session="));
  const modelArg = args.find((a) => a.startsWith("--model="));
  const isAll = args.includes("--all");

  // Default model: claude-sonnet-4-5 (the "what you'd realistically save"
  // baseline). Override with --model=<id>.
  const modelId = modelArg ? modelArg.slice("--model=".length) : "claude-sonnet-4-5";
  const pricing = lookupPricing(modelId);

  let cutoff: number | null = null;
  if (!isAll) {
    const days = sinceArg
      ? Number.parseInt(sinceArg.slice("--days=".length), 10)
      : 7;
    cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  }

  const db = new Database(findDb(), { readonly: true });

  // ── Totals ──────────────────────────────────────────────────────────────
  let totalsQuery = "SELECT * FROM compressions";
  const where: string[] = [];
  if (cutoff !== null) where.push(`ts > ${cutoff}`);
  if (sessionArg) {
    const sid = sessionArg.slice("--session=".length);
    where.push(`session_id = '${sid.replace(/'/g, "''")}'`);
  }
  if (where.length) totalsQuery += " WHERE " + where.join(" AND ");

  const rows = db.query(totalsQuery).all() as CompressionRow[];
  if (rows.length === 0) {
    console.log("No compressions recorded in the selected window.");
    return;
  }

  const totalIn = rows.reduce((a, r) => a + r.original_bytes, 0);
  const totalOut = rows.reduce((a, r) => a + r.compressed_bytes, 0);
  const totalTokensIn = rows.reduce((a, r) => a + r.original_tokens_est, 0);
  const totalTokensOut = rows.reduce((a, r) => a + r.compressed_tokens_est, 0);
  const cacheHits = rows.filter((r) => r.was_cache_hit === 1).length;
  const distinctSessions = new Set(rows.map((r) => r.session_id)).size;

  const tokensSaved = totalTokensIn - totalTokensOut;
  const usdSaved = estimateUsdSaved(tokensSaved, pricing);

  console.log("─".repeat(64));
  console.log(`QTK savings`);
  console.log("─".repeat(64));
  console.log(
    `Window:           ${isAll ? "all time" : sessionArg ? `session=${sessionArg.slice(10)}` : `last ${(sinceArg ?? "--days=7").slice(7)} days`}`,
  );
  console.log(`Pricing model:    ${modelId}  (input $${pricing.inputUsdPer1M.toFixed(2)}/1M, output $${pricing.outputUsdPer1M.toFixed(2)}/1M)`);
  console.log(`Sessions:         ${distinctSessions}`);
  console.log(`Calls compressed: ${rows.length} (${cacheHits} cache hits)`);
  console.log(
    `Bytes:            ${fmt(totalIn)} → ${fmt(totalOut)} (${pct(1 - totalOut / totalIn)} saved)`,
  );
  console.log(
    `Tokens (est):     ${fmt(totalTokensIn)} → ${fmt(totalTokensOut)} (${fmt(tokensSaved)} saved)`,
  );
  console.log(`Cost saved (est): ${formatUsd(usdSaved)}`);
  console.log("");

  // ── By compressor ────────────────────────────────────────────────────────
  let byCompQuery = `
    SELECT compressor, COUNT(*) as n,
      SUM(original_bytes) as total_in,
      SUM(compressed_bytes) as total_out,
      SUM(original_tokens_est - compressed_tokens_est) as tokens_saved,
      AVG(ratio) as median_ratio
    FROM compressions
  `;
  if (where.length) byCompQuery += " WHERE " + where.join(" AND ");
  byCompQuery += " GROUP BY compressor ORDER BY tokens_saved DESC";
  const byComp = db.query(byCompQuery).all() as SummaryRow[];
  console.log("By compressor:");
  console.log(
    "  name              calls    bytes-in   bytes-out  tok-saved   USD-saved  avg-ratio",
  );
  for (const r of byComp) {
    const usd = estimateUsdSaved(r.tokens_saved, pricing);
    console.log(
      `  ${r.compressor.padEnd(18)} ${String(r.n).padStart(5)}  ${fmt(r.total_in).padStart(10)} ${fmt(r.total_out).padStart(10)}  ${fmt(r.tokens_saved).padStart(9)}   ${formatUsd(usd).padStart(8)}  ${pct(r.median_ratio).padStart(7)}`,
    );
  }
  console.log("");

  // ── Top commands by impact ──────────────────────────────────────────────
  let topQuery = `
    SELECT command_head, COUNT(*) as n,
      SUM(original_tokens_est - compressed_tokens_est) as tokens_saved,
      AVG(ratio) as median_ratio
    FROM compressions
  `;
  if (where.length) topQuery += " WHERE " + where.join(" AND ");
  topQuery += " GROUP BY command_head ORDER BY tokens_saved DESC LIMIT 10";
  const top = db.query(topQuery).all() as {
    command_head: string;
    n: number;
    tokens_saved: number;
    median_ratio: number;
  }[];
  console.log("Top 10 commands by tokens saved:");
  console.log("  command                            calls  tok-saved   USD-saved  avg-ratio");
  for (const r of top) {
    const usd = estimateUsdSaved(r.tokens_saved, pricing);
    console.log(
      `  ${(r.command_head || "(unknown)").padEnd(34)} ${String(r.n).padStart(5)}  ${fmt(r.tokens_saved).padStart(9)}   ${formatUsd(usd).padStart(8)}  ${pct(r.median_ratio).padStart(7)}`,
    );
  }

  // Footer with extrapolated savings hint
  if (rows.length > 0 && !isAll) {
    const days = sinceArg
      ? Number.parseInt(sinceArg.slice("--days=".length), 10)
      : 7;
    const dailyTokens = tokensSaved / days;
    const dailyUsd = usdSaved / days;
    const monthlyUsd = dailyUsd * 30;
    const yearlyUsd = dailyUsd * 365;
    console.log("");
    console.log("─".repeat(64));
    console.log(
      `Extrapolated:     ~${fmt(Math.round(dailyTokens))} tokens/day · ${formatUsd(dailyUsd)}/day`,
    );
    console.log(
      `                  ${formatUsd(monthlyUsd)}/month · ${formatUsd(yearlyUsd)}/year at current rate`,
    );
    console.log(
      "Note: USD figures use list pricing for the chosen model. If you're on",
    );
    console.log(
      "      an enterprise/discounted tier, your actual savings are lower.",
    );
    console.log(
      "      Use --model=<id> to switch model (e.g. --model=gpt-5-codex).",
    );
  }

  db.close();
}

main();
