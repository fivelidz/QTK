// scripts/install-into-qalcode2.ts (deprecated shim)
//
// DEPRECATED: use `install-into-opencode.ts` directly. This shim exists for
// backwards-compatibility with the original installer name (qalcode2 is one
// specific opencode fork; the script is fork-agnostic).

import { resolve } from "node:path";

console.warn(
  "[deprecated] install-into-qalcode2.ts → please use install-into-opencode.ts",
);

const here = import.meta.dir;
const real = resolve(here, "install-into-opencode.ts");
await import(real);
