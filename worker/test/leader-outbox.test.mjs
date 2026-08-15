import assert from "node:assert/strict";
import test from "node:test";

import {
  createLeaderOutboxHandlers,
  drainLeaderOutbox,
} from "../agent/team/leader-outbox.mjs";

function fakeStore() {
  const state = new Map([
    ["a".repeat(64), { wakeId: "a".repeat(64), kind: "human-reply", workId: "work-1", targetMemberId: "@alice:example.test", status: "pending", createdAt: "2026-08-15T01:00:00.000Z" }],
  ]);
  return {
    async listOutbox({ status } = {}) {
      return [...state.values()].filter((wake) => status === undefined || wake.status === status).map((wake) => structuredClone(wake));
    },
    async claimWake({ wakeId, consumerId }) {
      const wake = state.get(wakeId);
      if (!wake || wake.status !== "pending") throw new Error("WAKE_CLAIM_CONFLICT");
      wake.status = "claimed";
      wake.consumerId = consumerId;
      return { replayed: false, wake: structuredClone(wake) };
    },
    async ackWake({ wakeId, consumerId, receiptId }) {
      const wake = state.get(wakeId);
      if (!wake || wake.status !== "claimed" || wake.consumerId !== consumerId) throw new Error("WAKE_ACK_CONFLICT");
      wake.status = "acked";
      wake.receiptId = receiptId;
      return { replayed: false, wake: structuredClone(wake) };
    },
    state,
  };
}

test("B2 outbox retries an idempotent handler and acknowledges only after delivery", async () => {
  const store = fakeStore();
  let attempts = 0;
  const first = await drainLeaderOutbox({
    store,
    consumerId: "leader-worker-1",
    handlers: {
      "human-reply": async () => {
        attempts += 1;
        throw new Error("temporary Matrix outage");
      },
    },
  });
  assert.deepEqual(first.results, [{ wakeId: "a".repeat(64), kind: "human-reply", status: "pending", errorCode: "OUTBOX_HANDLER_FAILED" }]);
  assert.equal(store.state.get("a".repeat(64)).status, "pending");

  const second = await drainLeaderOutbox({
    store,
    consumerId: "leader-worker-1",
    handlers: { "human-reply": async () => ({ receiptId: "matrix-reply-1" }) },
  });
  assert.deepEqual(second.results, [{ wakeId: "a".repeat(64), kind: "human-reply", status: "acked", receiptId: "matrix-reply-1" }]);
  assert.equal(attempts, 1);
  assert.equal(store.state.get("a".repeat(64)).status, "acked");
});

test("B2 outbox leaves unsupported wake kinds pending and bounds the batch", async () => {
  const store = fakeStore();
  const result = await drainLeaderOutbox({ store, consumerId: "leader-worker-1", handlers: {}, maxEntries: 1 });
  assert.deepEqual(result, { scanned: 1, results: [] });
  assert.equal(store.state.get("a".repeat(64)).status, "pending");
  await assert.rejects(
    () => drainLeaderOutbox({ store, consumerId: "leader-worker-1", handlers: {}, maxEntries: 33 }),
    /bounded range/u,
  );
});

test("B2 outbox handlers resolve the current Work route before emitting a Human reply", async () => {
  const calls = [];
  const store = {
    async getWork(workId) {
      return { work: { workId, actorId: "@alice:example.test", sourceEventId: "$human-event-1", routeId: "route-1" } };
    },
  };
  const handlers = createLeaderOutboxHandlers({
    store,
    channel: {
      async notifyWorkAdmitted(recipient, input) {
        calls.push([recipient, input]);
        return { transactionId: "matrix-transaction-1" };
      },
    },
    async resolveWorkRoute(work) {
      assert.equal(work.work.routeId, "route-1");
      return { roomId: "!team:example.test", bindingDigest: "d".repeat(64) };
    },
    async resumeLeader() { return { sessionId: "leader-session-1" }; },
  });
  const receipt = await handlers["human-reply"]({ wakeId: "a".repeat(64), kind: "human-reply", workId: "work-1", targetMemberId: "@alice:example.test" });
  assert.deepEqual(receipt, { receiptId: "matrix-transaction-1" });
  assert.deepEqual(calls, [["@alice:example.test", {
    roomId: "!team:example.test",
    workId: "work-1",
    sourceEventId: "$human-event-1",
    bindingDigest: "d".repeat(64),
  }]]);
  assert.deepEqual(await handlers["leader-resume"]({ wakeId: "b".repeat(64), kind: "leader-resume" }), { receiptId: "leader-session-1" });
});
