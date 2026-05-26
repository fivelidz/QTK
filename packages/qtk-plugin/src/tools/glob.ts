// `Glob` tool compressor — opencode's Glob returns one path per line.
//
// For pattern matches that return many paths (e.g. `**/*.ts` in a large
// monorepo), we cluster by common directory prefix and show counts.

import type { Compressor } from "../types.ts";

const CLUSTER_THRESHOLD = 30;

export const globToolCompressor: Compressor = {
  name: "tool-glob",
  category: "built-in-tool",

  matches(tool: string): boolean {
    return tool.toLowerCase() === "glob";
  },

  compress(raw: string): string {
    if (!raw) return raw;

    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length < CLUSTER_THRESHOLD) return raw;

    // Group paths by their top 2 directory components.
    // e.g. "packages/opencode/src/foo.ts" → cluster "packages/opencode/"
    // We pick a depth that produces a reasonable number of clusters.
    const byCluster = new Map<string, string[]>();

    // Try depth 2 first, then 3 if depth 2 produces too few clusters.
    const cluster = (path: string, depth: number): string => {
      const parts = path.split("/");
      if (parts.length <= depth) return parts.slice(0, -1).join("/") || ".";
      return parts.slice(0, depth).join("/");
    };

    for (const path of lines) {
      const key = cluster(path, 2);
      const arr = byCluster.get(key) ?? [];
      arr.push(path);
      byCluster.set(key, arr);
    }

    // If too many clusters at depth 2, the result will be just as messy
    // as the raw list. Bail out.
    if (byCluster.size > lines.length * 0.7) return raw;

    const sorted = [...byCluster.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    const out: string[] = [
      `${lines.length} paths in ${byCluster.size} clusters:`,
    ];
    const MAX_CLUSTERS = 15;
    for (const [dir, paths] of sorted.slice(0, MAX_CLUSTERS)) {
      // Get unique extensions in this cluster
      const exts = new Set<string>();
      for (const p of paths) {
        const dot = p.lastIndexOf(".");
        if (dot > 0) exts.add(p.slice(dot));
      }
      const extLabel =
        exts.size > 0
          ? ` [${[...exts].slice(0, 3).join(", ")}${exts.size > 3 ? ", ..." : ""}]`
          : "";

      out.push(`  ${dir}/  (${paths.length}${extLabel})`);
      // Show first 2 paths from each cluster as samples
      for (const p of paths.slice(0, 2)) {
        out.push(`    ${p}`);
      }
      if (paths.length > 2) {
        out.push(`    ... +${paths.length - 2} more`);
      }
    }
    if (sorted.length > MAX_CLUSTERS) {
      const remaining = sorted.length - MAX_CLUSTERS;
      const remPaths = sorted
        .slice(MAX_CLUSTERS)
        .reduce((a, b) => a + b[1].length, 0);
      out.push(`  ... and ${remaining} more clusters (${remPaths} paths)`);
    }

    const result = out.join("\n");
    if (result.length >= raw.length) return raw;
    return result;
  },
};
