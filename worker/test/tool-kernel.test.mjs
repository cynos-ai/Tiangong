import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { PolicyGate } from "../agent/gates/policy-gate.mjs";
import { IdempotencyStore } from "../agent/idempotency/store.mjs";
import { PendingOperationStore } from "../agent/pending-operation/store.mjs";
import { createCoreToolRegistry } from "../agent/tools/registry.mjs";
import { GateDeniedError } from "../agent/tools/wrapper.mjs";
import { TurnContextController } from "../agent/turn-context.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-tool-kernel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDir = join(root, "state");
  await writeFile(join(root, ".keep"), "");
  await mkdir(workspaceDir);
  return { root, workspaceDir, stateDir };
}

function createKernel({ workspaceDir, stateDir, evidenceOverride, gateOverride }) {
  const evidence = evidenceOverride ?? new EvidenceRecorder({
    filePath: join(stateDir, "evidence", "events.jsonl"),
  });
  const store = new IdempotencyStore({ filePath: join(stateDir, "idempotency.json") });
  const pendingOperations = new PendingOperationStore({
    directory: join(stateDir, "pending-operations"),
  });
  const gate = gateOverride ?? new PolicyGate({ idempotencyStore: store });
  const turns = new TurnContextController();
  const registry = createCoreToolRegistry({
    workspaceDir,
    stateDir,
    gate,
    evidence,
    idempotencyStore: store,
    pendingOperationStore: pendingOperations,
    getInvocation: turns.current,
  });
  return { evidence, gate, pendingOperations, registry, store, turns };
}

function tool(kernel, name) {
  const definition = kernel.registry.definitions().find((candidate) => candidate.name === name);
  assert(definition, `missing tool ${name}`);
  assert.equal(definition.executionMode, "sequential");
  return definition;
}

async function execute(kernel, { sessionId = "session-1", turnId, toolCallId, name, params }) {
  kernel.turns.begin({
    sessionId,
    turnId,
    actor: { id: "@requester:example.test", isOwner: false },
  });
  try {
    return await tool(kernel, name).execute(toolCallId, params);
  } finally {
    kernel.turns.end();
  }
}

test("read is gated and records proposal, decision, start, and completion", async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.workspaceDir, "fixture.txt"), "hello\n");
  const kernel = createKernel(paths);

  const result = await execute(kernel, {
    turnId: "turn-read",
    toolCallId: "call-read",
    name: "read",
    params: { path: "fixture.txt" },
  });

  assert.match(result.content[0].text, /hello/u);
  const records = await kernel.evidence.readAll();
  assert.deepEqual(records.map((record) => record.type), [
    "tool.proposed",
    "gate.decided",
    "tool.execution.started",
    "tool.execution.completed",
  ]);
  assert(records.every((record) => record.toolCallId === "call-read"));
  assert.equal(records[1].decision, "allow");
});

test("pending write survives restart, executes once after approval, and replays safely", async (t) => {
  const paths = await fixture(t);
  let kernel = createKernel(paths);
  const invocation = {
    turnId: "turn-write",
    toolCallId: "call-write",
    name: "write",
    params: { path: "output.txt", content: "approved content\n" },
  };

  const pending = await execute(kernel, invocation);
  assert.equal(pending.details.gate, "pending");
  await assert.rejects(readFile(join(paths.workspaceDir, "output.txt")), { code: "ENOENT" });
  const checkpoint = await kernel.store.get(pending.details.idempotencyKey);
  assert.equal(checkpoint.status, "pending");
  assert.equal(checkpoint.operation.input.contentDigest.length, 64);
  assert.equal(JSON.stringify(checkpoint).includes("approved content"), false);

  kernel = createKernel(paths);
  const recovered = await kernel.pendingOperations.load(pending.details.idempotencyKey, checkpoint);
  assert.deepEqual(recovered.arguments, invocation.params);
  const approval = {
    operationDigest: pending.details.operationDigest,
    approvedBy: "@reviewer:example.test",
  };
  await kernel.store.approve(pending.details.idempotencyKey, approval);
  await kernel.store.approve(pending.details.idempotencyKey, approval);
  await assert.rejects(
    kernel.store.approve(pending.details.idempotencyKey, { ...approval, approvedBy: "@other:example.test" }),
    /subject mismatch/u,
  );
  await execute(kernel, { ...invocation, params: recovered.arguments });
  assert.equal(await readFile(join(paths.workspaceDir, "output.txt"), "utf8"), "approved content\n");

  kernel = createKernel(paths);
  const completed = await kernel.store.get(pending.details.idempotencyKey);
  const recoveredReplay = await kernel.pendingOperations.load(pending.details.idempotencyKey, completed);
  const replay = await execute(kernel, { ...invocation, params: recoveredReplay.arguments });
  assert.equal(replay.details.replayed, true);
  const records = await kernel.evidence.readAll();
  assert.equal(records.filter((record) =>
    record.type === "tool.execution.started" && record.toolName === "write").length, 1);
  assert.equal(records.filter((record) => record.type === "tool.execution.replayed").length, 1);
});

test("first pending call suspends later tools in the same sequential turn", async (t) => {
  const paths = await fixture(t);
  const kernel = createKernel(paths);
  kernel.turns.begin({
    sessionId: "session-batch",
    turnId: "turn-batch",
    actor: { id: "@requester:example.test", isOwner: false },
  });
  try {
    const first = await tool(kernel, "write").execute("call-one", {
      path: "one.txt",
      content: "one",
    });
    const second = await tool(kernel, "write").execute("call-two", {
      path: "two.txt",
      content: "two",
    });
    assert.equal(first.details.gate, "pending");
    assert.equal(second.details.gate, "pending");
    assert.equal(second.details.approvalId, first.details.approvalId);
    assert.equal(second.details.idempotencyKey, first.details.idempotencyKey);
    assert.equal(second.details.operationDigest, first.details.operationDigest);
  } finally {
    kernel.turns.end();
  }

  await assert.rejects(readFile(join(paths.workspaceDir, "one.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(paths.workspaceDir, "two.txt")), { code: "ENOENT" });
  const records = await kernel.evidence.readAll();
  const decisions = records.filter((record) => record.type === "gate.decided");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[1].blockedByToolCallId, "call-one");
});

test("deny never calls the wrapped backend", async (t) => {
  const paths = await fixture(t);
  const kernel = createKernel({
    ...paths,
    gateOverride: {
      async evaluate() {
        return { kind: "deny", reason: "test policy", reasonCode: "TEST_DENY" };
      },
    },
  });

  await assert.rejects(execute(kernel, {
    turnId: "turn-deny",
    toolCallId: "call-deny",
    name: "write",
    params: { path: "denied.txt", content: "must not exist" },
  }), GateDeniedError);
  await assert.rejects(readFile(join(paths.workspaceDir, "denied.txt")), { code: "ENOENT" });
  const records = await kernel.evidence.readAll();
  assert.deepEqual(records.map((record) => record.type), ["tool.proposed", "gate.decided"]);
});

test("write rejects path escape and symbolic-link traversal", async (t) => {
  const paths = await fixture(t);
  const kernel = createKernel(paths);
  await symlink(paths.root, join(paths.workspaceDir, "escape"));

  await assert.rejects(execute(kernel, {
    turnId: "turn-path",
    toolCallId: "call-path",
    name: "write",
    params: { path: "escape/outside.txt", content: "no" },
  }), /Symbolic links are not allowed/u);
  await assert.rejects(readFile(join(paths.root, "outside.txt")), { code: "ENOENT" });
  await assert.rejects(execute(kernel, {
    turnId: "turn-state-path",
    toolCallId: "call-state-path",
    name: "read",
    params: { path: ".tiangong/runtime/idempotency.json" },
  }), /state directory is not accessible/u);
  await assert.rejects(execute(kernel, {
    turnId: "turn-credential-path",
    toolCallId: "call-credential-path",
    name: "read",
    params: { path: ".env.local" },
  }), /Credential-bearing paths/u);
});

test("write rolls back when durable completion evidence fails", async (t) => {
  const paths = await fixture(t);
  const recorder = new EvidenceRecorder({ filePath: join(paths.stateDir, "evidence", "events.jsonl") });
  let failCompletionOnce = true;
  const evidence = {
    append(event) {
      if (event.type === "tool.execution.completed" && event.status === "success" && failCompletionOnce) {
        failCompletionOnce = false;
        throw new Error("injected evidence failure");
      }
      return recorder.append(event);
    },
  };
  const kernel = createKernel({ ...paths, evidenceOverride: evidence });
  const invocation = {
    turnId: "turn-rollback",
    toolCallId: "call-rollback",
    name: "write",
    params: { path: "rollback.txt", content: "new content" },
  };
  const pending = await execute(kernel, invocation);
  await kernel.store.approve(pending.details.idempotencyKey, {
    operationDigest: pending.details.operationDigest,
    approvedBy: "@reviewer:example.test",
  });

  await assert.rejects(execute(kernel, invocation), /injected evidence failure/u);
  await assert.rejects(readFile(join(paths.workspaceDir, "rollback.txt")), { code: "ENOENT" });
  assert.equal((await kernel.store.get(pending.details.idempotencyKey)).status, "failed");
  const records = await recorder.readAll();
  const completion = records.find((record) =>
    record.type === "tool.execution.completed" && record.status === "error");
  assert.equal(completion.rollbackStatus, "completed");
});
