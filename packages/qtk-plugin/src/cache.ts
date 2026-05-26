// In-memory session dedup cache. The single most impactful optimisation in
// Phase 1 — catches the "git status → work → git status again" pattern.
//
// Caches the (tool, args) fingerprint with the OUTPUT HASH, not the
// compressed output verbatim. On a hit we know "same call, same output";
// we still need to hand the model something, which is why we also store
// the compressed body alongside.

import { createHash } from "node:crypto";

export interface CacheEntry {
  outputHash: string;
  compressed: string;
  ts: number;
}

const MAX_ENTRIES = 500;
const PRUNE_BATCH = 100;

export class SessionCache {
  private entries = new Map<string, CacheEntry>();

  fingerprint(tool: string, args: Record<string, unknown>): string {
    // Sort keys for stable hashing.
    const canonical = JSON.stringify(args, Object.keys(args).sort());
    return sha256(`${tool}\0${canonical}`);
  }

  outputHash(output: string): string {
    return sha256(output);
  }

  /**
   * Returns a cached entry only if:
   *   1. We have an entry for this fingerprint
   *   2. It's within TTL
   *   3. The current output hash matches the cached one
   *
   * The third check is critical: if the output changed since last time,
   * we must NOT short-circuit. The cache is for output-equal repeats.
   */
  lookup(fp: string, outputHash: string, ttlMs: number): CacheEntry | null {
    const e = this.entries.get(fp);
    if (!e) return null;
    if (Date.now() - e.ts > ttlMs) return null;
    if (e.outputHash !== outputHash) return null;
    return e;
  }

  put(fp: string, outputHash: string, compressed: string) {
    this.entries.set(fp, { outputHash, compressed, ts: Date.now() });
    if (this.entries.size > MAX_ENTRIES) this.prune();
  }

  private prune() {
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].ts - b[1].ts,
    );
    for (let i = 0; i < PRUNE_BATCH && i < sorted.length; i++) {
      this.entries.delete(sorted[i]![0]);
    }
  }

  /** Reset for testing. */
  clear() {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
