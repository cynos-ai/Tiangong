import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { IdempotencyStore } from "../agent/idempotency/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-idempotency-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "idempotency.jsonl");
}

function pending(suffix) {
  return {
    idempotencyKey: key(suffix),
    sessionId: "session-one",
    turnId: `turn-${suffix}`,
    toolCallId: `call-${suffix}`,
    toolName: "write",
    requestDigest: sha256(`request-${suffix}`),
    operationDigest: sha256(`operation-${suffix}`),
    approvalId: `approval-${suffix}`,
    requestedBy: "@requester:example.test",
    operation: { toolName: "write", target: `output-${suffix}.txt` },
  };
}

function key(suffix) {
  return sha256(`key-${suffix}`);
}

test("state transitions append and indexed readers observe cross-instance updates", async (t) => {
  const filePath = await fixture(t);
  const first = new IdempotencyStore({ filePath });
  const value = pending("one");
  const operationKey = key("one");
  await first.putPending(operationKey, value);
  const pendingJournal = await readFile(filePath, "utf8");
  assert.equal(pendingJournal.trim().split("\n").length, 1);

  await first.approve(operationKey, {
    operationDigest: value.operationDigest,
    approvedBy: value.requestedBy,
  });
  const approvedJournal = await readFile(filePath, "utf8");
  assert.equal(approvedJournal.startsWith(pendingJournal), true);
  assert.equal(approvedJournal.trim().split("\n").length, 2);
  assert.equal((await first.findInvocation(value)).key, operationKey);
  assert.equal((await first.findApproval(value.approvalId)).key, operationKey);

  const second = new IdempotencyStore({ filePath });
  await second.beginExecution(operationKey, value);
  assert.equal((await first.get(operationKey)).status, "executing");
  await second.complete(operationKey, {
    operationDigest: value.operationDigest,
    replayResult: { content: [], details: { ok: true } },
  });
  assert.equal((await first.findApproval(value.approvalId)).entry.status, "completed");
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 4);

  await chmod(filePath, 0o644);
  assert.equal((await new IdempotencyStore({ filePath }).get(operationKey)).status, "completed");
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("operation digest lookup reuses one durable approval identity", async (t) => {
  const filePath = await fixture(t);
  const store = new IdempotencyStore({ filePath });
  const value = pending("digest-reuse");
  const firstKey = key("digest-reuse");
  await store.putPending(firstKey, value);
  const found = await store.findByOperationDigest(value.operationDigest);
  assert.equal(found.key, firstKey);
  assert.equal(found.entry.approvalId, value.approvalId);
  const secondKey = key("digest-reuse-second");
  assert.equal(await store.findByOperationDigest(value.operationDigest).then((entry) => entry.key), firstKey);
  await store.approve(firstKey, { operationDigest: value.operationDigest, approvedBy: value.requestedBy });
  await store.beginExecution(firstKey, { ...value, idempotencyKey: secondKey, sessionId: "new-session", turnId: "new-turn", toolCallId: "new-call" });
  const executing = await store.get(firstKey);
  assert.equal(executing.status, "executing");
  assert.equal(executing.sessionId, value.sessionId);
  assert.equal(executing.turnId, value.turnId);
  assert.equal(executing.toolCallId, value.toolCallId);
});

test("invocation and approval indexes reject ambiguous records", async (t) => {
  const filePath = await fixture(t);
  const store = new IdempotencyStore({ filePath });
  const value = pending("one");
  await store.putPending(key("one"), value);
  await assert.rejects(
    store.putPending(key("mismatch"), value),
    /key mismatch/u,
  );
  await assert.rejects(
    store.putPending(key("two"), {
      ...value,
      idempotencyKey: key("two"),
      operationDigest: sha256("other"),
    }),
    /one tool invocation/u,
  );
  await assert.rejects(
    store.putPending(key("three"), { ...pending("three"), approvalId: value.approvalId }),
    /Approval identifier is not unique/u,
  );
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1);
});

test("independent journal writers serialize records and preserve indexes", async (t) => {
  const filePath = await fixture(t);
  const values = Array.from({ length: 12 }, (_, index) => pending(`parallel-${index}`));
  await Promise.all(values.map((value, index) =>
    new IdempotencyStore({ filePath }).putPending(key(`parallel-${index}`), value)));

  const reopened = new IdempotencyStore({ filePath });
  for (let index = 0; index < values.length; index += 1) {
    assert.equal((await reopened.findInvocation(values[index])).key, key(`parallel-${index}`));
  }
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, values.length);
});

test("journal tampering and partial records fail closed on reopen", async (t) => {
  const filePath = await fixture(t);
  const store = new IdempotencyStore({ filePath });
  await store.putPending(key("one"), pending("one"));
  const original = await readFile(filePath, "utf8");
  await writeFile(filePath, original.replace("approval-one", "approval-xxxx"));
  await assert.rejects(
    new IdempotencyStore({ filePath }).get(key("one")),
    /Invalid idempotency journal/u,
  );

  await writeFile(filePath, `${original}{`);
  await assert.rejects(
    new IdempotencyStore({ filePath }).get(key("one")),
    /partial record/u,
  );
});

test("explicit terminal removal compacts expired history and preserves active indexes", async (t) => {
  const filePath = await fixture(t);
  const store = new IdempotencyStore({ filePath });
  const expired = pending("expired");
  const active = pending("active");
  const expiredKey = key("expired");
  const activeKey = key("active");
  await store.putPending(expiredKey, expired);
  await store.reject(expiredKey, {
    operationDigest: expired.operationDigest,
    rejectedBy: expired.requestedBy,
    rejectedAt: "2020-01-01T00:00:00.000Z",
  });
  await store.putPending(activeKey, active);
  const before = await readFile(filePath, "utf8");
  assert.equal(before.includes(expiredKey), true);

  await store.removeTerminalBefore(expiredKey, "2020-01-02T00:00:00.000Z");
  const compacted = await readFile(filePath, "utf8");
  assert.equal(compacted.includes(expiredKey), false);
  assert.equal(compacted.trim().split("\n").length, 1);
  assert.equal(await store.get(expiredKey), undefined);
  assert.equal((await store.findApproval(active.approvalId)).key, activeKey);
});
