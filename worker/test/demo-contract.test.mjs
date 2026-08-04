import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the public demo contract verifies fixed roles, Skills, Playbook, and fixture", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/check-demo-contract.mjs"], {
    cwd: ROOT,
    maxBuffer: 128 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "pass");
  assert.deepEqual(Object.keys(result.profiles).sort(), ["assessor", "designer", "implementor", "leader", "operator"]);
  assert.ok(Object.values(result.skillEvaluation).every((entry) => entry.toolSurfaceUnchanged));
});
