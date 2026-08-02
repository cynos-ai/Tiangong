import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DeploymentJournal } from "../agent/deployment/journal.mjs";

const PREVIOUS = "a".repeat(64);
const ARTIFACT = "b".repeat(64);

async function withJournal(fn, faultMode = "none") {
  const root = await mkdtemp(join(tmpdir(), "tiangong-deployment-journal-"));
  const filePath = join(root, "events.jsonl");
  const journal = new DeploymentJournal({ filePath, targetId: "target-a", previousDigest: PREVIOUS, faultMode });
  try { await fn({ journal, filePath, root }); } finally { await rm(root, { recursive: true, force: true }); }
}

async function stageAndActivate(journal) {
  await journal.stage({ operationId: "deploy-a", artifactDigest: ARTIFACT, expectedCurrentDigest: PREVIOUS, rollbackDigest: PREVIOUS });
  await journal.activate({ operationId: "deploy-a" });
}

test("deployment journal stages, activates, verifies, and exactly replays one operation", async () => {
  await withJournal(async ({ journal, filePath }) => {
    const stage = await journal.stage({ operationId: "deploy-a", artifactDigest: ARTIFACT, expectedCurrentDigest: PREVIOUS, rollbackDigest: PREVIOUS });
    assert.equal(stage.replayed, false);
    assert.equal((await journal.stage({ operationId: "deploy-a", artifactDigest: ARTIFACT, expectedCurrentDigest: PREVIOUS, rollbackDigest: PREVIOUS })).replayed, true);
    assert.equal((await journal.activate({ operationId: "deploy-a" })).replayed, false);
    assert.equal((await journal.activate({ operationId: "deploy-a" })).replayed, true);
    const verified = await journal.verify({ operationId: "deploy-a", expectedDigest: ARTIFACT });
    assert.equal(verified.event.healthy, true);
    assert.equal((await journal.status()).currentDigest, ARTIFACT);

    const reopened = new DeploymentJournal({ filePath, targetId: "target-a", previousDigest: PREVIOUS, faultMode: "none" });
    assert.equal((await reopened.status()).currentDigest, ARTIFACT);
    assert.equal((await reopened.verify({ operationId: "deploy-a", expectedDigest: ARTIFACT })).replayed, true);
    const changedConfig = new DeploymentJournal({ filePath, targetId: "target-b", previousDigest: PREVIOUS, faultMode: "none" });
    await assert.rejects(changedConfig.status(), /configuration is inconsistent/);
  });
});

test("deployment journal rejects changed preconditions and operation conflicts", async () => {
  await withJournal(async ({ journal }) => {
    await journal.stage({ operationId: "deploy-a", artifactDigest: ARTIFACT, expectedCurrentDigest: PREVIOUS, rollbackDigest: PREVIOUS });
    await assert.rejects(
      journal.stage({ operationId: "deploy-a", artifactDigest: "c".repeat(64), expectedCurrentDigest: PREVIOUS, rollbackDigest: PREVIOUS }),
      /conflicts/,
    );
    await assert.rejects(
      journal.stage({ operationId: "deploy-b", artifactDigest: ARTIFACT, expectedCurrentDigest: "c".repeat(64), rollbackDigest: "c".repeat(64) }),
      /precondition/,
    );
  });
});

test("failed post-verify supports one rollback and previous-digest verification", async () => {
  await withJournal(async ({ journal }) => {
    await stageAndActivate(journal);
    assert.equal((await journal.verify({ operationId: "deploy-a", expectedDigest: ARTIFACT, phase: "post_deploy" })).event.healthy, false);
    assert.equal((await journal.rollback({ operationId: "deploy-a" })).event.toDigest, PREVIOUS);
    assert.equal((await journal.verify({ operationId: "deploy-a", expectedDigest: PREVIOUS, phase: "previous" })).event.healthy, true);
    assert.equal((await journal.status()).currentDigest, PREVIOUS);
  }, "post_verify_fail");
});

test("deployment journal fails closed on rollback faults, tampering, and partial records", async () => {
  await withJournal(async ({ journal }) => {
    await stageAndActivate(journal);
    await assert.rejects(journal.rollback({ operationId: "deploy-a" }), /Injected rollback failure/);
    assert.equal((await journal.status()).currentDigest, ARTIFACT);
  }, "rollback_fail");

  await withJournal(async ({ journal, filePath }) => {
    await stageAndActivate(journal);
    await writeFile(filePath, `${await readFile(filePath, "utf8")}{`, { mode: 0o600 });
    await assert.rejects(journal.status(), /partial record/);
  });

  await withJournal(async ({ journal, filePath }) => {
    await stageAndActivate(journal);
    const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
    const record = JSON.parse(lines[0]);
    record.event.artifactDigest = "c".repeat(64);
    lines[0] = JSON.stringify(record);
    await writeFile(filePath, `${lines.join("\n")}\n`, { mode: 0o644 });
    await chmod(filePath, 0o644);
    await assert.rejects(journal.status(), /Invalid deployment journal/);
  });
});
