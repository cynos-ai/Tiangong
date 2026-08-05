import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createDeploymentOutcome } from "../agent/deployment/client.mjs";
import { DeploymentReceiptStore } from "../agent/deployment/receipt-store.mjs";
import { createChangeRevisionRef } from "../agent/work/change-revision-ref.mjs";

const revision = createChangeRevisionRef({ producerTaskId: "implement-a", artifactPath: "revision.tar", artifactDigest: "a".repeat(64), revision: 0 });
function outcome(taskId = "release-a") { return createDeploymentOutcome({ taskId, targetId: "target-a", operationDigest: "b".repeat(64), previousDigest: "c".repeat(64), currentDigest: revision.artifactDigest, changeRevisionRef: revision, disposition: "DELIVERED", postVerifyHealthy: true, rollbackPerformed: false, previousVerifyHealthy: null }); }

test("deployment receipts persist exact outcomes and reject Task conflicts and tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-deployment-receipt-")); const path = join(root, "receipts.jsonl");
  try {
    const store = new DeploymentReceiptStore({ filePath: path }); const value = outcome();
    assert.equal((await store.record(value)).replayed, false); assert.equal((await store.record(value)).replayed, true);
    assert.deepEqual(await new DeploymentReceiptStore({ filePath: path }).completedOutcome(value.contentDigest), value);
    const conflict = createDeploymentOutcome({ ...value, operationDigest: "d".repeat(64), contentDigest: undefined });
    await assert.rejects(store.record(conflict), /conflicts/);
    const text = await readFile(path, "utf8"); const record = JSON.parse(text.trim()); record.outcome.currentDigest = "e".repeat(64);
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await assert.rejects(store.completedOutcome(value.contentDigest), /integrity check/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
