import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewerContextPack,
  createReviewerContextExtension,
} from "../agent/context/reviewer-context.mjs";
import { deriveReviewNextAction } from "../agent/practices/review-next-action.mjs";
import { projectReviewReadCoverage } from "../agent/practices/review-read-coverage.mjs";

function activeRun(files, lastCheckpoint = null) {
  return {
    runId: "run-fixture",
    revision: 1,
    status: "active",
    objective: { text: "Review selected files", source: "model_normalized" },
    acceptanceCriteria: [{ id: "criterion-1", description: "Find risks", source: "model_normalized" }],
    scope: { revision: 1, files, digest: "fixture", source: "model_normalized" },
    lastCheckpoint,
  };
}

function eventRef(sequence) {
  return Object.freeze({
    sessionId: "session",
    turnId: `turn-${sequence}`,
    toolCallId: `call-${sequence}`,
    sequence,
    eventHash: `${sequence}`.padStart(64, "0"),
  });
}

function readExecution({ path, digest, total = 3, start = 1, end = total, sequence }) {
  return Object.freeze({
    toolName: "read",
    operation: Object.freeze({ target: path }),
    resultMetadata: Object.freeze({
      fileDigest: digest,
      fullFileLines: total,
      returnedLineStart: start,
      returnedLineEnd: end,
    }),
    startedRef: eventRef(sequence),
    completedRef: eventRef(sequence + 1),
  });
}

function evidenceProjection(executions = []) {
  return Object.freeze({ executions: Object.freeze(executions) });
}

function failedCheckpoint(...reasonCodes) {
  return {
    allSatisfied: false,
    results: reasonCodes.map((reasonCode, index) => ({
      checkpointId: `checkpoint-${index + 1}`,
      satisfied: false,
      reasonCode,
    })),
  };
}

test("review coverage projects unread, partial, mixed, and latest-complete file states", () => {
  const run = activeRun(["unread.mjs", "partial.mjs", "mixed.mjs", "complete.mjs"]);
  const projection = evidenceProjection([
    readExecution({ path: "partial.mjs", digest: "partial", start: 1, end: 1, sequence: 1 }),
    readExecution({ path: "mixed.mjs", digest: "old", start: 1, end: 3, sequence: 3 }),
    readExecution({ path: "mixed.mjs", digest: "new", start: 1, end: 1, sequence: 5 }),
    readExecution({ path: "complete.mjs", digest: "old", start: 1, end: 1, sequence: 7 }),
    readExecution({ path: "complete.mjs", digest: "new", start: 1, end: 3, sequence: 9 }),
  ]);

  const coverage = projectReviewReadCoverage(run, projection);
  assert.equal(coverage.satisfied, false);
  assert.equal(coverage.reason, "SCOPE_READ_INCOMPLETE");
  assert.deepEqual(coverage.files.map((file) => ({
    targetRef: file.targetRef,
    status: file.status,
    reasonCode: file.reasonCode,
  })), [
    { targetRef: "scope-file-1", status: "unread", reasonCode: "SCOPE_READ_INCOMPLETE" },
    { targetRef: "scope-file-2", status: "partial", reasonCode: "SCOPE_READ_INCOMPLETE" },
    { targetRef: "scope-file-3", status: "mixed_version", reasonCode: "FILE_VERSION_MIXED" },
    { targetRef: "scope-file-4", status: "complete", reasonCode: null },
  ]);
  assert.deepEqual(coverage.fileFacts["complete.mjs"], { fileDigest: "new", fullFileLines: 3 });
  assert.equal(coverage.selectedEventRefs.length, 2);
});

test("review coverage preserves complete segmented reads and checkpoint-compatible first failure", () => {
  const run = activeRun(["a.mjs", "b.mjs"]);
  const projection = evidenceProjection([
    readExecution({ path: "a.mjs", digest: "a", total: 4, start: 3, end: 4, sequence: 3 }),
    readExecution({ path: "a.mjs", digest: "a", total: 4, start: 1, end: 2, sequence: 1 }),
    readExecution({ path: "b.mjs", digest: "b", total: 2, start: 2, end: 2, sequence: 5 }),
  ]);
  const coverage = projectReviewReadCoverage(run, projection);
  assert.equal(coverage.satisfied, false);
  assert.equal(coverage.reason, "SCOPE_READ_INCOMPLETE");
  assert.equal(coverage.files[0].status, "complete");
  assert.equal(coverage.files[1].status, "partial");
  assert.equal(coverage.selectedEventRefs.length, 4);
});

test("nextAction follows the deterministic priority and stable scope references", () => {
  const noRun = deriveReviewNextAction({ run: null });
  assert.deepEqual(noRun, { code: "NONE", targetRefs: [], reasonCodes: [] });

  const run = activeRun(["a.mjs", "b.mjs"], failedCheckpoint("CLAIM_SCOPE_MISMATCH"));
  const projection = evidenceProjection([
    readExecution({ path: "a.mjs", digest: "a", sequence: 1 }),
  ]);
  const coverage = projectReviewReadCoverage(run, projection);
  assert.deepEqual(deriveReviewNextAction({ run, coverage, evidenceProjection: projection }), {
    code: "READ_REMAINING_SCOPE",
    targetRefs: ["scope-file-2"],
    reasonCodes: ["SCOPE_READ_INCOMPLETE"],
  });

  const completeProjection = evidenceProjection([
    readExecution({ path: "a.mjs", digest: "a", sequence: 1 }),
    readExecution({ path: "b.mjs", digest: "b", sequence: 3 }),
  ]);
  const completeCoverage = projectReviewReadCoverage(run, completeProjection);
  assert.deepEqual(deriveReviewNextAction({ run, coverage: completeCoverage, evidenceProjection: completeProjection }), {
    code: "ADDRESS_CHECKPOINT_FAILURE",
    targetRefs: [],
    reasonCodes: ["CLAIM_SCOPE_MISMATCH"],
  });

  const unchecked = activeRun(["a.mjs", "b.mjs"]);
  assert.deepEqual(deriveReviewNextAction({
    run: unchecked,
    coverage: completeCoverage,
    evidenceProjection: completeProjection,
  }), { code: "CHECK_COMPLETION", targetRefs: [], reasonCodes: [] });
});

test("nextAction fails closed on mutation and conflicting active checkpoint state", () => {
  const run = activeRun(["a.mjs"]);
  const read = readExecution({ path: "a.mjs", digest: "a", sequence: 1 });
  const projection = evidenceProjection([read]);
  const coverage = projectReviewReadCoverage(run, projection);
  assert.throws(
    () => deriveReviewNextAction({
      run,
      coverage,
      evidenceProjection: evidenceProjection([read, { toolName: "write" }]),
    }),
    (error) => error.code === "REVIEW_GUIDANCE_INVARIANT_VIOLATION",
  );

  const impossible = activeRun(["a.mjs"], { allSatisfied: true, results: [] });
  assert.throws(
    () => deriveReviewNextAction({ run: impossible, coverage, evidenceProjection: projection }),
    (error) => error.code === "REVIEW_GUIDANCE_INVARIANT_VIOLATION",
  );
});

test("ContextPack v2 validates nextAction and keeps no-run context independent of Evidence", async () => {
  const none = deriveReviewNextAction({ run: null });
  const text = buildReviewerContextPack({ profileDigest: "profile", run: null, nextAction: none });
  assert.match(text, /"schemaVersion":2/u);
  assert.match(text, /"code":"NONE"/u);
  assert.match(text, /nextAction is advisory machine guidance/u);
  assert.throws(
    () => buildReviewerContextPack({
      profileDigest: "profile",
      run: activeRun(["a.mjs"]),
      nextAction: { code: "READ_REMAINING_SCOPE", targetRefs: ["scope-file-2"], reasonCodes: ["SCOPE_READ_INCOMPLETE"] },
    }),
    /final scope order/u,
  );
  const maximumFiles = Array.from({ length: 64 }, (_, index) => `file-${index + 1}.mjs`);
  const maximumRefs = maximumFiles.map((_, index) => `scope-file-${index + 1}`);
  assert.doesNotThrow(() => buildReviewerContextPack({
    profileDigest: "profile",
    run: activeRun(maximumFiles),
    nextAction: {
      code: "READ_REMAINING_SCOPE",
      targetRefs: maximumRefs,
      reasonCodes: ["SCOPE_READ_INCOMPLETE"],
    },
  }));

  let beforeAgentStart;
  let evidenceReads = 0;
  const extension = createReviewerContextExtension({
    service: { async activeForActor() { return undefined; } },
    turns: { current() { return { actor: { id: "@reviewer:example.test" } }; } },
    evidence: { async readAll() { evidenceReads += 1; throw new Error("must not read"); } },
    profileDigest: "profile",
  });
  extension({ on(name, handler) {
    assert.equal(name, "before_agent_start");
    beforeAgentStart = handler;
  } });
  const result = await beforeAgentStart({ systemPrompt: "base" });
  assert.match(result.systemPrompt, /"code":"NONE"/u);
  assert.equal(evidenceReads, 0);
});
