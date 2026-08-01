#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CapturedArtifactStore } from "/opt/tiangong-worker/agent/artifacts/store.mjs";
import { sha256 } from "/opt/tiangong-worker/agent/canonical-json.mjs";
import { evidenceBoundary, projectReviewEvidence } from "/opt/tiangong-worker/agent/evidence/projection.mjs";
import { EvidenceRecorder } from "/opt/tiangong-worker/agent/evidence/recorder.mjs";
import { PracticeRunStore } from "/opt/tiangong-worker/agent/practices/practice-run-store.mjs";
import { ProtectedPayloadStore } from "/opt/tiangong-worker/agent/practices/protected-payload-store.mjs";
import { projectReviewReadCoverage } from "/opt/tiangong-worker/agent/practices/review-read-coverage.mjs";
import { ReviewTargetCapture } from "/opt/tiangong-worker/agent/practices/review-targets.mjs";

import { validateReadExecutions } from "./reviewer-oracle-policy.mjs";

function fail(message) { throw new Error(`Reviewer smoke oracle failed: ${message}`); }

const [
  journalPath,
  snapshotPath,
  evidencePath,
  stateDirectory,
  workspaceDir,
  expectedA,
  digestAOne,
  digestATwo,
  expectedB,
  digestBOne,
  digestBTwo,
  expectedStatus,
  expectedScopeRevisionText,
  expectedScopeCountText,
  readPhase,
] = process.argv.slice(2);

if (!journalPath || !snapshotPath || !evidencePath || !stateDirectory || !workspaceDir || !expectedA
    || !digestAOne || !digestATwo || !expectedB || !digestBOne || !digestBTwo
    || !["active", "done"].includes(expectedStatus)
    || !["a-only", "all", "all-at-least-once", "safe-active"].includes(readPhase)) fail("invalid arguments");
const expectedScopeRevision = Number(expectedScopeRevisionText);
const expectedScopeCount = Number(expectedScopeCountText);
if (!Number.isSafeInteger(expectedScopeRevision) || !Number.isSafeInteger(expectedScopeCount)) fail("invalid scope values");

const evidence = new EvidenceRecorder({ filePath: evidencePath });
const records = await evidence.readAll();
const sessionIds = new Set(records.map((record) => record.sessionId).filter(Boolean));
if (sessionIds.size !== 1) fail("Evidence must identify exactly one session");
const sessionId = [...sessionIds][0];
const artifactStore = new CapturedArtifactStore({ stateDirectory, sessionId });
const targetCapture = new ReviewTargetCapture({ workspaceDir, artifactStore });
const store = new PracticeRunStore({ filePath: journalPath, snapshotPath, sessionId });
const state = await store.state();
const runs = Object.values(state.runs);
if (runs.length !== 1) fail("expected exactly one PracticeRun");
const run = runs[0];
if (run.status !== expectedStatus || run.scope.revision !== expectedScopeRevision
    || run.scope.targets.length !== expectedScopeCount) fail("PracticeRun status or target scope does not match");
const expectedPaths = expectedB === "-" ? [expectedA] : [expectedA, expectedB];
if (JSON.stringify(run.scope.targets.map((target) => target.descriptor.value.path)) !== JSON.stringify(expectedPaths)
    || run.scope.targets.some((target) => target.kind !== "directory_snapshot"
      || JSON.stringify(target.descriptor.value.selection.includePrefixes) !== JSON.stringify(["."])
      || JSON.stringify(target.descriptor.value.selection.excludePrefixes) !== JSON.stringify(["excluded"]))) {
  fail("target order, kind, or normalized selection changed");
}

const journalText = await readFile(journalPath, "utf8");
if (journalText !== "" && !journalText.endsWith("\n")) fail("journal has a partial record");
const journal = journalText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const started = journal.filter((record) => record.eventType === "run.started");
const revised = journal.filter((record) => record.eventType === "scope.revised");
const evaluated = journal.filter((record) => record.eventType === "checkpoint.evaluated");
const completed = journal.filter((record) => record.eventType === "run.completed");
if (started.length !== 1 || revised.length !== expectedScopeRevision - 1) fail("run or target transition count is invalid");
if (expectedStatus === "done") {
  if (evaluated.length !== 0 || completed.length !== 1 || !run.lastCheckpoint?.allSatisfied) fail("completion transition is invalid");
} else if (evaluated.length !== 0 || completed.length !== 0 || run.lastCheckpoint !== null) {
  fail("active run unexpectedly has checkpoint state");
}

const boundary = expectedStatus === "done" ? {
  sequence: run.lastCheckpoint.evidenceTerminalSequence,
  hash: run.lastCheckpoint.evidenceTerminalHash,
} : await evidenceBoundary(evidence);
const projection = await projectReviewEvidence({ evidence, boundary, run, targetCapture, artifactStore });
if (projection.executions.some((execution) => ["write", "edit", "bash"].includes(execution.toolName))
    || records.some((record) => ["write", "edit", "bash"].includes(record.toolName))) {
  fail("mutation tool appeared in Reviewer Evidence");
}
const evidenceWire = JSON.stringify(records);
if (evidenceWire.includes("artifact-v1/")) fail("raw Artifact ref leaked into Evidence");
if (evidenceWire.includes("harmless-reviewer-basic")) fail("raw directory query leaked into Evidence");

const digestPairs = expectedB === "-"
  ? [[digestAOne, digestATwo]] : [[digestAOne, digestATwo], [digestBOne, digestBTwo]];
const targets = run.scope.targets.map((target, index) => ({
  targetId: target.targetId,
  resources: ["one.txt", "two.txt"].map((memberPath, memberIndex) => ({
    memberPath,
    contentDigest: digestPairs[index][memberIndex],
  })),
}));
for (const target of targets) {
  const actual = projection.resources.filter((resource) => resource.targetId === target.targetId)
    .map((resource) => ({ memberPath: resource.memberPath, contentDigest: resource.contentDigest }));
  if (JSON.stringify(actual) !== JSON.stringify(target.resources)) fail("manifest resources or digests differ from fixtures");
}
const readExecutions = projection.executions.filter((execution) => execution.toolName === "read");
let readValidation;
try { readValidation = validateReadExecutions({ targets, readPhase, executions: readExecutions }); }
catch (error) { fail(error.message); }
const coverage = projectReviewReadCoverage(run, projection);
if (expectedStatus === "done" && !coverage.satisfied) fail("done run does not have complete target coverage");
const inspections = projection.executions.filter((execution) => execution.toolName === "inspect_directory" && execution.status === "success");
if (expectedStatus === "done" && expectedScopeCount === 1) {
  if (!inspections.some((entry) => entry.resultMetadata.action === "list")
      || !inspections.some((entry) => entry.resultMetadata.action === "search")) {
    fail("Basic directory exploration Evidence is incomplete");
  }
}

let checkpointScopeDigest = null;
if (expectedStatus === "done") {
  const payloads = new ProtectedPayloadStore({ directory: join(dirname(journalPath), "protected") });
  const claim = await payloads.read("claim", run.lastCheckpoint.claimPayloadRef);
  const targetIds = run.scope.targets.map((target) => target.targetId);
  if (JSON.stringify(claim.scope.targetIds) !== JSON.stringify(targetIds)) fail("claim does not match final target scope");
  const completion = completed[0];
  if (completion.operation.input.finalScopeDigest !== run.scope.digest) fail("checkpoint operation does not bind final scope digest");
  checkpointScopeDigest = completion.operation.input.finalScopeDigest;
}

const startRecord = started[0];
process.stdout.write(`${JSON.stringify({
  schemaVersion: 2,
  status: run.status,
  runId: run.runId,
  runRevision: run.revision,
  scopeRevision: run.scope.revision,
  scopeDigest: run.scope.digest,
  scopeTargetCount: run.scope.targets.length,
  targetIds: run.scope.targets.map((target) => target.targetId),
  snapshotIdentities: run.scope.targets.map((target) => target.snapshot.identity),
  objectiveDigest: startRecord.operation.input.objectiveDigest,
  criteriaDigest: sha256(startRecord.operation.input.criteria.map((criterion) => criterion.digest)),
  profileDigest: run.profileDigest,
  practiceTerminalHash: state.terminalHash,
  evidenceTerminalHash: projection.boundary.hash,
  evidenceTerminalSequence: projection.boundary.sequence,
  runStartedCount: started.length,
  scopeRevisedCount: revised.length,
  runCompletedCount: completed.length,
  readExecutionCount: readExecutions.length,
  inspectionExecutionCount: inspections.length,
  readCountA: readValidation.readCountA,
  readCountB: readValidation.readCountB,
  checkpoint: run.lastCheckpoint?.allSatisfied ? "passed" : "not-run",
  checkpointScopeDigest,
})}\n`);
