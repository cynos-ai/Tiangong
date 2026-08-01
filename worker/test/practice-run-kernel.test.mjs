import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapturedArtifactStore } from "../agent/artifacts/store.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { loadRoleProfileBundle } from "../agent/config/role-profile.mjs";
import { ReviewerPracticeGate } from "../agent/gates/reviewer-practice-gate.mjs";
import { PracticeRunService } from "../agent/practices/practice-run-service.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import { createReviewerStateToolRegistry } from "../agent/work/state-tools.mjs";

const WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SESSION = "practice-v2-session";
const ACTOR = "@reviewer:example.test";

async function profile() {
  return loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", "reviewer.json"),
    resourceRoot: WORKER_ROOT,
  });
}

function invocation(bundle, turnId, toolCallId, prompt = "review targets") {
  return {
    sessionId: SESSION,
    turnId,
    toolCallId,
    actor: { id: ACTOR, messageId: "message-1" },
    ingress: { prompt },
    profileDigest: bundle.profileDigest,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-practice-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(join(workspaceDir, "src"), { recursive: true });
  await writeFile(join(workspaceDir, "a.txt"), "alpha\n");
  await writeFile(join(workspaceDir, "b.txt"), "beta\n");
  await writeFile(join(workspaceDir, "src", "one.mjs"), "one\n");
  await writeFile(join(workspaceDir, "src", "two.mjs"), "two\n");
  const bundle = await profile();
  const paths = statePathsForSession({ stateDirectory, sessionId: SESSION });
  const artifactStore = new CapturedArtifactStore({ stateDirectory, sessionId: SESSION });
  const options = {
    sessionId: SESSION,
    workspaceDir,
    profileBundle: bundle,
    journalPath: paths.practiceRunJournalPath,
    snapshotPath: paths.practiceRunSnapshotPath,
    protectedDirectory: paths.practiceRunProtectedDirectory,
    artifactStore,
  };
  return {
    root, workspaceDir, stateDirectory, bundle, paths, artifactStore, options,
    service: new PracticeRunService(options),
  };
}

const fileTarget = (path) => ({ kind: "file", path });
const directoryTarget = (path = "src") => ({
  kind: "directory_snapshot",
  path,
  selection: { includePrefixes: ["."], excludePrefixes: [] },
});
const startParams = (targets = [fileTarget("a.txt")]) => ({
  practiceId: "review",
  objective: "Review the exact target snapshots",
  acceptanceCriteria: ["Every target is addressed"],
  targets,
});

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("v2 start, append-only extension, abandonment, replay, and later run preserve target authority", async (t) => {
  const f = await fixture(t);
  const firstInvocation = invocation(f.bundle, "turn-1", "call-1");
  const started = await f.service.start(startParams([fileTarget("a.txt"), directoryTarget()]), firstInvocation);
  assert.equal(started.run.schemaVersion, 2);
  assert.equal(started.run.practiceVersion, 2);
  assert.equal(started.run.scope.revision, 1);
  assert.deepEqual(started.run.scope.targets.map((target) => target.kind), ["file", "directory_snapshot"]);
  assert.equal(started.run.scope.targets.every((target) => target.targetId.startsWith("target-")), true);
  assert.equal(started.run.scope.targets[1].snapshot.artifacts.length, 1);

  const replay = await f.service.start(startParams([fileTarget("a.txt"), directoryTarget()]), firstInvocation);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.run.scope.targets, started.run.scope.targets);

  const extended = await f.service.extend({ targets: [fileTarget("b.txt")] }, invocation(f.bundle, "turn-2", "call-2"));
  assert.equal(extended.run.scope.revision, 2);
  assert.deepEqual(extended.run.scope.targets.slice(0, 2), started.run.scope.targets);
  assert.equal(extended.run.scope.targets[2].descriptor.value.path, "b.txt");

  const abandoned = await f.service.abandon(
    { reasonCode: "user_cancelled", summary: "Requester cancelled this exact run." },
    invocation(f.bundle, "turn-3", "call-3"),
  );
  assert.equal(abandoned.run.status, "abandoned");
  const later = await f.service.start(startParams([fileTarget("b.txt")]), invocation(f.bundle, "turn-4", "call-4"));
  assert.notEqual(later.run.runId, started.run.runId);
  assert.notEqual(later.run.scope.targets[0].targetId, started.run.scope.targets[0].targetId);
});

test("journal and derived snapshot contain bounded target metadata but no protected prose or manifest bytes", async (t) => {
  const f = await fixture(t);
  await f.service.start(startParams([directoryTarget()]), invocation(f.bundle, "turn-1", "call-1", "private ingress prose"));
  const journal = await readFile(f.paths.practiceRunJournalPath, "utf8");
  const snapshot = await readFile(f.paths.practiceRunSnapshotPath, "utf8");
  assert.match(journal, /"schemaVersion":2/u);
  assert.match(journal, /"directory_snapshot"/u);
  assert.match(journal, /"artifactRef"/u);
  assert.doesNotMatch(journal, /private ingress prose|Review the exact target snapshots|"members"/u);
  assert.doesNotMatch(snapshot, /private ingress prose|Review the exact target snapshots|"members"/u);
  const protectedFiles = await Promise.all([
    readFile(join(f.paths.practiceRunProtectedDirectory, "requests", `${(await f.service.latestForActor(ACTOR)).origin.requestDigest}.json`), "utf8").catch(() => ""),
  ]);
  assert.equal(protectedFiles.join("").includes("private ingress prose"), true);
});

test("lexical admission is pre-Gate and physical capture is deferred until commit", async (t) => {
  const f = await fixture(t);
  const prepared = await f.service.prepareStart(startParams([fileTarget("missing.txt")]), invocation(f.bundle, "turn-1", "call-1"));
  assert.equal(prepared.operation.input.targetRequests[0].path, "missing.txt");
  await expectCode(f.service.commitStart(prepared), "TARGET_NOT_FOUND");
  assert.equal((await f.service.state()).sequence, 0);

  for (const [target, code] of [
    [{ kind: "file", path: "../outside" }, "TARGET_OUTSIDE_WORKSPACE"],
    [{ kind: "file", path: ".env" }, "TARGET_SENSITIVE_PATH_DENIED"],
    [{ kind: "commit", repositoryPath: ".", ref: "main", pathPrefixes: ["."] }, "GIT_REF_INVALID"],
    [{ kind: "file", path: "a.txt", extra: true }, "INVALID_TARGET"],
  ]) await expectCode(f.service.prepareStart(startParams([target]), invocation(f.bundle, `turn-${code}`, `call-${code}`)), code);

  await expectCode(f.service.prepareStart(startParams([fileTarget("a.txt"), fileTarget("./a.txt")]), invocation(f.bundle, "turn-d", "call-d")), "SCOPE_TARGET_ALREADY_PRESENT");
});

test("scope CAS rejects a stale prepared extension without partial target append", async (t) => {
  const f = await fixture(t);
  await f.service.start(startParams(), invocation(f.bundle, "turn-1", "call-1"));
  const stale = await f.service.prepareExtend({ targets: [fileTarget("b.txt")] }, invocation(f.bundle, "turn-2", "call-2"));
  await f.service.extend({ targets: [directoryTarget()] }, invocation(f.bundle, "turn-3", "call-3"));
  await expectCode(f.service.commitExtend(stale), "STALE_RUN_REVISION");
  const run = await f.service.activeForActor(ACTOR);
  assert.deepEqual(run.scope.targets.map((target) => target.kind), ["file", "directory_snapshot"]);
});

test("independent services serialize one state invocation and exact replay", async (t) => {
  const f = await fixture(t);
  const other = new PracticeRunService(f.options);
  const params = startParams();
  const call = invocation(f.bundle, "turn-1", "call-1");
  const [left, right] = await Promise.all([f.service.start(params, call), other.start(params, call)]);
  assert.equal([left.replayed, right.replayed].filter(Boolean).length, 1);
  assert.equal((await f.service.state()).sequence, 1);
});

test("snapshot loss rebuilds, journal v1 is unsupported, and journal corruption fails closed", async (t) => {
  const f = await fixture(t);
  await f.service.start(startParams(), invocation(f.bundle, "turn-1", "call-1"));
  await unlink(f.paths.practiceRunSnapshotPath);
  const recovered = new PracticeRunService(f.options);
  assert.equal((await recovered.activeForActor(ACTOR)).scope.targets.length, 1);
  assert.match(await readFile(f.paths.practiceRunSnapshotPath, "utf8"), /"schemaVersion":2/u);

  const old = await fixture(t);
  await mkdir(old.paths.practiceRunDirectory, { recursive: true });
  await writeFile(old.paths.practiceRunJournalPath, '{"schemaVersion":1}\n', { mode: 0o600 });
  await expectCode(new PracticeRunService(old.options).state(), "UNSUPPORTED_STATE_SCHEMA");

  await writeFile(f.paths.practiceRunJournalPath, `${await readFile(f.paths.practiceRunJournalPath, "utf8")}{`);
  await expectCode(new PracticeRunService(f.options).state(), "STATE_CORRUPTED");
});

test("journal/protected symlinks fail closed while a symlinked derived snapshot is rebuilt", async (t) => {
  const journalFixture = await fixture(t);
  await mkdir(journalFixture.paths.practiceRunDirectory, { recursive: true });
  const external = join(journalFixture.root, "external");
  await writeFile(external, "");
  await symlink(external, journalFixture.paths.practiceRunJournalPath);
  await expectCode(journalFixture.service.state(), "STATE_CORRUPTED");

  const snapshotFixture = await fixture(t);
  await snapshotFixture.service.start(startParams(), invocation(snapshotFixture.bundle, "turn-1", "call-1"));
  await unlink(snapshotFixture.paths.practiceRunSnapshotPath);
  await symlink(external, snapshotFixture.paths.practiceRunSnapshotPath);
  assert.equal((await new PracticeRunService(snapshotFixture.options).state()).sequence, 1);
});

test("state-transition tools use v2 Gate, wrapper Evidence, replay, and target telemetry", async (t) => {
  const f = await fixture(t);
  const evidence = new EvidenceRecorder({ filePath: f.paths.evidenceFilePath });
  const gate = new ReviewerPracticeGate({ profileBundle: f.bundle });
  let current;
  const registry = createReviewerStateToolRegistry({ service: f.service, gate, evidence, getInvocation: () => current });
  const start = registry.definitions().find((tool) => tool.name === "start_work");
  const checkpoints = [];
  current = {
    ...invocation(f.bundle, "turn-1", "call-placeholder"),
    turnState: { decisionFor() { return undefined; } },
    observability: {
      checkpoint(name, attributes) { checkpoints.push({ name, attributes }); },
      startOperation() { return { end() {} }; },
    },
  };
  const params = startParams();
  const first = await start.execute("call-1", params);
  const replay = await start.execute("call-1", params);
  assert.equal(first.details.scopeTargets.length, 1);
  assert.equal(replay.details.replayed, true);
  assert.equal(start.executionMode, "sequential");
  assert.equal(checkpoints.some((entry) => entry.attributes?.["tiangong.practice.target_count"] === 1), true);
  assert.equal((await evidence.readAll()).some((record) => record.operation?.policyVersion === "practice-run-v2"), true);
});
