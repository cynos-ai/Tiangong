#!/usr/bin/env node

import assert from "node:assert/strict";

import { expectedReadTargets, validateReadExecutions } from "../smoke-testing/support/reviewer-oracle-policy.mjs";

const targets = [
  {
    targetId: "target-a",
    resources: [
      { memberPath: "one.txt", contentDigest: "digest-a1" },
      { memberPath: "two.txt", contentDigest: "digest-a2" },
    ],
  },
  {
    targetId: "target-b",
    resources: [
      { memberPath: "one.txt", contentDigest: "digest-b1" },
      { memberPath: "two.txt", contentDigest: "digest-b2" },
    ],
  },
];

assert.deepEqual(expectedReadTargets({ targets, readPhase: "a-only" }).map((target) => target.targetId), ["target-a"]);
assert.deepEqual(expectedReadTargets({ targets, readPhase: "all" }).map((target) => target.targetId), ["target-a", "target-b"]);
assert.throws(() => expectedReadTargets({ targets: [], readPhase: "all" }), /invalid Reviewer oracle target policy input/u);

function completeRead(target, resource, sequence = 1) {
  return {
    status: "success",
    resource: { targetId: target.targetId, memberPath: resource.memberPath },
    resultMetadata: {
      fullContentDigest: resource.contentDigest,
      truncated: false,
      returnedLineStart: 1,
      returnedLineEnd: 2,
      fullContentLines: 2,
    },
    completedRef: { sequence },
  };
}

const reads = targets.flatMap((target, targetIndex) =>
  target.resources.map((resource, resourceIndex) => completeRead(target, resource, targetIndex * 2 + resourceIndex + 1)));
assert.deepEqual(
  validateReadExecutions({ targets, readPhase: "all-at-least-once", executions: reads }),
  { expectedTargetIds: ["target-a", "target-b"], readCountA: 2, readCountB: 2 },
);
assert.deepEqual(
  validateReadExecutions({ targets, readPhase: "safe-active", executions: reads.slice(0, 2) }),
  { expectedTargetIds: ["target-a"], readCountA: 2, readCountB: 0 },
);
assert.throws(
  () => validateReadExecutions({ targets, readPhase: "all", executions: reads.slice(0, 3) }),
  /complete snapshot-bound read proof is invalid for two.txt/u,
);
const changed = structuredClone(reads[2]);
changed.resultMetadata.fullContentDigest = "wrong";
assert.throws(
  () => validateReadExecutions({ targets, readPhase: "safe-active", executions: [...reads.slice(0, 2), changed] }),
  /changed or unauthorized fixture version|changed fixture version/u,
);

process.stdout.write("Reviewer smoke oracle policy contract passed.\n");
