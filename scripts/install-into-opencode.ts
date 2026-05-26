// scripts/install-into-opencode.ts
//
// Wires QTK into an opencode project (or any opencode-compatible fork) by:
//   1. Symlinking packages/qtk-plugin into <project>/.opencode/plugin/qtk
//   2. Registering the plugin path in <project>/.opencode/opencode.jsonc
//
// Usage:
//   bun run scripts/install-into-opencode.ts /path/to/opencode-project
//   bun run scripts/install-into-opencode.ts /path/to/opencode-project --uninstall
//
// Backwards-compatibility: the previous filename `install-into-qalcode2.ts`
// is kept as a thin shim that delegates here.

import { resolve } from "node:path";
import { symlink, readlink, unlink, stat } from "node:fs/promises";

const QTK_ROOT = resolve(import.meta.dir, "..");
const PLUGIN_SRC = resolve(QTK_ROOT, "packages/qtk-plugin");

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const targetArg = args.find((a) => !a.startsWith("--"));

if (!targetArg) {
  console.error(
    "usage: bun run scripts/install-into-opencode.ts <opencode-project-root> [--uninstall]\n" +
      "       <opencode-project-root> is the directory containing the `.opencode/` folder",
  );
  process.exit(2);
}
const target = resolve(targetArg);

const linkPath = resolve(target, ".opencode/plugin/qtk");
const jsoncPath = resolve(target, ".opencode/opencode.jsonc");
const pluginRefInJsonc = "file://.opencode/plugin/qtk/src/index.ts";

async function ensureSymlink() {
  try {
    const existing = await readlink(linkPath);
    if (existing === PLUGIN_SRC) {
      console.log(`✓ symlink already correct: ${linkPath} → ${PLUGIN_SRC}`);
      return;
    }
    console.log(`⚠ removing existing symlink (was: ${existing})`);
    await unlink(linkPath);
  } catch {
    // doesn't exist
  }

  const s = await stat(linkPath).catch(() => null);
  if (s) {
    console.error(
      `✗ ${linkPath} exists but is not a symlink. Refusing to overwrite. Move or delete it manually.`,
    );
    process.exit(1);
  }

  await symlink(PLUGIN_SRC, linkPath, "dir");
  console.log(`✓ created symlink: ${linkPath} → ${PLUGIN_SRC}`);
}

async function removeSymlink() {
  try {
    const existing = await readlink(linkPath);
    if (existing === PLUGIN_SRC) {
      await unlink(linkPath);
      console.log(`✓ removed symlink: ${linkPath}`);
      return;
    }
    console.log(
      `⚠ ${linkPath} is a symlink but not pointing to QTK; leaving alone`,
    );
  } catch {
    console.log(`(no symlink at ${linkPath})`);
  }
}

async function ensurePluginInJsonc() {
  const file = Bun.file(jsoncPath);
  if (!(await file.exists())) {
    console.error(`✗ ${jsoncPath} does not exist`);
    process.exit(1);
  }
  const text = await file.text();

  if (text.includes(pluginRefInJsonc)) {
    console.log(`✓ plugin already registered in opencode.jsonc`);
    return;
  }

  // Find the "plugin": [...] array and add our entry. We do a minimal regex
  // edit — JSONC parsing is too much for one shell call.
  const pattern = /("plugin"\s*:\s*\[)([\s\S]*?)(\n\s*\])/;
  const match = pattern.exec(text);
  if (!match) {
    console.error(`✗ could not locate "plugin": [...] array in opencode.jsonc`);
    process.exit(1);
  }
  const replaced = text.replace(pattern, `$1$2,\n    "${pluginRefInJsonc}"$3`);
  await Bun.write(`${jsoncPath}.bak-qtk`, text);
  await Bun.write(jsoncPath, replaced);
  console.log(
    `✓ added "${pluginRefInJsonc}" to opencode.jsonc (backup at .bak-qtk)`,
  );
}

async function removePluginFromJsonc() {
  const file = Bun.file(jsoncPath);
  if (!(await file.exists())) return;
  const text = await file.text();
  if (!text.includes(pluginRefInJsonc)) {
    console.log(`(plugin not in opencode.jsonc)`);
    return;
  }
  const removed = text
    .split("\n")
    .filter((line) => !line.includes(pluginRefInJsonc))
    .join("\n")
    .replace(/,(\s*\])/g, "$1");
  await Bun.write(`${jsoncPath}.bak-qtk-uninstall`, text);
  await Bun.write(jsoncPath, removed);
  console.log(
    `✓ removed plugin reference from opencode.jsonc (backup at .bak-qtk-uninstall)`,
  );
}

async function main() {
  console.log(`QTK install/uninstall`);
  console.log(`  QTK root:         ${QTK_ROOT}`);
  console.log(`  Plugin source:    ${PLUGIN_SRC}`);
  console.log(`  opencode target:  ${target}`);
  console.log(`  Symlink path:     ${linkPath}`);
  console.log(`  Config file:      ${jsoncPath}`);
  console.log("");

  if (uninstall) {
    await removeSymlink();
    await removePluginFromJsonc();
    console.log("");
    console.log("Done. Restart opencode for changes to take effect.");
    return;
  }

  const srcCheck = await stat(PLUGIN_SRC).catch(() => null);
  if (!srcCheck || !srcCheck.isDirectory()) {
    console.error(`✗ QTK plugin source not found at ${PLUGIN_SRC}`);
    process.exit(1);
  }

  const tgtCheck = await stat(target).catch(() => null);
  if (!tgtCheck || !tgtCheck.isDirectory()) {
    console.error(`✗ opencode target dir not found at ${target}`);
    process.exit(1);
  }

  const { mkdir } = await import("node:fs/promises");
  await mkdir(resolve(target, ".opencode/plugin"), { recursive: true });

  await ensureSymlink();
  await ensurePluginInJsonc();

  console.log("");
  console.log("Done. Restart opencode for changes to take effect.");
  console.log(
    `Smoke test: start an opencode session in ${target} and look for "[qtk] active" in stdout.`,
  );
}

await main();
