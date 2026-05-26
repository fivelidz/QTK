// SQLite stats tracker. Strictly local — see SECURITY.md §2.
//
// Uses bun:sqlite (built into Bun, zero deps). Writes are best-effort
// fire-and-forget; if the DB is locked or write fails, we log and move on
// rather than blocking the agent loop.

import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { CompressionOutcome } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compressions (
  ts                       INTEGER NOT NULL,
  session_id               TEXT,
  tool                     TEXT NOT NULL,
  command_head             TEXT,
  compressor               TEXT NOT NULL,
  original_bytes           INTEGER NOT NULL,
  compressed_bytes         INTEGER NOT NULL,
  original_tokens_est      INTEGER NOT NULL,
  compressed_tokens_est    INTEGER NOT NULL,
  ratio                    REAL NOT NULL,
  was_cache_hit            INTEGER NOT NULL DEFAULT 0,
  tee_file                 TEXT,
  agent_read_tee           INTEGER NOT NULL DEFAULT 0,
  duration_ms              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session ON compressions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool ON compressions(tool);
CREATE INDEX IF NOT EXISTS idx_ts ON compressions(ts);
`;

export interface StatsRecord {
  readonly sessionID: string;
  readonly tool: string;
  readonly commandHead: string;
  readonly outcome: CompressionOutcome;
}

export class StatsTracker {
  private db: Database | null = null;
  private insertStmt: ReturnType<Database["prepare"]> | null = null;
  private dbPath: string;

  constructor(projectRoot: string, dbRelativePath: string) {
    this.dbPath = resolve(projectRoot, dbRelativePath);
  }

  async init(): Promise<void> {
    try {
      await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
      this.db = new Database(this.dbPath, { create: true });
      // WAL mode for better concurrency (multiple sessions might write).
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec(SCHEMA);
      this.insertStmt = this.db.prepare(`
        INSERT INTO compressions (
          ts, session_id, tool, command_head, compressor,
          original_bytes, compressed_bytes,
          original_tokens_est, compressed_tokens_est,
          ratio, was_cache_hit, tee_file, duration_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
    } catch (e) {
      console.warn(`[qtk] stats: init failed for ${this.dbPath}:`, e);
      this.db = null;
      this.insertStmt = null;
    }
  }

  log(rec: StatsRecord): void {
    if (!this.insertStmt) return;
    try {
      this.insertStmt.run(
        Date.now(),
        rec.sessionID,
        rec.tool,
        rec.commandHead,
        rec.outcome.compressor,
        rec.outcome.originalBytes,
        rec.outcome.compressedBytes,
        rec.outcome.originalTokensEst,
        rec.outcome.compressedTokensEst,
        rec.outcome.ratio,
        rec.outcome.wasCacheHit ? 1 : 0,
        rec.outcome.teeFile,
        rec.outcome.durationMs,
      );
    } catch (e) {
      console.warn(`[qtk] stats: insert failed:`, e);
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* best effort */
    }
    this.db = null;
    this.insertStmt = null;
  }
}

/**
 * Extract the first 3 tokens of a command line for privacy-preserving
 * stats storage. E.g. `git status --short` → `git status --short`,
 * `cargo test --no-run` → `cargo test --no-run`. Args after the third
 * token are dropped to avoid storing file paths or other potentially
 * sensitive data.
 */
export function commandHead(command: string): string {
  return command.trim().split(/\s+/).slice(0, 3).join(" ");
}
