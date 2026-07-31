import assert from "node:assert/strict";
import test from "node:test";

import { PeerReplyRouter } from "../agent/peer-reply-router.mjs";

const COORDINATOR = Object.freeze({
  channel: "matrix",
  id: "@coordinator:example.test",
  source: "openclaw.matrix.group-only-sender",
});
const ENGINEER = Object.freeze({
  channel: "matrix",
  id: "@engineer:example.test",
  source: "openclaw.matrix.group-only-sender",
});

function commit(router, plan, text) {
  router.commit(plan, { text, replyTarget: plan.replyTarget });
}

test("replies once to an unsolicited peer and consumes the correlated response", () => {
  const coordinator = new PeerReplyRouter();
  const initial = coordinator.plan(null);
  commit(coordinator, initial, "@engineer:example.test please inspect");
  const result = coordinator.plan(ENGINEER);
  assert.equal(result.replyTarget, null);
  commit(coordinator, result, "done");

  const engineer = new PeerReplyRouter();
  const assignment = engineer.plan(COORDINATOR);
  assert.deepEqual(assignment.replyTarget, COORDINATOR);
  commit(engineer, assignment, "pong");
  const acknowledgement = engineer.plan(COORDINATOR);
  assert.equal(acknowledgement.replyTarget, null);
});

test("does not suppress an unrelated peer sender", () => {
  const router = new PeerReplyRouter();
  commit(router, router.plan(null), "@engineer:example.test please inspect");
  assert.deepEqual(router.plan(COORDINATOR).replyTarget, COORDINATOR);
  assert.equal(router.plan(ENGINEER).replyTarget, null);
});

test("consumes each expected peer response only after a result commits", () => {
  const router = new PeerReplyRouter();
  commit(router, router.plan(null), "@engineer:example.test please inspect");
  const first = router.plan(ENGINEER);
  assert.equal(first.replyTarget, null);
  assert.equal(router.plan(ENGINEER).replyTarget, null);
  commit(router, first, "done");
  assert.deepEqual(router.plan(ENGINEER).replyTarget, ENGINEER);
});

test("records only bounded Matrix IDs rather than model prose", () => {
  const router = new PeerReplyRouter();
  commit(
    router,
    router.plan(null),
    "sensitive prose @engineer:example.test, plus malformed @bad and https://example.test",
  );
  assert.equal(router.pendingCount, 1);
  const response = router.plan(ENGINEER);
  commit(router, response, "done");
  assert.equal(router.pendingCount, 0);
});

test("fails closed before pending peer state can grow without bound", () => {
  const router = new PeerReplyRouter();
  const targets = Array.from({ length: 33 }, (_, index) => `@peer-${index}:example.test`).join(" ");
  assert.throws(
    () => commit(router, router.plan(null), targets),
    /target limit exceeded/,
  );
  assert.equal(router.pendingCount, 0);
});

test("rejects invalid reply targets and plans", () => {
  const router = new PeerReplyRouter();
  assert.throws(() => router.plan({ channel: "matrix", id: "bad", source: "model" }), /reply target/iu);
  assert.throws(
    () => router.commit(null, { text: "answer", replyTarget: null }),
    /plan is required/,
  );
  assert.throws(
    () => router.commit(router.plan(null), { text: "answer", replyTarget: { id: "bad" } }),
    /reply target/iu,
  );
});
