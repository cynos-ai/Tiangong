import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../agent/canonical-json.mjs";
import { loadRoleProfileBundle } from "../agent/config/role-profile.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { ReviewerPracticeGate } from "../agent/gates/reviewer-practice-gate.mjs";
import { PracticeRunError } from "../agent/practices/errors.mjs";
import { PracticeRunService } from "../agent/practices/practice-run-service.mjs";
import { ProtectedPayloadStore } from "../agent/practices/protected-payload-store.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import { TurnContextController } from "../agent/turn-context.mjs";
import { createReviewerStateToolRegistry } from "../agent/work/state-tools.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_ID = "session-one";
const ACTOR = "@requester:example.test";

async function reviewerProfile() {
  return loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", "reviewer.json"),
    resourceRoot: WORKER_ROOT,
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-practice-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspaceDir);
  await writeFile(join(workspaceDir, "a.txt"), "alpha\n");
  await writeFile(join(workspaceDir, "b.txt"), "beta\n");
  await writeFile(join(workspaceDir, "c.txt"), "gamma\n");
  const paths = statePathsForSession({ stateDirectory, sessionId: SESSION_ID });
  const profileBundle = await reviewerProfile();
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 6, 30, 0, 0, tick++));
  const options = {
    sessionId: SESSION_ID,
    workspaceDir,
    profileBundle,
    journalPath: paths.practiceRunJournalPath,
    snapshotPath: paths.practiceRunSnapshotPath,
    protectedDirectory: paths.practiceRunProtectedDirectory,
    clock,
  };
  return {
    root,
    workspaceDir,
    paths,
    profileBundle,
    options,
    service: new PracticeRunService(options),
  };
}

function invocation(profileDigest, id, overrides = {}) {
  return {
    sessionId: SESSION_ID,
    turnId: `turn-${id}`,
    toolCallId: `call-${id}`,
    actor: {
      id: ACTOR,
      messageId: `$event-${id}`,
    },
    ingress: { prompt: `request prompt ${id}` },
    profileDigest,
    ...overrides,
  };
}

function startInput(files = ["a.txt"]) {
  return {
    practiceId: "review",
    objective: "Review the selected files",
    acceptanceCriteria: ["Identify correctness risks", "Identify security risks"],
    files,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof PracticeRunError && error.code === code,
  );
}

async function allFiles(root) {
  const output = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else output.push(child);
    }
  }
  await visit(root);
  return output.sort();
}

test("start, append-only extend, abandon, replay, and a later run preserve authority", async (t) => {
  const f = await fixture(t);
  const profileDigest = f.profileBundle.profileDigest;
  const startInvocation = invocation(profileDigest, "start");
  const started = await f.service.start(startInput(), startInvocation);

  assert.equal(started.replayed, false);
  assert.equal(started.eventType, "run.started");
  assert.match(started.run.runId, /^run-/u);
  assert.equal(started.run.status, "active");
  assert.equal(started.run.revision, 1);
  assert.equal(started.run.origin.actorId, ACTOR);
  assert.deepEqual(started.run.objective, {
    text: "Review the selected files",
    source: "model_normalized",
  });
  assert.deepEqual(started.run.acceptanceCriteria.map((criterion) => criterion.id), [
    "criterion-1",
    "criterion-2",
  ]);
  assert.deepEqual(started.run.scope.files, ["a.txt"]);
  assert.equal(started.run.scope.digest, sha256(["a.txt"]));

  await expectCode(
    f.service.start(startInput(), invocation(profileDigest, "second-start")),
    "ACTIVE_RUN_EXISTS",
  );
  await expectCode(f.service.start(startInput(), {
    ...startInvocation,
    actor: { id: "@other:example.test", messageId: startInvocation.actor.messageId },
  }), "RUN_REQUESTER_MISMATCH");
  const wrongActor = invocation(profileDigest, "wrong", {
    actor: { id: "@other:example.test", messageId: "$event-wrong" },
  });
  await expectCode(f.service.start(startInput(), wrongActor), "RUN_REQUESTER_MISMATCH");
  await expectCode(f.service.extend({ files: ["b.txt"] }, wrongActor), "RUN_REQUESTER_MISMATCH");
  await assert.rejects(
    f.service.activeForActor("@other:example.test"),
    (error) => error.code === "RUN_REQUESTER_MISMATCH" &&
      !error.message.includes(started.run.runId) && !error.message.includes("Review the selected"),
  );

  const extendInvocation = invocation(profileDigest, "extend");
  const extended = await f.service.extend({ files: ["b.txt"] }, extendInvocation);
  assert.equal(extended.replayed, false);
  assert.equal(extended.run.revision, 2);
  assert.equal(extended.run.scope.revision, 2);
  assert.deepEqual(extended.run.scope.files, ["a.txt", "b.txt"]);
  assert.deepEqual(extended.run.objective, started.run.objective);
  assert.deepEqual(extended.run.acceptanceCriteria, started.run.acceptanceCriteria);

  const extendReplay = await f.service.extend({ files: ["b.txt"] }, extendInvocation);
  assert.equal(extendReplay.replayed, true);
  assert.equal(extendReplay.stateEventId, extended.stateEventId);
  assert.equal(extendReplay.run.revision, 2);
  await expectCode(f.service.extend({ files: ["c.txt"] }, extendInvocation), "INVOCATION_CONFLICT");
  await expectCode(
    f.service.extend({ files: ["b.txt"] }, invocation(profileDigest, "duplicate-file")),
    "SCOPE_FILE_ALREADY_PRESENT",
  );

  const abandonInvocation = invocation(profileDigest, "abandon");
  const abandoned = await f.service.abandon({
    reasonCode: "user_cancelled",
    summary: "The requester cancelled this review",
  }, abandonInvocation);
  assert.equal(abandoned.run.status, "abandoned");
  assert.equal(abandoned.run.revision, 3);
  assert.equal(abandoned.run.finishedAt, abandoned.run.updatedAt);
  assert.equal(await f.service.activeForActor(ACTOR, { required: false }), undefined);

  const abandonReplay = await f.service.abandon({
    reasonCode: "user_cancelled",
    summary: "The requester cancelled this review",
  }, abandonInvocation);
  assert.equal(abandonReplay.replayed, true);
  assert.equal(abandonReplay.stateEventId, abandoned.stateEventId);
  assert.equal(abandonReplay.run.status, "abandoned");

  const oldStartReplay = await f.service.start(startInput(), startInvocation);
  assert.equal(oldStartReplay.replayed, true);
  assert.equal(oldStartReplay.run.status, "active");
  assert.equal(oldStartReplay.run.revision, 1);
  const second = await f.service.start(startInput(["c.txt"]), invocation(profileDigest, "new-run"));
  assert.notEqual(second.run.runId, started.run.runId);
  assert.equal(second.run.status, "active");
  assert.equal((await f.service.state()).sequence, 4);
});

test("journal and snapshot contain refs and normalized metadata but no protected prose", async (t) => {
  const f = await fixture(t);
  const profileDigest = f.profileBundle.profileDigest;
  await f.service.start(startInput(), invocation(profileDigest, "private-start", {
    ingress: { prompt: "private ingress marker" },
  }));
  await f.service.abandon({
    reasonCode: "cannot_complete",
    summary: "private abandonment marker",
  }, invocation(profileDigest, "private-abandon"));

  const journal = await readFile(f.paths.practiceRunJournalPath, "utf8");
  const snapshot = await readFile(f.paths.practiceRunSnapshotPath, "utf8");
  for (const marker of [
    "private ingress marker",
    "Review the selected files",
    "Identify correctness risks",
    "private abandonment marker",
  ]) {
    assert.equal(journal.includes(marker), false);
    assert.equal(snapshot.includes(marker), false);
  }
  assert.match(journal, /requests\/[a-f0-9]{64}\.json/u);
  assert.match(journal, /specs\/[a-f0-9]{64}\.json/u);
  assert.match(journal, /notes\/[a-f0-9]{64}\.json/u);

  const protectedFiles = await allFiles(f.paths.practiceRunProtectedDirectory);
  assert.equal(protectedFiles.length, 4);
  assert.equal((await lstat(f.paths.practiceRunDirectory)).mode & 0o077, 0);
  for (const file of protectedFiles) assert.equal((await lstat(file)).mode & 0o077, 0);
  assert.equal((await lstat(f.paths.practiceRunJournalPath)).mode & 0o077, 0);
  assert.equal((await lstat(f.paths.practiceRunSnapshotPath)).mode & 0o077, 0);

  const protectedText = (await Promise.all(protectedFiles.map((file) => readFile(file, "utf8")))).join("\n");
  assert.match(protectedText, /private ingress marker/u);
  assert.match(protectedText, /Review the selected files/u);
  assert.match(protectedText, /private abandonment marker/u);
});

test("strict admission rejects spoofed identity, invalid specs, unsafe paths, and limits", async (t) => {
  const f = await fixture(t);
  const digest = f.profileBundle.profileDigest;
  const validInvocation = invocation(digest, "validation");

  await expectCode(f.service.extend({ files: ["b.txt"] }, validInvocation), "ACTIVE_RUN_REQUIRED");
  await expectCode(f.service.abandon({
    reasonCode: "other",
    summary: "nothing active",
  }, validInvocation), "ACTIVE_RUN_REQUIRED");
  await expectCode(
    f.service.start(startInput(), invocation(digest, "actor-missing", {
      actor: { id: null, messageId: "$event" },
    })),
    "AUTHENTICATED_ACTOR_REQUIRED",
  );
  await expectCode(
    f.service.start(startInput(), invocation(digest, "message-missing", {
      actor: { id: ACTOR, messageId: null },
    })),
    "SOURCE_MESSAGE_ID_REQUIRED",
  );
  await expectCode(
    f.service.start({ ...startInput(), practiceId: "other" }, validInvocation),
    "PRACTICE_NOT_ALLOWED",
  );
  await expectCode(
    f.service.start({ ...startInput(), objective: "x".repeat(4097) }, validInvocation),
    "INVALID_OBJECTIVE",
  );
  await expectCode(
    f.service.start({ ...startInput(), acceptanceCriteria: [] }, validInvocation),
    "INVALID_CRITERIA",
  );
  await expectCode(
    f.service.start({
      ...startInput(),
      acceptanceCriteria: Array.from({ length: 33 }, (_, index) => `criterion ${index}`),
    }, validInvocation),
    "INVALID_CRITERIA",
  );
  await expectCode(
    f.service.start({ ...startInput(), acceptanceCriteria: ["same", " same "] }, validInvocation),
    "INVALID_CRITERIA",
  );
  await expectCode(
    f.service.start({ ...startInput(), files: ["a.txt", "./a.txt"] }, validInvocation),
    "INVALID_SCOPE",
  );
  await expectCode(
    f.service.start({ ...startInput(), files: Array.from({ length: 65 }, () => "a.txt") }, validInvocation),
    "INVALID_SCOPE",
  );
  await expectCode(
    f.service.start({ ...startInput(), files: ["../escape.txt"] }, validInvocation),
    "PATH_OUTSIDE_WORKSPACE",
  );
  await expectCode(
    f.service.start({ ...startInput(), files: ["missing.txt"] }, validInvocation),
    "PATH_NOT_REGULAR_FILE",
  );
  await expectCode(
    f.service.start({ ...startInput(), files: ["."] }, validInvocation),
    "PATH_NOT_REGULAR_FILE",
  );

  await writeFile(join(f.workspaceDir, ".env"), "not-a-real-secret\n");
  await expectCode(
    f.service.start({ ...startInput(), files: [".env"] }, validInvocation),
    "SENSITIVE_PATH_DENIED",
  );
  await symlink(join(f.workspaceDir, "a.txt"), join(f.workspaceDir, "linked.txt"));
  await expectCode(
    f.service.start({ ...startInput(), files: ["linked.txt"] }, validInvocation),
    "SYMLINK_DENIED",
  );
  await writeFile(join(f.workspaceDir, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await expectCode(
    f.service.start({ ...startInput(), files: ["large.txt"] }, validInvocation),
    "SCOPE_LIMIT_EXCEEDED",
  );
  await expectCode(
    f.service.start({ ...startInput(), unexpected: true }, validInvocation),
    "INVALID_SCOPE",
  );
  await expectCode(
    f.service.start(startInput(), invocation("0".repeat(64), "profile-spoof")),
    "STATE_CORRUPTED",
  );
  assert.equal((await f.service.state()).sequence, 0);
});

test("CAS rejects a stale prepared extension without a partial append", async (t) => {
  const f = await fixture(t);
  const digest = f.profileBundle.profileDigest;
  await f.service.start(startInput(), invocation(digest, "start"));
  const preparedB = await f.service.prepareExtend({ files: ["b.txt"] }, invocation(digest, "extend-b"));
  const preparedC = await f.service.prepareExtend({ files: ["c.txt"] }, invocation(digest, "extend-c"));
  assert.equal(Object.isFrozen(preparedB), true);
  await f.service.commitExtend(preparedB);
  await expectCode(f.service.commitExtend(preparedC), "STALE_RUN_REVISION");
  assert.deepEqual((await f.service.activeForActor(ACTOR)).scope.files, ["a.txt", "b.txt"]);
  assert.equal((await f.service.state()).sequence, 2);
  await assert.rejects(f.service.commitExtend({}), /service-prepared extend/u);
});

test("independent service instances serialize the same invocation and append once", async (t) => {
  const f = await fixture(t);
  const other = new PracticeRunService(f.options);
  const digest = f.profileBundle.profileDigest;
  const params = startInput();
  const call = invocation(digest, "concurrent");
  const results = await Promise.all([
    f.service.start(params, call),
    other.start(params, call),
  ]);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(results[0].stateEventId, results[1].stateEventId);
  assert.equal((await f.service.state()).sequence, 1);
  assert.equal((await other.state()).sequence, 1);
});

test("snapshot loss or mismatch rebuilds from journal, while journal corruption fails closed", async (t) => {
  const f = await fixture(t);
  const digest = f.profileBundle.profileDigest;
  await f.service.start(startInput(), invocation(digest, "start"));

  await writeFile(f.paths.practiceRunSnapshotPath, '{"schemaVersion":1,"activeRunId":"forged"}\n');
  const recovered = new PracticeRunService(f.options);
  assert.equal((await recovered.activeForActor(ACTOR)).objective.text, "Review the selected files");
  assert.equal(JSON.parse(await readFile(f.paths.practiceRunSnapshotPath, "utf8")).activeRunId.startsWith("run-"), true);

  await rm(f.paths.practiceRunSnapshotPath);
  assert.equal((await new PracticeRunService(f.options).state()).sequence, 1);
  await lstat(f.paths.practiceRunSnapshotPath);

  await writeFile(f.paths.practiceRunJournalPath, `${await readFile(f.paths.practiceRunJournalPath, "utf8")}{`);
  await expectCode(new PracticeRunService(f.options).state(), "STATE_CORRUPTED");
});

test("semantic revision corruption and protected payload tampering fail closed", async (t) => {
  const revisionFixture = await fixture(t);
  const digest = revisionFixture.profileBundle.profileDigest;
  await revisionFixture.service.start(startInput(), invocation(digest, "start"));
  await revisionFixture.service.extend({ files: ["b.txt"] }, invocation(digest, "extend"));
  const lines = (await readFile(revisionFixture.paths.practiceRunJournalPath, "utf8")).trim().split("\n");
  const second = JSON.parse(lines[1]);
  second.runRevision = 99;
  const { hash: ignored, ...unsigned } = second;
  second.hash = sha256(unsigned);
  await writeFile(revisionFixture.paths.practiceRunJournalPath, `${lines[0]}\n${canonicalJson(second)}\n`);
  await expectCode(new PracticeRunService(revisionFixture.options).state(), "STATE_CORRUPTED");

  const payloadFixture = await fixture(t);
  await payloadFixture.service.start(startInput(), invocation(payloadFixture.profileBundle.profileDigest, "start"));
  const journalRecord = JSON.parse((await readFile(payloadFixture.paths.practiceRunJournalPath, "utf8")).trim());
  const specPath = join(payloadFixture.paths.practiceRunProtectedDirectory, journalRecord.payload.spec.payloadRef);
  await writeFile(specPath, `${await readFile(specPath, "utf8")}tampered\n`);
  await expectCode(payloadFixture.service.activeForActor(ACTOR), "STATE_CORRUPTED");
});

test("journal commit remains authoritative when snapshot persistence fails", async (t) => {
  const f = await fixture(t);
  let uuidCall = 0;
  const uuid = () => {
    uuidCall += 1;
    if (uuidCall === 4) return "bad/path";
    return `00000000-0000-4000-8000-${String(uuidCall).padStart(12, "0")}`;
  };
  const crashing = new PracticeRunService({ ...f.options, uuid });
  const params = startInput();
  const call = invocation(f.profileBundle.profileDigest, "snapshot-crash");
  const prepared = await crashing.prepareStart(params, call);
  await expectCode(crashing.commitStart(prepared), "STATE_CORRUPTED");
  assert.equal((await readFile(f.paths.practiceRunJournalPath, "utf8")).trim().split("\n").length, 1);

  const recovered = new PracticeRunService(f.options);
  const replay = await recovered.start(params, call);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.status, "active");
  assert.equal((await recovered.state()).sequence, 1);
});

test("journal and protected symlinks fail closed while a symlinked snapshot is rebuilt", async (t) => {
  const snapshotFixture = await fixture(t);
  await snapshotFixture.service.start(
    startInput(),
    invocation(snapshotFixture.profileBundle.profileDigest, "snapshot-start"),
  );
  const snapshotOriginal = `${snapshotFixture.paths.practiceRunSnapshotPath}.original`;
  await writeFile(snapshotOriginal, await readFile(snapshotFixture.paths.practiceRunSnapshotPath));
  await rm(snapshotFixture.paths.practiceRunSnapshotPath);
  await symlink(snapshotOriginal, snapshotFixture.paths.practiceRunSnapshotPath);
  assert.equal((await new PracticeRunService(snapshotFixture.options).state()).sequence, 1);
  assert.equal((await lstat(snapshotFixture.paths.practiceRunSnapshotPath)).isSymbolicLink(), false);

  const journalFixture = await fixture(t);
  await journalFixture.service.start(
    startInput(),
    invocation(journalFixture.profileBundle.profileDigest, "journal-start"),
  );
  const journalOriginal = `${journalFixture.paths.practiceRunJournalPath}.original`;
  await writeFile(journalOriginal, await readFile(journalFixture.paths.practiceRunJournalPath));
  await rm(journalFixture.paths.practiceRunJournalPath);
  await symlink(journalOriginal, journalFixture.paths.practiceRunJournalPath);
  await expectCode(new PracticeRunService(journalFixture.options).state(), "STATE_CORRUPTED");

  const payloadFixture = await fixture(t);
  await payloadFixture.service.start(
    startInput(),
    invocation(payloadFixture.profileBundle.profileDigest, "payload-start"),
  );
  const record = JSON.parse((await readFile(payloadFixture.paths.practiceRunJournalPath, "utf8")).trim());
  const specPath = join(payloadFixture.paths.practiceRunProtectedDirectory, record.payload.spec.payloadRef);
  const specOriginal = `${specPath}.original`;
  await writeFile(specOriginal, await readFile(specPath));
  await rm(specPath);
  await symlink(specOriginal, specPath);
  await expectCode(payloadFixture.service.activeForActor(ACTOR), "STATE_CORRUPTED");
});

test("protected payload orphans are ignored and permissive files are tightened", async (t) => {
  const f = await fixture(t);
  const payloads = new ProtectedPayloadStore({ directory: f.paths.practiceRunProtectedDirectory });
  const orphan = await payloads.put("note", { summary: "orphan marker" });
  assert.match(orphan.ref, /^notes\/[a-f0-9]{64}\.json$/u);
  assert.equal((await f.service.state()).activeRunId, null);
  assert.equal((await f.service.state()).sequence, 0);

  const notePath = join(f.paths.practiceRunProtectedDirectory, orphan.ref);
  await chmod(notePath, 0o644);
  assert.deepEqual(await payloads.read("note", orphan.ref), { summary: "orphan marker" });
  assert.equal((await lstat(notePath)).mode & 0o077, 0);
});

test("journal commit survives wrapper completion Evidence failure and replays without mutation", async (t) => {
  const f = await fixture(t);
  const recorder = new EvidenceRecorder({ filePath: f.paths.evidenceFilePath });
  let failedCompletion = false;
  const failingEvidence = {
    async append(event) {
      if (!failedCompletion && event.type === "tool.execution.completed" && event.status === "success") {
        failedCompletion = true;
        throw new Error("injected completion Evidence failure");
      }
      return recorder.append(event);
    },
  };
  const turns = new TurnContextController();
  const gate = new ReviewerPracticeGate({ profileBundle: f.profileBundle });
  function registry(evidence) {
    return createReviewerStateToolRegistry({
      service: f.service,
      gate,
      evidence,
      getInvocation: turns.current,
    });
  }
  async function execute(toolRegistry) {
    turns.begin({
      sessionId: SESSION_ID,
      turnId: "turn-evidence-crash",
      actor: { id: ACTOR, messageId: "$event-evidence-crash" },
      ingress: { prompt: "request prompt evidence crash" },
      profileDigest: f.profileBundle.profileDigest,
    });
    try {
      const definition = toolRegistry.definitions().find((candidate) => candidate.name === "start_work");
      return await definition.execute("call-evidence-crash", startInput());
    } finally {
      turns.end();
    }
  }

  await assert.rejects(execute(registry(failingEvidence)), /injected completion Evidence failure/u);
  assert.equal((await f.service.state()).sequence, 1);
  const replay = await execute(registry(recorder));
  assert.equal(replay.details.replayed, true);
  assert.equal((await f.service.state()).sequence, 1);
  assert.equal((await recorder.readAll()).at(-1).type, "tool.execution.replayed");
});

test("state-transition tools use Gate, wrapper Evidence, durable replay, and sequential execution", async (t) => {
  const f = await fixture(t);
  const evidence = new EvidenceRecorder({ filePath: f.paths.evidenceFilePath });
  const turns = new TurnContextController();
  const gate = new ReviewerPracticeGate({ profileBundle: f.profileBundle });
  assert.equal((await gate.evaluate({ operation: {
    policyVersion: "practice-run-v1",
    category: "state-transition",
    roleId: "reviewer",
    profileDigest: f.profileBundle.profileDigest,
    practiceId: "review",
    practiceVersion: 1,
    toolName: "write",
  } })).kind, "deny");
  const registry = createReviewerStateToolRegistry({
    service: f.service,
    gate,
    evidence,
    getInvocation: turns.current,
  });
  assert.deepEqual(registry.names(), ["start_work", "extend_scope", "abandon_work"]);
  assert(registry.definitions().every((definition) => definition.executionMode === "sequential"));
  assert.equal(registry.names().includes("write"), false);

  const phases = [];
  const observability = {
    checkpoint(phase, attributes) { phases.push({ phase, attributes }); },
    startOperation() { return { end() {} }; },
  };
  async function execute(name, params, id, { replay = false } = {}) {
    turns.begin({
      sessionId: SESSION_ID,
      turnId: `turn-${id}`,
      actor: { id: ACTOR, messageId: `$event-${id}` },
      ingress: { prompt: `request prompt ${id}` },
      profileDigest: f.profileBundle.profileDigest,
      observability,
    });
    try {
      const definition = registry.definitions().find((candidate) => candidate.name === name);
      const result = await definition.execute(`call-${id}`, params);
      assert.equal(result.details.replayed, replay);
      return result;
    } finally {
      turns.end();
    }
  }

  const started = await execute("start_work", startInput(), "tool-start");
  assert.equal(started.details.status, "active");
  assert.equal(started.details.runRevision, 1);
  const replayed = await execute("start_work", startInput(), "tool-start", { replay: true });
  assert.equal(replayed.details.stateEventId, started.details.stateEventId);
  await execute("extend_scope", { files: ["b.txt"] }, "tool-extend");
  const abandoned = await execute("abandon_work", {
    reasonCode: "cannot_complete",
    summary: "No further static review is possible",
  }, "tool-abandon");
  assert.equal(abandoned.details.status, "abandoned");
  assert.equal((await f.service.state()).sequence, 3);

  const records = await evidence.readAll();
  assert.deepEqual(records.map((record) => record.type), [
    "tool.proposed", "gate.decided", "tool.execution.started", "tool.execution.completed",
    "tool.proposed", "gate.decided", "tool.execution.started", "tool.execution.replayed",
    "tool.proposed", "gate.decided", "tool.execution.started", "tool.execution.completed",
    "tool.proposed", "gate.decided", "tool.execution.started", "tool.execution.completed",
  ]);
  const evidenceText = JSON.stringify(records);
  assert.equal(evidenceText.includes("Review the selected files"), false);
  assert.equal(evidenceText.includes("No further static review is possible"), false);
  assert.equal(evidenceText.includes("request prompt"), false);
  assert(records.filter((record) => record.type === "gate.decided")
    .every((record) => record.decision === "allow" && record.operation.category === "state-transition"));

  const journal = (await readFile(f.paths.practiceRunJournalPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(journal[0].invocationKey, records[1].idempotencyKey);
  assert.equal(journal[0].actionDigest, records[1].operationDigest);
  assert.equal(records[3].stateEventId, journal[0].stateEventId);
  assert.equal(records[3].stateEventHash, journal[0].hash);
  assert.equal(records[3].stateSequence, journal[0].sequence);
  assert(phases.some((entry) => entry.phase === "practice.run.start"));
  assert(phases.some((entry) => entry.phase === "practice.scope.extend"));
  assert(phases.some((entry) => entry.phase === "practice.run.abandon"));
});
