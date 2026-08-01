import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapturedArtifactStore } from "../agent/artifacts/store.mjs";
import { loadRoleProfileBundle } from "../agent/config/role-profile.mjs";
import { evidenceBoundary, projectReviewEvidence } from "../agent/evidence/projection.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { ReviewerPracticeGate } from "../agent/gates/reviewer-practice-gate.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import { PracticeRunService } from "../agent/practices/practice-run-service.mjs";
import { deriveReviewNextAction } from "../agent/practices/review-next-action.mjs";
import { projectReviewReadCoverage } from "../agent/practices/review-read-coverage.mjs";
import { createReviewerToolRegistry } from "../agent/work/reviewer-tools.mjs";
import { completedReviewTargetFacts, renderCompletedReview, workStatusForRun } from "../agent/work/status.mjs";

const WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SESSION = "reviewer-v2-slice";
const ACTOR = "@reviewer:example.test";

async function fixture(t, { evidenceOverride } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-reviewer-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(join(workspaceDir, "src", "generated"), { recursive: true });
  await writeFile(join(workspaceDir, "a.txt"), "alpha\nbeta\n");
  await writeFile(join(workspaceDir, "src", "one.mjs"), "export const one = 1;\n");
  await writeFile(join(workspaceDir, "src", "two.mjs"), "export const two = 2;\n");
  await writeFile(join(workspaceDir, "src", "generated", "ignored.mjs"), "ignored\n");
  const profileBundle = await loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", "reviewer.json"), resourceRoot: WORKER_ROOT,
  });
  const paths = statePathsForSession({ stateDirectory, sessionId: SESSION });
  const artifactStore = new CapturedArtifactStore({ stateDirectory, sessionId: SESSION });
  const options = {
    sessionId: SESSION,
    workspaceDir,
    profileBundle,
    journalPath: paths.practiceRunJournalPath,
    snapshotPath: paths.practiceRunSnapshotPath,
    protectedDirectory: paths.practiceRunProtectedDirectory,
    artifactStore,
  };
  const service = new PracticeRunService(options);
  const evidence = evidenceOverride ?? new EvidenceRecorder({ filePath: paths.evidenceFilePath });
  const gate = new ReviewerPracticeGate({ profileBundle });
  let current;
  const registry = createReviewerToolRegistry({
    service, gate, evidence, getInvocation: () => current, inspectionLockPath: paths.directoryInspectionLockPath,
  });
  const tool = (name) => registry.definitions().find((entry) => entry.name === name);
  function begin(turnId, messageId = "message-1") {
    current = {
      sessionId: SESSION,
      turnId,
      actor: { id: ACTOR, messageId },
      ingress: { prompt: "review the exact targets" },
      profileDigest: profileBundle.profileDigest,
      turnState: { decisionFor() { return undefined; } },
    };
  }
  return { root, workspaceDir, stateDirectory, profileBundle, paths, artifactStore, options, service, evidence, registry, tool, begin };
}

function startTargets() {
  return {
    practiceId: "review",
    objective: "Review file and directory snapshots",
    acceptanceCriteria: ["Inspect all target resources"],
    targets: [
      { kind: "file", path: "a.txt" },
      {
        kind: "directory_snapshot",
        path: "src",
        selection: { includePrefixes: ["."], excludePrefixes: ["generated"] },
      },
    ],
  };
}

async function projection(f, run, boundary = undefined) {
  return projectReviewEvidence({
    evidence: f.evidence,
    boundary: boundary ?? await evidenceBoundary(f.evidence),
    run,
    targetCapture: f.service.targetCapture,
    artifactStore: f.artifactStore,
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("six-tool Reviewer v2 proves directory inspection is exploration and target-bound reads complete every resource", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.registry.names(), [
    "start_work", "extend_scope", "read", "inspect_directory", "check_completion", "abandon_work",
  ]);
  f.begin("turn-start");
  const started = await f.tool("start_work").execute("call-start", startTargets());
  const [file, directory] = started.details.scopeTargets;
  assert.match(started.content[0].text, new RegExp(file.targetId, "u"));
  assert.match(started.content[0].text, new RegExp(directory.targetId, "u"));
  assert.doesNotMatch(started.content[0].text, /artifact-v1|snapshotIdentity|a\.txt|src/u);

  f.begin("turn-list");
  const listed = await f.tool("inspect_directory").execute("call-list", {
    targetId: directory.targetId, action: "list", prefix: ".", offset: 0, limit: 200,
  });
  const list = JSON.parse(listed.content[0].text);
  assert.deepEqual(list.members.map((member) => member.path), ["one.mjs", "two.mjs"]);
  assert.equal(list.members.some((member) => Object.hasOwn(member, "contentDigest")), false);

  const secretQuery = "export const two";
  f.begin("turn-search");
  const searched = await f.tool("inspect_directory").execute("call-search", {
    targetId: directory.targetId, action: "search", prefix: ".", query: secretQuery, maxResults: 10,
  });
  assert.deepEqual(JSON.parse(searched.content[0].text).matches, [{ memberPath: "two.mjs", line: 1 }]);
  const run = await f.service.activeForActor(ACTOR);
  let projected = await projection(f, run);
  let coverage = projectReviewReadCoverage(run, projected);
  assert.deepEqual(coverage.targets.map((entry) => entry.status), ["unread", "unread"]);
  assert.equal(projected.executions.filter((entry) => entry.toolName === "inspect_directory").length, 2);
  const inspectionEvidenceWire = JSON.stringify(await f.evidence.readAll());
  assert.equal(inspectionEvidenceWire.includes(secretQuery), false);
  assert.equal(inspectionEvidenceWire.includes("two.mjs"), false);
  assert.equal(inspectionEvidenceWire.includes("artifact-v1/"), false);

  f.begin("turn-file");
  await f.tool("read").execute("call-file", { targetId: file.targetId, offset: 1, limit: 2000 });
  for (const memberPath of ["one.mjs", "two.mjs"]) {
    f.begin(`turn-${memberPath}`);
    await f.tool("read").execute(`call-${memberPath}`, {
      targetId: directory.targetId, memberPath, offset: 1, limit: 2000,
    });
  }
  projected = await projection(f, run);
  coverage = projectReviewReadCoverage(run, projected);
  assert.equal(coverage.satisfied, true);
  assert.equal(coverage.selectedEventRefs.length, 6);
  assert.equal(deriveReviewNextAction({ run, coverage, evidenceProjection: projected }).code, "CHECK_COMPLETION");

  f.begin("turn-complete");
  const completed = await f.tool("check_completion").execute("call-complete", {
    completionClaim: {
      criteriaResults: [{ criterionId: "criterion-1", status: "addressed", explanation: "All resources were read." }],
      scope: { targetIds: [file.targetId, directory.targetId] },
      report: {
        outcome: "accept",
        synopsis: "Static review completed.",
        observations: [{
          level: "note",
          target: { targetId: directory.targetId, memberPath: "two.mjs", lineStart: 1, lineEnd: 1 },
          statement: "The second module is present.", rationale: "Snapshot-matching text was consumed.",
          suggestedAction: "Keep it reviewed.", confidence: "high",
        }],
        limitations: [{ code: "STATIC_REVIEW_ONLY", detail: "No tests or runtime commands were executed." }],
        nextActions: [],
      },
    },
  });
  assert.equal(completed.details.checkpointPassed, true);
  const done = await f.service.latestForActor(ACTOR);
  assert.equal(done.status, "done");
  const reportProjection = await projection(f, done, {
    sequence: done.lastCheckpoint.evidenceTerminalSequence,
    hash: done.lastCheckpoint.evidenceTerminalHash,
  });
  const report = renderCompletedReview({
    run: done,
    claim: await f.service.claimForRun(done),
    targetFacts: completedReviewTargetFacts(done, reportProjection),
  });
  assert.match(report, new RegExp(directory.targetId, "u"));
  assert.doesNotMatch(report, /artifact-v1|directory_manifest/u);
  assert.equal(workStatusForRun(done).scopeTargetCount, 2);
});

test("directory admission enforces exclusion, sensitive, symlink, hardlink, binary, UTF-8, and atomic array boundaries", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspaceDir, "src", ".env"), "secret\n");
  f.begin("excluded");
  const safe = await f.tool("start_work").execute("call-excluded", {
    ...startTargets(),
    targets: [{
      kind: "directory_snapshot", path: "src",
      selection: { includePrefixes: ["."], excludePrefixes: [".env", "generated"] },
    }],
  });
  assert.equal(safe.details.scopeTargets.length, 1);
  f.begin("abandon");
  await f.tool("abandon_work").execute("call-abandon", { reasonCode: "other", summary: "next cases" });
  await rm(join(f.workspaceDir, "src", ".env"));

  const cases = [];
  await symlink("one.mjs", join(f.workspaceDir, "src", "link.mjs"));
  cases.push(["TARGET_SYMLINK_DENIED", "link"]);
  await rm(join(f.workspaceDir, "src", "link.mjs"));
  await link(join(f.workspaceDir, "src", "one.mjs"), join(f.workspaceDir, "src", "hard.mjs"));
  cases.push(["TARGET_TYPE_UNSUPPORTED", "hard"]);
  await rm(join(f.workspaceDir, "src", "hard.mjs"));
  await writeFile(join(f.workspaceDir, "src", "binary"), Buffer.from([0, 1]));
  cases.push(["TARGET_TYPE_UNSUPPORTED", "binary"]);
  await rm(join(f.workspaceDir, "src", "binary"));
  await writeFile(join(f.workspaceDir, "src", "invalid"), Buffer.from([0xff]));
  cases.push(["TARGET_TYPE_UNSUPPORTED", "invalid"]);
  await rm(join(f.workspaceDir, "src", "invalid"));
  cases.push(["TARGET_SENSITIVE_PATH_DENIED", "sensitive"]);

  for (const [code, name] of cases) {
    if (name === "link") await symlink("one.mjs", join(f.workspaceDir, "src", "link.mjs"));
    if (name === "hard") await link(join(f.workspaceDir, "src", "one.mjs"), join(f.workspaceDir, "src", "hard.mjs"));
    if (name === "binary") await writeFile(join(f.workspaceDir, "src", "binary"), Buffer.from([0]));
    if (name === "invalid") await writeFile(join(f.workspaceDir, "src", "invalid"), Buffer.from([0xff]));
    if (name === "sensitive") await writeFile(join(f.workspaceDir, "src", ".env"), "secret\n");
    f.begin(`case-${name}`);
    await expectCode(f.tool("start_work").execute(`call-${name}`, {
      ...startTargets(), targets: [{ kind: "directory_snapshot", path: "src", selection: { includePrefixes: ["."], excludePrefixes: ["generated"] } }],
    }), code);
    await rm(join(f.workspaceDir, "src", name === "link" ? "link.mjs" : name === "hard" ? "hard.mjs" : name === "sensitive" ? ".env" : name));
  }
  assert.equal((await f.service.state()).sequence, 2);

  f.begin("atomic");
  await expectCode(f.tool("start_work").execute("call-atomic", {
    ...startTargets(), targets: [{ kind: "directory_snapshot", path: "src", selection: { includePrefixes: ["one.mjs"], excludePrefixes: [] } }, { kind: "file", path: "missing" }],
  }), "TARGET_NOT_FOUND");
  assert.equal((await f.service.state()).activeRunId, null);
});

test("consume and inspection selectors use their stable range and grammar errors", async (t) => {
  const f = await fixture(t);
  f.begin("start");
  const started = await f.tool("start_work").execute("call-start", startTargets());
  const [file, directory] = started.details.scopeTargets;
  f.begin("bad-range");
  await expectCode(f.tool("read").execute("call-bad-range", {
    targetId: file.targetId, offset: 0, limit: 1,
  }), "TARGET_RANGE_INVALID");
  f.begin("bad-member");
  await expectCode(f.tool("read").execute("call-bad-member", {
    targetId: directory.targetId, memberPath: "a".repeat(1025), offset: 1, limit: 1,
  }), "TARGET_SELECTOR_INVALID");
  f.begin("bad-prefix");
  await expectCode(f.tool("inspect_directory").execute("call-bad-prefix", {
    targetId: directory.targetId, action: "list", prefix: "a".repeat(1025), offset: 0, limit: 1,
  }), "TARGET_SELECTOR_INVALID");
});

test("source change blocks an incomplete target but cannot revoke historical complete Evidence", async (t) => {
  const f = await fixture(t);
  f.begin("start");
  const started = await f.tool("start_work").execute("call-start", {
    ...startTargets(), targets: [{ kind: "file", path: "a.txt" }, { kind: "file", path: "src/one.mjs" }],
  });
  const [complete, incomplete] = started.details.scopeTargets;
  f.begin("read-complete");
  await f.tool("read").execute("call-read-complete", { targetId: complete.targetId, offset: 1, limit: 2000 });
  await writeFile(join(f.workspaceDir, "a.txt"), "changed\n");
  f.begin("read-complete-again");
  await expectCode(f.tool("read").execute("call-read-complete-again", { targetId: complete.targetId, offset: 1, limit: 2000 }), "TARGET_CHANGED");
  await rm(join(f.workspaceDir, "src", "one.mjs"));
  f.begin("read-missing");
  await expectCode(f.tool("read").execute("call-read-missing", { targetId: incomplete.targetId, offset: 1, limit: 2000 }), "TARGET_UNAVAILABLE");
  await writeFile(join(f.workspaceDir, "src", "one.mjs"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  f.begin("read-oversized");
  await expectCode(f.tool("read").execute("call-read-oversized", {
    targetId: incomplete.targetId, offset: 1, limit: 2000,
  }), "TARGET_CHANGED");
  const run = await f.service.activeForActor(ACTOR);
  const coverage = projectReviewReadCoverage(run, await projection(f, run));
  assert.deepEqual(coverage.targets.map((entry) => [entry.status, entry.reasonCode]), [
    ["complete", null], ["blocked", "TARGET_CHANGED"],
  ]);
  assert.equal(deriveReviewNextAction({ run, coverage, evidenceProjection: await projection(f, run) }).code, "RESOLVE_TARGET_BLOCKER");
});

test("an exact failed read invocation may retry once and later durable replay its successful Artifact", async (t) => {
  const f = await fixture(t);
  f.begin("start");
  const started = await f.tool("start_work").execute("call-start", {
    ...startTargets(), targets: [{ kind: "file", path: "a.txt" }],
  });
  const targetId = started.details.scopeTargets[0].targetId;
  await writeFile(join(f.workspaceDir, "a.txt"), "changed\n");
  f.begin("retry-read");
  await expectCode(f.tool("read").execute("call-read", {
    targetId, offset: 1, limit: 2000,
  }), "TARGET_CHANGED");
  await writeFile(join(f.workspaceDir, "a.txt"), "alpha\nbeta\n");
  f.begin("retry-read");
  const successful = await f.tool("read").execute("call-read", {
    targetId, offset: 1, limit: 2000,
  });
  const run = await f.service.activeForActor(ACTOR);
  const projected = await projection(f, run);
  assert.equal(projected.executions.length, 1);
  assert.equal(projected.executions[0].status, "success");
  assert.equal(projectReviewReadCoverage(run, projected).satisfied, true);
  await rm(join(f.workspaceDir, "a.txt"));
  f.begin("retry-read");
  const replayed = await f.tool("read").execute("call-read", {
    targetId, offset: 1, limit: 2000,
  });
  assert.deepEqual(replayed, successful);
});

test("restart rebuilds journal targets and manifest authority without transcript or live recapture", async (t) => {
  const f = await fixture(t);
  f.begin("start");
  const started = await f.tool("start_work").execute("call-start", startTargets());
  const before = await f.service.activeForActor(ACTOR);
  await rm(f.paths.practiceRunSnapshotPath, { force: true });
  await rm(join(f.workspaceDir, "src", "one.mjs"));
  const restarted = new PracticeRunService(f.options);
  const recovered = await restarted.activeForActor(ACTOR);
  assert.deepEqual(recovered.scope.targets, before.scope.targets);
  assert.equal(recovered.scope.digest, before.scope.digest);
  const manifest = await restarted.targetCapture.readDirectoryManifest(recovered.scope.targets[1]);
  assert.deepEqual(manifest.members.map((member) => member.path), ["one.mjs", "two.mjs"]);
  assert.equal(started.details.scopeTargets[1].targetId, recovered.scope.targets[1].targetId);
});

test("manifest or consumed Artifact tamper fails before Context/coverage and never recaptures", async (t) => {
  const f = await fixture(t);
  f.begin("start");
  await f.tool("start_work").execute("call-start", startTargets());
  const run = await f.service.activeForActor(ACTOR);
  const manifestBinding = run.scope.targets[1].snapshot.artifacts[0];
  await writeFile(join(f.paths.capturedArtifactObjectsDirectory, manifestBinding.artifactKey, "content"), "{}", { mode: 0o600 });
  await expectCode(f.service.targetCapture.readDirectoryManifest(run.scope.targets[1]), "TARGET_ARTIFACT_INVALID");
  await expectCode(projection(f, run), "TARGET_ARTIFACT_INVALID");
});

test("successful read and inspection replay exact Store bytes after run completion without live source access", async (t) => {
  const f = await fixture(t);
  f.begin("start");
  const started = await f.tool("start_work").execute("call-start", {
    ...startTargets(), targets: [{ kind: "file", path: "a.txt" }],
  });
  const targetId = started.details.scopeTargets[0].targetId;
  f.begin("read");
  const first = await f.tool("read").execute("call-read", { targetId, offset: 1, limit: 2000 });
  f.begin("complete");
  await f.tool("check_completion").execute("call-complete", {
    completionClaim: {
      criteriaResults: [{ criterionId: "criterion-1", status: "addressed", explanation: "read" }],
      scope: { targetIds: [targetId] },
      report: { outcome: "accept", synopsis: "done", observations: [], limitations: [{ code: "STATIC_REVIEW_ONLY", detail: "static" }], nextActions: [] },
    },
  });
  await rm(join(f.workspaceDir, "a.txt"));
  f.begin("read");
  const replay = await f.tool("read").execute("call-read", { targetId, offset: 1, limit: 2000 });
  assert.equal(replay.content[0].text, first.content[0].text);
  assert.deepEqual(replay, first);
  const replayEvents = (await f.evidence.readAll()).filter((record) => record.type === "tool.execution.replayed" && record.toolName === "read");
  assert.equal(replayEvents.length, 1);
});

test("inspection lifecycle cap is durable and the 65th target inspection writes no successful artifact Evidence", async (t) => {
  const f = await fixture(t);
  f.begin("start");
  const started = await f.tool("start_work").execute("call-start", {
    ...startTargets(), targets: [{ kind: "directory_snapshot", path: "src", selection: { includePrefixes: ["one.mjs"], excludePrefixes: [] } }],
  });
  const targetId = started.details.scopeTargets[0].targetId;
  for (let index = 0; index < 64; index += 1) {
    f.begin(`inspect-${index}`);
    await f.tool("inspect_directory").execute(`call-${index}`, { targetId, action: "list", prefix: ".", offset: 0, limit: 1 });
  }
  f.begin("inspect-65");
  await expectCode(f.tool("inspect_directory").execute("call-65", { targetId, action: "list", prefix: ".", offset: 0, limit: 1 }), "DIRECTORY_INSPECTION_LIMIT_EXCEEDED");
  const records = await f.evidence.readAll();
  assert.equal(records.filter((record) => record.status === "success" && record.metadata?.reviewDirectoryInspection).length, 64);
});
