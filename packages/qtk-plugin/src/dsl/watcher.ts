// Hot-reload watcher for `.opencode/qtk/filters/*.toml`.
//
// Uses node:fs/watch via the polyfilled bun shim. Debounced so a burst of
// editor saves (foo.toml.swp, foo.toml~, foo.toml) only triggers one reload.
//
// The watcher itself never throws — failures degrade gracefully to "no
// hot-reload" and the loaded-at-startup filter set keeps working.

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { loadFilters, type LoadResult } from "./loader.ts";
import { existsSync, mkdirSync } from "node:fs";

const DEBOUNCE_MS = 250;

export interface FilterWatcher {
  /** Stop watching (close fs watcher, cancel pending debounce). */
  stop(): void;
}

/**
 * Start watching the filter directory. On any change (add/remove/edit),
 * re-load all filters and pass them to `onReload`.
 *
 * Creates the filter directory lazily if missing — that way a user dropping
 * `.opencode/qtk/filters/foo.toml` later in the session still triggers a
 * load even if the dir didn't exist at startup.
 */
export function watchFilters(
  projectRoot: string,
  filterDir: string,
  onReload: (result: LoadResult) => void,
): FilterWatcher {
  const dir = resolve(projectRoot, filterDir);

  // Ensure dir exists so fs.watch has something to watch. Best-effort —
  // failure here just means we don't get hot-reload, which isn't critical.
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return { stop: () => {} };
    }
  }

  let pending: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const trigger = () => {
    if (stopped) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      try {
        const result = await loadFilters(projectRoot, filterDir);
        if (!stopped) onReload(result);
      } catch (e) {
        console.warn("[qtk] filter reload failed:", e);
      }
    }, DEBOUNCE_MS);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
      // Ignore swap/temp files commonly created by editors
      if (filename && /(~|\.swp|\.swx|\.tmp)$/.test(filename)) return;
      // Only react to .toml file events
      if (filename && !filename.endsWith(".toml")) return;
      trigger();
    });
    watcher.on("error", (e) => {
      console.warn("[qtk] filter watcher error:", e);
    });
  } catch (e) {
    console.warn("[qtk] filter watcher disabled:", e);
    return { stop: () => {} };
  }

  return {
    stop: () => {
      stopped = true;
      if (pending) clearTimeout(pending);
      pending = null;
      try {
        watcher?.close();
      } catch {
        // ignore
      }
    },
  };
}
