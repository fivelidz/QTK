// `qtk gain` — print session-totals analytics from .opencode/qtk-stats.sqlite
//
// Usage:
//   bun packages/qtk-plugin/src/cli/gain.ts [--all|--session=<id>|--days=N]
//
// Run from the opencode project root, or pass the project root as an env:
//   QTK_PROJECT_ROOT=/path/to/opencode-project bun packages/qtk-plugin/src/cli/gain.ts

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

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
  const isAll = args.includes("--all");

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

  console.log("─".repeat(60));
  console.log(`QTK savings`);
  console.log("─".repeat(60));
  console.log(
    `Window:           ${isAll ? "all time" : sessionArg ? `session=${sessionArg.slice(10)}` : `last ${(sinceArg ?? "--days=7").slice(7)} days`}`,
  );
  console.log(`Sessions:         ${distinctSessions}`);
  console.log(`Calls compressed: ${rows.length} (${cacheHits} cache hits)`);
  console.log(
    `Bytes:            ${fmt(totalIn)} → ${fmt(totalOut)} (${pct(1 - totalOut / totalIn)} saved)`,
  );
  console.log(
    `Tokens (est):     ${fmt(totalTokensIn)} → ${fmt(totalTokensOut)} (${fmt(totalTokensIn - totalTokensOut)} saved)`,
  );
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
    "  name              calls   bytes-in  bytes-out  saved   avg-ratio",
  );
  for (const r of byComp) {
    console.log(
      `  ${r.compressor.padEnd(18)} ${String(r.n).padStart(5)} ${fmt(r.total_in).padStart(10)} ${fmt(r.total_out).padStart(10)}  ${fmt(r.tokens_saved).padStart(6)}  ${pct(r.median_ratio).padStart(7)}`,
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
  for (const r of top) {
    console.log(
      `  ${(r.command_head || "(unknown)").padEnd(30)} ${String(r.n).padStart(5)} ${fmt(r.tokens_saved).padStart(8)}  ${pct(r.median_ratio).padStart(7)}`,
    );
  }

  db.close();
}

main();
