// Locate the qtk-core binary on the filesystem.
//
// Lookup order (first match wins):
//   1. $QTK_CORE_PATH env var (explicit override; useful for testing)
//   2. <projectRoot>/.opencode/plugin/qtk-core   (bundled with the plugin)
//   3. <pluginRoot>/../qtk-core/target/release/qtk-core (dev checkout layout)
//   4. `qtk-core` on PATH (looked up via which / where)
//
// Returns null if no binary is found — the TS plugin then falls back
// to its pure-TS compressors and the sidecar feature is silently skipped.

import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Find an executable qtk-core binary. Returns the absolute path, or null
 * if not found.
 *
 * @param projectRoot   The opencode project root (passed by the plugin)
 * @param pluginRoot    The plugin's own source root (used for the dev-checkout
 *                      lookup). Defaults to walking up from this file.
 */
export async function locateQtkCore(
  projectRoot: string,
  pluginRoot?: string,
): Promise<string | null> {
  // 1. env var override
  const envPath = process.env.QTK_CORE_PATH;
  if (envPath && existsSync(envPath)) return resolve(envPath);

  // 2. bundled with the plugin in the project's .opencode/plugin/
  const bundled = resolve(projectRoot, ".opencode/plugin/qtk-core");
  if (existsSync(bundled)) return bundled;

  // 3. dev-checkout layout: <QTK>/packages/qtk-core/target/release/qtk-core
  //    pluginRoot is typically <QTK>/packages/qtk-plugin; walk up two levels
  //    then into qtk-core.
  const root = pluginRoot ?? defaultPluginRoot();
  if (root) {
    const dev = resolve(root, "..", "qtk-core", "target", "release", "qtk-core");
    if (existsSync(dev)) return dev;
  }

  // 4. PATH lookup
  const onPath = await findOnPath("qtk-core");
  if (onPath) return onPath;

  return null;
}

function defaultPluginRoot(): string | null {
  // import.meta.dir points at .../qtk-plugin/src/sidecar; go up two to qtk-plugin
  try {
    return resolve(import.meta.dir, "..", "..");
  } catch {
    return null;
  }
}

async function findOnPath(name: string): Promise<string | null> {
  const env = process.env.PATH ?? "";
  for (const dir of env.split(":").filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Suppress unused-import warning if we ever decide to drop dirname.
void dirname;
