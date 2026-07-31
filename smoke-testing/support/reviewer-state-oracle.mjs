#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "/opt/tiangong-worker/agent/canonical-json.mjs";
import { evidenceBoundary, projectReviewEvidence } from "/opt/tiangong-worker/agent/evidence/projection.mjs";
import { EvidenceRecorder } from "/opt/tiangong-worker/agent/evidence/recorder.mjs";
import { PracticeRunStore } from "/opt/tiangong-worker/agent/practices/practice-run-store.mjs";
import { ProtectedPayloadStore } from "/opt/tiangong-worker/agent/practices/protected-payload-store.mjs";

import { validateReadExecutions } from "./reviewer-oracle-policy.mjs";

function fail(message) {
  throw new Error(`Reviewer smoke oracle failed: ${message}`);
}

const [
  journalPath,
  snapshotPath,
  evidencePath,
  expectedA,
  expectedDigestA,
  expectedB,
  expectedDigestB,
  expectedStatus,
  expectedScopeRevisionText,
  expectedScopeCountText,
  readPhase,
] = process.argv.slice(2);

if (!journalPath || !snapshotPath || !evidencePath || !expectedA || !expectedDigestA ||
    !expectedB || !expectedDigestB || !["active", "done"].includes(expectedStatus) ||
    !["a-only", "all", "all-at-least-once", "safe-active"].includes(readPhase)) {
  fail("invalid arguments");
}
const expectedScopeRevision = Number(expectedScopeRevisionText);
const expectedScopeCount = Number(expectedScopeCountText);
if (!Number.isSafeInteger(expectedScopeRevision) || !Number.isSafeInteger(expectedScopeCount)) {
  fail("invalid expected scope values");
}

const evidence = new EvidenceRecorder({ filePath: evidencePath });
const records = await evidence.readAll();
const sessionIds = new Set(records.map((record) => record.sessionId).filter(Boolean));
if (sessionIds.size !== 1) fail("Evidence must identify exactly one session");
const sessionId = [...sessionIds][0];
const store = new PracticeRunStore({
  filePath: journalPath,
  snapshotPath,
  sessionId,
});
const state = await store.state();
const runs = Object.values(state.runs);
if (runs.length !== 1) fail("expected exactly one PracticeRun");
const run = runs[0];
if (run.status !== expectedStatus || run.scope.revision !== expectedScopeRevision ||
    run.scope.files.length !== expectedScopeCount) {
  fail("PracticeRun status or final scope does not match");
}
const expectedFiles = expectedB === "-" ? [expectedA] : [expectedA, expectedB];
if (JSON.stringify(run.scope.files) !== JSON.stringify(expectedFiles)) fail("scope order or membership changed");

const journalText = await readFile(journalPath, "utf8");
if (journalText !== "" && !journalText.endsWith("\n")) fail("journal has a partial record");
const journal = journalText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const started = journal.filter((record) => record.eventType === "run.started");
const revised = journal.filter((record) => record.eventType === "scope.revised");
const evaluated = journal.filter((record) => record.eventType === "checkpoint.evaluated");
const completed = journal.filter((record) => record.eventType === "run.completed");
if (started.length !== 1 || revised.length !== expectedScopeRevision - 1) {
  fail("run or scope transition count is invalid");
}
if (expectedStatus === "done") {
  if (evaluated.length !== 0 || completed.length !== 1 || !run.lastCheckpoint?.allSatisfied) {
    fail("completion transition is invalid");
  }
} else if (evaluated.length !== 0 || completed.length !== 0 || run.lastCheckpoint !== null) {
  fail("active run unexpectedly has a checkpoint transition");
}

const projection = await projectReviewEvidence({
  evidence,
  boundary: expectedStatus === "done"
    ? {
        sequence: run.lastCheckpoint.evidenceTerminalSequence,
        hash: run.lastCheckpoint.evidenceTerminalHash,
      }
    : await evidenceBoundary(evidence),
  run,
});
if (projection.executions.some((execution) => ["write", "edit", "bash"].includes(execution.toolName)) ||
    records.some((record) => ["write", "edit", "bash"].includes(record.toolName))) {
  fail("write, edit, or bash appeared in Reviewer Evidence");
}

const readExecutions = projection.executions.filter((execution) => execution.toolName === "read");
if (readPhase === "safe-active" && expectedStatus !== "active") fail("safe-active requires active status");
let readValidation;
try {
  readValidation = validateReadExecutions({
    expectedA,
    expectedDigestA,
    expectedB,
    expectedDigestB,
    readPhase,
    executions: readExecutions,
  });
} catch (error) {
  fail(error.message);
}

let checkpointScopeDigest = null;
if (expectedStatus === "done") {
  const payloads = new ProtectedPayloadStore({ directory: join(dirname(journalPath), "protected") });
  const claim = await payloads.read("claim", run.lastCheckpoint.claimPayloadRef);
  if (JSON.stringify(claim.scope.files) !== JSON.stringify(run.scope.files)) {
    fail("protected completion claim does not match final scope");
  }
  checkpointScopeDigest = sha256(claim.scope.files);
}

const startRecord = started[0];
const result = {
  schemaVersion: 1,
  status: run.status,
  runId: run.runId,
  runRevision: run.revision,
  scopeRevision: run.scope.revision,
  scopeDigest: run.scope.digest,
  scopeFileCount: run.scope.files.length,
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
  readCountA: readValidation.readCountA,
  readCountB: readValidation.readCountB,
  checkpoint: run.lastCheckpoint?.allSatisfied ? "passed" : "not-run",
  checkpointScopeDigest,
};
if (expectedStatus === "done" && checkpointScopeDigest !== run.scope.digest) {
  fail("checkpoint does not bind the final scope digest");
}
process.stdout.write(`${JSON.stringify(result)}\n`);
