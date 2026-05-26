// Tee fallback writer. On compression, write raw output to disk so the
// agent can recover it via `cat .opencode/qtk-tee/<id>.log` if needed.
//
// Security:
//   - Files written 0o600 EXPLICITLY (don't trust umask — RTK audit §3.1)
//   - Directory created 0o700
//   - Path is constrained to the project root by config loader; we
//     additionally verify here (defence in depth)
//   - Secrets-aware redaction before write (best-effort)

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/g, "<aws-access-key-redacted>"],
  [/ASIA[0-9A-Z]{16}/g, "<aws-temp-key-redacted>"],
  [/ghp_[A-Za-z0-9_]{36,}/g, "<github-token-redacted>"],
  [/github_pat_[A-Za-z0-9_]{82}/g, "<github-pat-redacted>"],
  [/sk-[A-Za-z0-9]{40,}/g, "<openai-key-redacted>"],
  [/xoxb-[0-9]+-[0-9]+-[0-9]+-[a-z0-9]+/g, "<slack-token-redacted>"],
  [
    /(?:Authorization|authorization):\s*Bearer\s+[^\s]+/g,
    "Authorization: Bearer <redacted>",
  ],
];

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface TeeOptions {
  readonly projectRoot: string;
  readonly teeDir: string; // relative to projectRoot, or absolute (must be inside projectRoot)
}

export class TeeWriter {
  private dir: string;

  constructor(opts: TeeOptions) {
    const abs = resolve(opts.projectRoot, opts.teeDir);
    const root = resolve(opts.projectRoot);
    if (!abs.startsWith(root + "/") && abs !== root) {
      throw new Error(
        `tee directory ${abs} is not inside project root ${root}`,
      );
    }
    this.dir = abs;
  }

  /**
   * Write `raw` to `<dir>/<callID>.log` with mode 0o600.
   * Returns the absolute path on success, null on failure.
   * Never throws — failures are logged but don't break the agent loop.
   */
  async write(callID: string, raw: string): Promise<string | null> {
    if (!callID || !/^[A-Za-z0-9_\-]+$/.test(callID)) {
      // Reject ID with path-traversal characters
      console.warn(`[qtk] tee: rejecting invalid callID: ${callID}`);
      return null;
    }

    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const path = `${this.dir}/${callID}.log`;
      const safe = redact(raw);
      // Bun.write supports `mode` option for explicit perms.
      await Bun.write(path, safe, { mode: 0o600 });
      return path;
    } catch (e) {
      console.warn(`[qtk] tee: write failed for ${callID}:`, e);
      return null;
    }
  }

  /**
   * Delete tee files older than `days`. Best-effort; failures are logged.
   * Called once at session start.
   */
  async pruneOlderThan(days: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let pruned = 0;
    try {
      const { readdir, stat, unlink } = await import("node:fs/promises");
      const files = await readdir(this.dir).catch(() => []);
      for (const name of files) {
        if (!name.endsWith(".log")) continue;
        const path = `${this.dir}/${name}`;
        const s = await stat(path).catch(() => null);
        if (!s) continue;
        if (s.mtimeMs < cutoff) {
          await unlink(path).catch(() => {});
          pruned++;
        }
      }
    } catch (e) {
      console.warn(`[qtk] tee: prune failed:`, e);
    }
    return pruned;
  }
}

// Export internals for testing.
export const _internal = { redact, SECRET_PATTERNS };
