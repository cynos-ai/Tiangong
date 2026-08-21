import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditLockfiles } from "../scripts/audit-lockfile.mjs";

async function lockFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tg-lock-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "package-lock.json");
  await writeFile(path, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/runtime-package": { version: "2.0.0" },
      "node_modules/dev-package": { version: "3.0.0", dev: true },
    },
  }));
  return path;
}

test("bulk lockfile audit sends only concrete production package versions", async (t) => {
  const path = await lockFixture(t);
  let request;
  const result = await auditLockfiles([path], { fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response("{}", { status: 200 });
  } });
  assert.deepEqual(result, { packageCount: 1, vulnerabilityCount: 0 });
  assert.equal(request.url, "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk");
  assert.deepEqual(JSON.parse(request.options.body), { "runtime-package": ["2.0.0"] });
});

test("bulk lockfile audit fails closed on findings and endpoint errors", async (t) => {
  const path = await lockFixture(t);
  await assert.rejects(
    auditLockfiles([path], { fetchImpl: async () => new Response(JSON.stringify({ "runtime-package": [{ severity: "high" }] }), { status: 200 }) }),
    /LOCKFILE_VULNERABILITIES_FOUND/u,
  );
  await assert.rejects(
    auditLockfiles([path], { fetchImpl: async () => new Response("unavailable", { status: 503 }) }),
    /AUDIT_ENDPOINT_503/u,
  );
});
