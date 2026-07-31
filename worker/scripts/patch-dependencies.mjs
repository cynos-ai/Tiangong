import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const piRoot = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent");
const nestedVulnerableCopy = resolve(piRoot, "node_modules/brace-expansion");
const minimatchManifest = resolve(piRoot, "node_modules/minimatch/package.json");

rmSync(nestedVulnerableCopy, { recursive: true, force: true });

const requireFromMinimatch = createRequire(minimatchManifest);
const resolvedManifest = requireFromMinimatch("brace-expansion/package.json");
if (resolvedManifest.version !== "5.0.8") {
  throw new Error(`Expected brace-expansion 5.0.8, resolved ${resolvedManifest.version}`);
}

console.log("Verified patched brace-expansion 5.0.8 resolution for pi.");
