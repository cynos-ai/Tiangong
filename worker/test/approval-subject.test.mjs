import assert from "node:assert/strict";
import test from "node:test";

import { assertApprovalSubject } from "../agent/gates/approval-subject.mjs";

const CHECKPOINT = Object.freeze({ requestedBy: "@requester:example.test" });

test("the authenticated requester may decide its pending operation", () => {
  assert.equal(
    assertApprovalSubject(CHECKPOINT, "@requester:example.test"),
    "@requester:example.test",
  );
});

test("another subject cannot approve even when an upstream owner assertion exists", () => {
  const upstreamActor = {
    id: "@other:example.test",
    isOwner: true,
  };
  assert.throws(
    () => assertApprovalSubject(CHECKPOINT, upstreamActor.id),
    /not authorized/u,
  );
});

test("missing requester or authenticated subject fails closed", () => {
  assert.throws(() => assertApprovalSubject(CHECKPOINT, null), /subject is unavailable/u);
  assert.throws(() => assertApprovalSubject({}, "@requester:example.test"), /requester is unavailable/u);
});
