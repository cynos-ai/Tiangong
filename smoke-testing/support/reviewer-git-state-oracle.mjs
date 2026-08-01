#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CapturedArtifactStore } from "/opt/tiangong-worker/agent/artifacts/store.mjs";
import { evidenceBoundary, projectReviewEvidence } from "/opt/tiangong-worker/agent/evidence/projection.mjs";
import { EvidenceRecorder } from "/opt/tiangong-worker/agent/evidence/recorder.mjs";
import { PracticeRunStore } from "/opt/tiangong-worker/agent/practices/practice-run-store.mjs";
import { ProtectedPayloadStore } from "/opt/tiangong-worker/agent/practices/protected-payload-store.mjs";
import { projectReviewReadCoverage } from "/opt/tiangong-worker/agent/practices/review-read-coverage.mjs";
import { ReviewTargetCapture } from "/opt/tiangong-worker/agent/practices/review-targets.mjs";

function fail(message) { throw new Error(`Reviewer Git smoke oracle failed: ${message}`); }

const [
  journalPath,
  snapshotPath,
  evidencePath,
  stateDirectory,
  workspaceDir,
  repositoryPath,
  baseOid,
  headOid,
  digestOne,
  digestTwo,
  diffDigest,
] = process.argv.slice(2);
const digest = /^[a-f0-9]{64}$/u;
const oid = /^[a-f0-9]{40}$/u;
if (![journalPath, snapshotPath, evidencePath, stateDirectory, workspaceDir, repositoryPath].every(Boolean)
    || !oid.test(baseOid) || !oid.test(headOid) || ![digestOne, digestTwo, diffDigest].every((value) => digest.test(value))) {
  fail("invalid arguments");
}

const evidence = new EvidenceRecorder({ filePath: evidencePath });
const records = await evidence.readAll();
const sessionIds = new Set(records.map((record) => record.sessionId).filter(Boolean));
if (sessionIds.size !== 1) fail("Evidence must identify exactly one session");
const sessionId = [...sessionIds][0];
const artifactStore = new CapturedArtifactStore({ stateDirectory, sessionId });
const targetCapture = new ReviewTargetCapture({
  workspaceDir,
  artifactStore,
  localGitLockPath: join(stateDirectory, "local-git", artifactStore.sessionHash, "lock-target"),
});
const store = new PracticeRunStore({ filePath: journalPath, snapshotPath, sessionId });
const state = await store.state();
const runs = Object.values(state.runs);
if (runs.length !== 1) fail("expected exactly one PracticeRun");
const run = runs[0];
if (run.status !== "done" || run.scope.revision !== 1 || run.scope.targets.length !== 2
    || !run.lastCheckpoint?.allSatisfied) fail("PracticeRun completion does not match");
const [commit, diffTarget] = run.scope.targets;
if (commit.kind !== "commit" || diffTarget.kind !== "git_diff"
    || commit.descriptor.value.repositoryPath !== repositoryPath
    || diffTarget.descriptor.value.repositoryPath !== repositoryPath
    || commit.descriptor.value.ref !== "refs/heads/head"
    || diffTarget.descriptor.value.baseRef !== "refs/heads/base"
    || diffTarget.descriptor.value.headRef !== "refs/heads/head"
    || JSON.stringify(commit.descriptor.value.pathPrefixes) !== JSON.stringify(["src"])
    || JSON.stringify(diffTarget.descriptor.value.pathPrefixes) !== JSON.stringify(["src"])) {
  fail("target order or normalized descriptors changed");
}
if (commit.snapshot.captureVersion !== "review-commit-snapshot-v1"
    || diffTarget.snapshot.captureVersion !== "review-git-diff-snapshot-v1"
    || commit.snapshot.facts.objectFormat !== "sha1" || diffTarget.snapshot.facts.objectFormat !== "sha1"
    || commit.snapshot.facts.gitPolicyVersion !== "review-local-git-v1"
    || diffTarget.snapshot.facts.gitPolicyVersion !== "review-local-git-v1"
    || commit.snapshot.facts.gitVersion !== "2.43.0" || diffTarget.snapshot.facts.gitVersion !== "2.43.0"
    || commit.snapshot.facts.commitOid !== headOid
    || diffTarget.snapshot.facts.baseCommitOid !== baseOid
    || diffTarget.snapshot.facts.headCommitOid !== headOid
    || commit.snapshot.facts.memberCount !== 2 || diffTarget.snapshot.facts.changedFileCount !== 2) {
  fail("pinned Git snapshot facts differ from the fixture");
}
if (commit.snapshot.artifacts[0].contentIdentity.producerId !== "review-git-commit-capture"
    || commit.snapshot.artifacts[0].contentIdentity.purpose !== "git_tree_manifest"
    || diffTarget.snapshot.artifacts[0].contentIdentity.producerId !== "review-git-diff-capture"
    || diffTarget.snapshot.artifacts[0].contentIdentity.purpose !== "git_diff") {
  fail("Git admission producers are invalid");
}
const manifest = await targetCapture.readCommitManifest(commit);
if (JSON.stringify(manifest.members.map((member) => ({ path: member.path, digest: member.contentDigest })))
    !== JSON.stringify([
      { path: "src/one.txt", digest: digestOne },
      { path: "src/two.txt", digest: digestTwo },
    ])) fail("commit manifest members differ from independent fixture digests");
const diff = await targetCapture.readDiffArtifact(diffTarget);
if (diff.contentDigest !== diffDigest || diff.contentDigest !== diffTarget.snapshot.facts.diffContentDigest) {
  fail("diff Artifact differs from independent fixture digest");
}

const boundary = {
  sequence: run.lastCheckpoint.evidenceTerminalSequence,
  hash: run.lastCheckpoint.evidenceTerminalHash,
};
const currentBoundary = await evidenceBoundary(evidence);
if (boundary.sequence > currentBoundary.sequence) fail("checkpoint Evidence boundary is unavailable");
const projection = await projectReviewEvidence({ evidence, boundary, run, targetCapture, artifactStore });
if (projection.executions.some((execution) => ["write", "edit", "bash"].includes(execution.toolName))
    || records.some((record) => ["write", "edit", "bash"].includes(record.toolName))) {
  fail("mutation tool appeared in Reviewer Evidence");
}
const resources = projection.resources.map((resource) => ({
  targetId: resource.targetId,
  memberPath: resource.memberPath,
  contentDigest: resource.contentDigest,
}));
if (JSON.stringify(resources) !== JSON.stringify([
  { targetId: commit.targetId, memberPath: "src/one.txt", contentDigest: digestOne },
  { targetId: commit.targetId, memberPath: "src/two.txt", contentDigest: digestTwo },
  { targetId: diffTarget.targetId, memberPath: null, contentDigest: diffDigest },
])) fail("coverage resources differ from pinned fixture resources");
const reads = projection.executions.filter((execution) => execution.toolName === "read" && execution.status === "success");
if (reads.length !== 3 || reads.some((execution) => execution.resultMetadata.truncated
    || execution.resultMetadata.returnedLineStart !== 1
    || execution.resultMetadata.returnedLineEnd !== execution.resultMetadata.fullContentLines)) {
  fail("Git resources do not have exact complete read Evidence");
}
const inspections = projection.executions.filter((execution) => execution.toolName === "inspect_repository"
  && execution.status === "success");
if (inspections.length !== 1 || inspections[0].resultMetadata.action !== "list_commit"
    || inspections[0].resultMetadata.resultCount !== 2) fail("repository inspection Evidence is invalid");
if (projection.executions.some((execution) => execution.toolName === "inspect_directory")) {
  fail("directory inspection appeared in the Git smoke run");
}
const coverage = projectReviewReadCoverage(run, projection);
if (!coverage.satisfied || coverage.targets.some((target) => target.status !== "complete")) {
  fail("Git target coverage is incomplete");
}

const journalText = await readFile(journalPath, "utf8");
if (!journalText.endsWith("\n") || journalText.includes("diff --git") || journalText.includes('"members"')) {
  fail("PracticeRun journal contains partial or raw Git artifact bytes");
}
const journal = journalText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const started = journal.filter((record) => record.eventType === "run.started");
const completed = journal.filter((record) => record.eventType === "run.completed");
if (started.length !== 1 || completed.length !== 1 || journal.some((record) => record.eventType === "scope.revised")) {
  fail("Git smoke PracticeRun transition count is invalid");
}
if (completed[0].operation.input.finalScopeDigest !== run.scope.digest) fail("completion does not bind final scope digest");
const payloads = new ProtectedPayloadStore({ directory: join(dirname(journalPath), "protected") });
const claim = await payloads.read("claim", run.lastCheckpoint.claimPayloadRef);
if (JSON.stringify(claim.scope.targetIds) !== JSON.stringify([commit.targetId, diffTarget.targetId])) {
  fail("completion claim does not preserve Git target order");
}
const evidenceWire = JSON.stringify(records);
for (const secret of [repositoryPath, baseOid, headOid, "refs/heads/base", "refs/heads/head", "src/one.txt", "src/two.txt", "artifact-v1/", "diff --git"]) {
  if (evidenceWire.includes(secret)) fail("raw Git source fact leaked into Evidence");
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: run.status,
  checkpoint: "passed",
  runId: run.runId,
  runRevision: run.revision,
  scopeDigest: run.scope.digest,
  targetIds: [commit.targetId, diffTarget.targetId],
  snapshotIdentities: [commit.snapshot.identity, diffTarget.snapshot.identity],
  commitOid: commit.snapshot.facts.commitOid,
  baseCommitOid: diffTarget.snapshot.facts.baseCommitOid,
  headCommitOid: diffTarget.snapshot.facts.headCommitOid,
  manifestContentDigest: commit.snapshot.facts.manifestContentDigest,
  diffContentDigest: diffTarget.snapshot.facts.diffContentDigest,
  readExecutionCount: reads.length,
  inspectionExecutionCount: inspections.length,
  evidenceTerminalHash: projection.boundary.hash,
  evidenceTerminalSequence: projection.boundary.sequence,
  practiceTerminalHash: state.terminalHash,
})}\n`);
