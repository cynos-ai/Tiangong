import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewerContextPack } from "../agent/context/reviewer-context.mjs";
import { deriveReviewNextAction } from "../agent/practices/review-next-action.mjs";
import { projectReviewReadCoverage } from "../agent/practices/review-read-coverage.mjs";
import { resourceSelectorDigest } from "../agent/practices/review-targets.mjs";

const IDS = [
  "target-00000000-0000-4000-8000-000000000001",
  "target-00000000-0000-4000-8000-000000000002",
];

function target(targetId, path, lines = 3) {
  return {
    targetId,
    kind: "file",
    descriptor: { schemaVersion: 1, source: "model_normalized", value: { path } },
    snapshot: {
      schemaVersion: 1,
      source: "runtime_captured",
      captureVersion: "review-file-snapshot-v1",
      identity: targetId === IDS[0] ? "a".repeat(64) : "b".repeat(64),
      capturedAt: "2026-08-01T00:00:00.000Z",
      facts: {
        contentDigest: targetId === IDS[0] ? "c".repeat(64) : "d".repeat(64),
        contentBytes: 10,
        contentLines: lines,
        encoding: "utf-8",
        requiredConsumeSegments: 1,
      },
      artifacts: [],
    },
  };
}

function run() {
  return {
    runId: "run-00000000-0000-4000-8000-000000000001",
    roleId: "reviewer",
    profileDigest: "e".repeat(64),
    practiceId: "review",
    practiceVersion: 2,
    status: "active",
    revision: 1,
    origin: { actorId: "@reviewer:example.test" },
    objective: { text: "review", source: "model_normalized" },
    acceptanceCriteria: [{ id: "criterion-1", description: "all", source: "model_normalized" }],
    scope: { revision: 1, digest: "f".repeat(64), targets: [target(IDS[0], "a"), target(IDS[1], "b")] },
    lastCheckpoint: null,
  };
}

function resource(entry) {
  return {
    selectorDigest: resourceSelectorDigest(entry.targetId, null),
    targetId: entry.targetId,
    memberPath: null,
    snapshotIdentity: entry.snapshot.identity,
    contentDigest: entry.snapshot.facts.contentDigest,
    contentBytes: entry.snapshot.facts.contentBytes,
    contentLines: entry.snapshot.facts.contentLines,
  };
}

function execution(entry, start, end, sequence) {
  const selector = resourceSelectorDigest(entry.targetId, null);
  return {
    toolName: "read",
    status: "success",
    operation: { input: { resourceSelectorDigest: selector } },
    resultMetadata: { returnedLineStart: start, returnedLineEnd: end },
    startedRef: { sequence, eventHash: `${sequence}`.padStart(64, "0") },
    completedRef: { sequence: sequence + 1, eventHash: `${sequence + 1}`.padStart(64, "0") },
  };
}

function projection(runValue, executions = []) {
  return { executions, resources: runValue.scope.targets.map(resource) };
}

test("target coverage uses deterministic maximal interval selection and final target order", () => {
  const active = run();
  const p = projection(active, [
    execution(active.scope.targets[0], 1, 1, 1),
    execution(active.scope.targets[0], 1, 3, 3),
    execution(active.scope.targets[1], 1, 2, 5),
  ]);
  const coverage = projectReviewReadCoverage(active, p);
  assert.deepEqual(coverage.targets.map((entry) => entry.status), ["complete", "partial"]);
  assert.deepEqual(coverage.targets[0].selectedEventRefs.map((ref) => ref.sequence), [3, 4]);
  assert.equal(coverage.reason, "TARGET_CONSUMPTION_INCOMPLETE");
});

test("coverage projects a latest target-bound source failure as blocker without revoking prior completion", () => {
  const active = run();
  const selectorA = resourceSelectorDigest(IDS[0], null);
  const selectorB = resourceSelectorDigest(IDS[1], null);
  const p = projection(active, [
    execution(active.scope.targets[0], 1, 3, 1),
    { toolName: "read", status: "error", errorCode: "TARGET_CHANGED", operation: { input: { resourceSelectorDigest: selectorA } }, completedRef: { sequence: 4 } },
    { toolName: "read", status: "error", errorCode: "TARGET_UNAVAILABLE", operation: { input: { resourceSelectorDigest: selectorB } }, completedRef: { sequence: 6 } },
  ]);
  const coverage = projectReviewReadCoverage(active, p);
  assert.deepEqual(coverage.targets.map((entry) => [entry.status, entry.reasonCode]), [
    ["complete", null], ["blocked", "TARGET_UNAVAILABLE"],
  ]);
});

test("nextAction prioritizes blockers, then incomplete targets, checkpoint failure, and completion", () => {
  const active = run();
  let p = projection(active, [{
    toolName: "read", status: "error", errorCode: "TARGET_CHANGED",
    operation: { input: { resourceSelectorDigest: resourceSelectorDigest(IDS[0], null) } },
    completedRef: { sequence: 2 },
  }]);
  let coverage = projectReviewReadCoverage(active, p);
  assert.deepEqual(deriveReviewNextAction({ run: active, coverage, evidenceProjection: p }), {
    code: "RESOLVE_TARGET_BLOCKER", targetRefs: [IDS[0]], reasonCodes: ["TARGET_CHANGED"],
  });

  p = projection(active, [execution(active.scope.targets[0], 1, 3, 1)]);
  coverage = projectReviewReadCoverage(active, p);
  assert.deepEqual(deriveReviewNextAction({ run: active, coverage, evidenceProjection: p }), {
    code: "CONSUME_REMAINING_TARGETS", targetRefs: [IDS[1]], reasonCodes: ["TARGET_CONSUMPTION_INCOMPLETE"],
  });

  p = projection(active, [execution(active.scope.targets[0], 1, 3, 1), execution(active.scope.targets[1], 1, 3, 3)]);
  coverage = projectReviewReadCoverage(active, p);
  active.lastCheckpoint = { allSatisfied: false, results: [{ satisfied: false, reasonCode: "CLAIM_SCOPE_MISMATCH" }] };
  assert.equal(deriveReviewNextAction({ run: active, coverage, evidenceProjection: p }).code, "ADDRESS_CHECKPOINT_FAILURE");
  active.lastCheckpoint = null;
  assert.equal(deriveReviewNextAction({ run: active, coverage, evidenceProjection: p }).code, "CHECK_COMPLETION");
  assert.deepEqual(deriveReviewNextAction({ run: null }), { code: "NONE", targetRefs: [], reasonCodes: [] });
});

test("ContextPack v3 exposes bounded target summaries and rejects positional v1 refs", () => {
  const active = run();
  const text = buildReviewerContextPack({
    profileDigest: active.profileDigest,
    run: active,
    nextAction: { code: "CONSUME_REMAINING_TARGETS", targetRefs: IDS, reasonCodes: ["TARGET_CONSUMPTION_INCOMPLETE"] },
  });
  assert.match(text, /"schemaVersion":3/u);
  assert.match(text, new RegExp(IDS[0], "u"));
  assert.doesNotMatch(text, /scope-file-/u);
  assert.doesNotMatch(text, /contentDigest|artifactRef|capturedAt/u);
  assert.throws(() => buildReviewerContextPack({
    profileDigest: active.profileDigest,
    run: active,
    nextAction: { code: "CONSUME_REMAINING_TARGETS", targetRefs: ["scope-file-1"], reasonCodes: ["TARGET_CONSUMPTION_INCOMPLETE"] },
  }), /targetRefs/u);
});
