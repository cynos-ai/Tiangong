import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSpecialistHandoffCommand,
  SpecialistHandoffProbe,
} from "../agent/handoff-transport-probe.mjs";
import { createTurnRequest } from "../agent/turn-contract.mjs";

const NONCE = "11111111";
const HUMAN = "@admin:example.test";
const LEADER = Object.freeze({
  channel: "matrix",
  id: "@leader:example.test",
  source: "openclaw.matrix.group-only-sender",
});

function request({ turnId = "matrix:$source", actorId = HUMAN, messageId = "$source", peers = [LEADER], replyTarget = null, prompt = `TG_HANDOFF_START work=work-${NONCE} intent=intent-${NONCE}` } = {}) {
  return createTurnRequest({
    attemptId: `attempt-${turnId}`,
    turnId,
    sessionId: "session-one",
    prompt,
    workspaceDir: "/workspace",
    provider: "agentteams-gateway",
    modelId: "model-one",
    credential: "fixture-only",
    actor: { id: actorId, channel: "matrix", messageId },
    replyTarget,
    authorizedPeerTargets: peers,
  });
}

test("parses one bounded Specialist handoff command", () => {
  assert.deepEqual(
    parseSpecialistHandoffCommand(`@specialist:example.test TG_HANDOFF_START work=work-${NONCE} intent=intent-${NONCE}`),
    { kind: "start", workId: `work-${NONCE}`, intentId: `intent-${NONCE}` },
  );
  assert.deepEqual(
    parseSpecialistHandoffCommand(`<p>@specialist TG_HANDOFF_START work=work-${NONCE} intent=intent-${NONCE}</p>`),
    { kind: "start", workId: `work-${NONCE}`, intentId: `intent-${NONCE}` },
  );
  assert.equal(parseSpecialistHandoffCommand("ordinary request"), null);
  assert.throws(
    () => parseSpecialistHandoffCommand(`${"x".repeat(8193)} TG_HANDOFF_START work=work-${NONCE} intent=intent-${NONCE}`),
    /bounded input contract/u,
  );
  for (const malformed of [
    "TG_HANDOFF_START work=bad value intent=intent-11111111",
    `TG_HANDOFF_START work=work-${NONCE} intent=intent-${NONCE} TG_HANDOFF_START work=other intent=other`,
    `TG_HANDOFF_REPLAY work=work-${NONCE} intent=intent-${NONCE}`,
  ]) {
    assert.throws(() => parseSpecialistHandoffCommand(malformed), /malformed or ambiguous/u);
  }
});

test("binds the source event and one authenticated Leader recipient", () => {
  const probe = new SpecialistHandoffProbe();
  const current = request();
  const plan = probe.plan(parseSpecialistHandoffCommand(current.prompt), current, { replyTarget: null });
  assert.deepEqual(plan, {
    turnId: "matrix:$source",
    workId: `work-${NONCE}`,
    intentId: `intent-${NONCE}`,
    sourceEventId: "$source",
    sourceSender: HUMAN,
    recipient: LEADER,
  });
  probe.commit(plan);
  assert.equal(probe.hasCommittedTurn(current.turnId), true);
  assert.equal(probe.hasCommittedTurn("matrix:$other"), false);
  assert.throws(
    () => probe.plan(parseSpecialistHandoffCommand(current.prompt), current, { replyTarget: null }),
    /already consumed/u,
  );
});

test("fails closed on wrong route, current event, actor, or recipient set", () => {
  const cases = [
    { replyTarget: LEADER },
    { messageId: "not-an-event" },
    { actorId: "not-an-mxid" },
    { peers: [] },
    { peers: [LEADER, { ...LEADER, id: "@other:example.test" }] },
  ];
  for (const overrides of cases) {
    const probe = new SpecialistHandoffProbe();
    const current = request(overrides);
    assert.throws(
      () => probe.plan(parseSpecialistHandoffCommand(current.prompt), current, { replyTarget: overrides.replyTarget ?? null }),
    );
  }
});
