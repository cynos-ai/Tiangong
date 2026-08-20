import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile); const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("public demo uses one generic Worker image and the initial responsibility set", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/check-demo-contract.mjs"], { cwd: ROOT, maxBuffer: 128 * 1024 }); const result = JSON.parse(stdout);
  assert.equal(result.status, "pass"); assert.equal(result.image, "tg-worker:dev"); assert.deepEqual(result.responsibilities, ["leader", "architect", "challenger", "developer", "reviewer", "tester"]);
});
