import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const piRoot = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent");
const nestedVulnerableBraceExpansion = resolve(piRoot, "node_modules/brace-expansion");
const nestedVulnerableUndici = resolve(piRoot, "node_modules/undici");
const piManifest = resolve(piRoot, "package.json");

rmSync(nestedVulnerableBraceExpansion, { recursive: true, force: true });
rmSync(nestedVulnerableUndici, { recursive: true, force: true });

const requireFromPi = createRequire(piManifest);
const braceExpansionManifest = requireFromPi("brace-expansion/package.json");
if (braceExpansionManifest.version !== "5.0.9") {
  throw new Error(`Expected brace-expansion 5.0.9, resolved ${braceExpansionManifest.version}`);
}
const undiciManifest = requireFromPi("undici/package.json");
if (undiciManifest.version !== "8.9.0") {
  throw new Error(`Expected undici 8.9.0, resolved ${undiciManifest.version}`);
}

console.log("Verified patched brace-expansion 5.0.9 and undici 8.9.0 resolutions for pi.");
