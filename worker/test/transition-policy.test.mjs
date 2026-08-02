import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REVISION_WAVES,
  dispositionForRelease,
  nextTaskKindAfter,
  reduceTaskChain,
} from "../agent/playbook/transition-policy.mjs";

test("the happy path walks design -> implement -> assess -> release", () => {
  assert.deepEqual(
    nextTaskKindAfter({ taskKind: "design", decision: "accept", revisionIndex: 0 }),
    { status: "next", taskKind: "implement", revisionIndex: 0 },
  );
  assert.deepEqual(
    nextTaskKindAfter({ taskKind: "implement", decision: "accept", revisionIndex: 0 }),
    { status: "next", taskKind: "assess", revisionIndex: 0 },
  );
  assert.deepEqual(
    nextTaskKindAfter({ taskKind: "assess", decision: "accept", revisionIndex: 0 }),
    { status: "next", taskKind: "release", revisionIndex: 0 },
  );
  assert.deepEqual(
    nextTaskKindAfter({ taskKind: "release", decision: "accept", revisionIndex: 0 }),
    { status: "awaiting_deploy", revisionIndex: 0 },
  );
});

test("an assessor revision under the limit opens a new implement wave", () => {
  assert.deepEqual(
    nextTaskKindAfter({ taskKind: "assess", decision: "revision", revisionIndex: 0 }),
    { status: "next", taskKind: "implement", revisionIndex: 1 },
  );
});

test("revision indices below maxRevisionWaves advance; the max index blocks", () => {
  assert.deepEqual(
    nextTaskKindAfter({ taskKind: "assess", decision: "revision", revisionIndex: MAX_REVISION_WAVES - 1 }),
    { status: "next", taskKind: "implement", revisionIndex: MAX_REVISION_WAVES },
  );
  assert.deepEqual(
    nextTaskKindAfter({ taskKind: "assess", decision: "revision", revisionIndex: MAX_REVISION_WAVES }),
    { status: "blocked" },
  );
});

test("a blocker or an unexpected decision fails closed", () => {
  for (const kind of ["design", "implement", "assess", "release"]) {
    assert.equal(
      nextTaskKindAfter({ taskKind: kind, decision: "blocked", revisionIndex: 0 }).status,
      "blocked",
    );
  }
  assert.equal(
    nextTaskKindAfter({ taskKind: "design", decision: "revision", revisionIndex: 0 }).status,
    "blocked",
  );
  assert.throws(
    () => nextTaskKindAfter({ taskKind: "design", decision: "invented", revisionIndex: 0 }),
    /Unknown task decision/u,
  );
});

test("release disposition: DELIVERED only on post-verify pass", () => {
  assert.equal(dispositionForRelease({ postVerify: "pass" }).disposition, "delivered");
});

test("release disposition: FAILED_SAFE requires rollback then previous-digest verify", () => {
  assert.equal(
    dispositionForRelease({ postVerify: "fail", rollback: "done", verifyPrevious: "pass" }).disposition,
    "failed_safe",
  );
  // no rollback, or previous digest did not verify -> recovery required, never safe
  assert.equal(
    dispositionForRelease({ postVerify: "fail" }).disposition,
    "recovery_required",
  );
  assert.equal(
    dispositionForRelease({ postVerify: "fail", rollback: "done", verifyPrevious: "fail" }).disposition,
    "recovery_required",
  );
  assert.equal(
    dispositionForRelease({ postVerify: "uncertain" }).disposition,
    "recovery_required",
  );
  assert.equal(dispositionForRelease({ postVerify: null }).disposition, "pending");
});

test("reduceTaskChain replays a revision then success to release", () => {
  const reduced = reduceTaskChain([
    { taskKind: "design", decision: "accept", revisionIndex: 0 },
    { taskKind: "implement", decision: "accept", revisionIndex: 0 },
    { taskKind: "assess", decision: "revision", revisionIndex: 0 },
    { taskKind: "implement", decision: "accept", revisionIndex: 1 },
    { taskKind: "assess", decision: "accept", revisionIndex: 1 },
    { taskKind: "release", decision: "accept", revisionIndex: 1 },
  ]);
  assert.equal(reduced.status, "awaiting_deploy");
  assert.equal(reduced.revisionIndex, 1);
  // without the release decision the chain is waiting on the release task
  const preRelease = reduceTaskChain([
    { taskKind: "design", decision: "accept", revisionIndex: 0 },
    { taskKind: "assess", decision: "accept", revisionIndex: 0 },
  ]);
  assert.equal(preRelease.status, "awaiting_task");
  assert.equal(preRelease.nextTaskKind, "release");
});

test("reduceTaskChain stops at a blocked transition", () => {
  const reduced = reduceTaskChain([
    { taskKind: "design", decision: "accept", revisionIndex: 0 },
    { taskKind: "implement", decision: "accept", revisionIndex: 0 },
    { taskKind: "assess", decision: "blocked", revisionIndex: 0 },
  ]);
  assert.equal(reduced.status, "blocked");
});
