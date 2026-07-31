#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  expectedReadTargets,
  validateReadExecutions,
} from "../smoke-testing/support/reviewer-oracle-policy.mjs";

assert.deepEqual(
  expectedReadTargets({ expectedA: "a.txt", expectedB: "-", readPhase: "all" }),
  ["a.txt"],
);
assert.deepEqual(
  expectedReadTargets({ expectedA: "a.txt", expectedB: "b.txt", readPhase: "a-only" }),
  ["a.txt"],
);
assert.deepEqual(
  expectedReadTargets({ expectedA: "a.txt", expectedB: "b.txt", readPhase: "all-at-least-once" }),
  ["a.txt", "b.txt"],
);
assert.throws(
  () => expectedReadTargets({ expectedA: "", expectedB: "b.txt", readPhase: "all" }),
  /invalid Reviewer oracle read policy input/u,
);

function completeRead(target, digest) {
  return {
    operation: { target },
    resultMetadata: {
      fileDigest: digest,
      truncated: false,
      returnedLineStart: 1,
      returnedLineEnd: 2,
      fullFileLines: 2,
    },
  };
}

const a = completeRead("a.txt", "digest-a");
const b = completeRead("b.txt", "digest-b");
const policy = {
  expectedA: "a.txt",
  expectedDigestA: "digest-a",
  expectedB: "b.txt",
  expectedDigestB: "digest-b",
};
assert.deepEqual(
  validateReadExecutions({ ...policy, readPhase: "all-at-least-once", executions: [a, a, b] }),
  { expectedTargets: ["a.txt", "b.txt"], readCountA: 2, readCountB: 1 },
);
assert.deepEqual(
  validateReadExecutions({ ...policy, readPhase: "safe-active", executions: [a, a] }),
  { expectedTargets: ["a.txt"], readCountA: 2, readCountB: 0 },
);
assert.throws(
  () => validateReadExecutions({ ...policy, readPhase: "all-at-least-once", executions: [a, a] }),
  /complete single-version read proof is invalid for b.txt/u,
);
assert.throws(
  () => validateReadExecutions({
    ...policy,
    readPhase: "safe-active",
    executions: [a, completeRead("b.txt", "wrong")],
  }),
  /changed fixture version/u,
);

process.stdout.write("Reviewer smoke oracle policy contract passed.\n");
