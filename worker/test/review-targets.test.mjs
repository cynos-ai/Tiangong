import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN,
  MAX_RETURNED_BYTES,
  assertFinalScopeFeasible,
  maximalChunk,
  normalizeMemberPath,
  normalizeTargetRequests,
} from "../agent/practices/review-targets.mjs";

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

function fileTarget({ bytes = 1, segments = 1 } = {}) {
  return {
    kind: "file",
    snapshot: { facts: { contentBytes: bytes, requiredConsumeSegments: segments }, artifacts: [] },
  };
}

function directoryTarget({ bytes = 1, segments = 1, manifestBytes = 1 } = {}) {
  return {
    kind: "directory_snapshot",
    snapshot: {
      facts: { totalContentBytes: bytes, requiredConsumeSegments: segments },
      artifacts: [{ contentIdentity: { contentBytes: manifestBytes } }],
    },
  };
}

test("target and member lexical normalization follows clean-cut v2 selector semantics", () => {
  assert.deepEqual(normalizeTargetRequests([
    { kind: "file", path: "src/./one.txt" },
    {
      kind: "directory_snapshot",
      path: "src/./nested",
      selection: { includePrefixes: ["z", "./a"], excludePrefixes: ["z/generated"] },
    },
  ]), [
    { kind: "file", path: "src/one.txt" },
    {
      kind: "directory_snapshot",
      path: "src/nested",
      selection: { includePrefixes: ["a", "z"], excludePrefixes: ["z/generated"] },
    },
  ]);
  expectCode(() => normalizeTargetRequests([
    { kind: "file", path: "src/one.txt" },
    { kind: "file", path: "src/./one.txt" },
  ]), "SCOPE_TARGET_ALREADY_PRESENT");
  expectCode(() => normalizeTargetRequests([{ kind: "file", path: "../outside" }]), "TARGET_OUTSIDE_WORKSPACE");
  expectCode(() => normalizeTargetRequests([{
    kind: "directory_snapshot", path: "src",
    selection: { includePrefixes: ["a", "a/b"], excludePrefixes: [] },
  }]), "TARGET_SELECTOR_INVALID");
  assert.equal(normalizeMemberPath("nested/./one.txt"), "nested/one.txt");
  expectCode(() => normalizeMemberPath("a".repeat(1025)), "TARGET_SELECTOR_INVALID");
});

test("canonical consume chunks are maximal complete-line prefixes under exact limits", () => {
  const line = "a".repeat(30 * 1024);
  const chunk = maximalChunk([line, line], 1, 2);
  assert.equal(chunk.lineStart, 1);
  assert.equal(chunk.lineEnd, 1);
  assert.equal(chunk.bytes, 30 * 1024);
  assert.equal(chunk.truncated, true);
  expectCode(() => maximalChunk(["a".repeat(MAX_RETURNED_BYTES + 1)], 1, 1), "TARGET_LIMIT_EXCEEDED");
  expectCode(() => maximalChunk(["one"], 0, 1), "TARGET_RANGE_INVALID");
  expectCode(() => maximalChunk(["one"], 2, 1), "TARGET_RANGE_INVALID");
});

test("final target scope aggregate feasibility accepts adjacent limits and rejects each overflow", () => {
  assert.doesNotThrow(() => assertFinalScopeFeasible([
    fileTarget({ bytes: 8 * 1024 * 1024, segments: 480 }),
    directoryTarget({ bytes: 8 * 1024 * 1024, segments: 480, manifestBytes: 8 * 1024 * 1024 }),
  ]));
  expectCode(() => assertFinalScopeFeasible([
    fileTarget({ segments: MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN }),
    fileTarget({ segments: 1 }),
  ]), "CAPTURE_LIMIT_EXCEEDED");
  expectCode(() => assertFinalScopeFeasible([
    fileTarget({ bytes: (16 * 1024 * 1024) + 1 }),
  ]), "CAPTURE_LIMIT_EXCEEDED");
  expectCode(() => assertFinalScopeFeasible([
    directoryTarget({ manifestBytes: (8 * 1024 * 1024) + 1 }),
  ]), "CAPTURE_LIMIT_EXCEEDED");
  expectCode(() => assertFinalScopeFeasible(Array.from({ length: 65 }, () => fileTarget())), "CAPTURE_LIMIT_EXCEEDED");
});
