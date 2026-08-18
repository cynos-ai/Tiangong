import assert from "node:assert/strict";
import test from "node:test";

import { PeerReplyRouter } from "../agent/peer-reply-router.mjs";
import {
  parsePeerTransportCommand,
  PeerTransportProbe,
} from "../agent/peer-transport-probe.mjs";
import { createTurnRequest } from "../agent/turn-contract.mjs";

const NONCE = "11111111-2222-4333-8444-555555555555";
const OTHER_NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
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

function request({
  turnId,
  actorId,
  prompt,
  replyTarget = null,
  authorizedPeerTargets = [],
  workspaceDir = "/workspace",
}) {
  return createTurnRequest({
    attemptId: `attempt-${turnId}`,
    turnId,
    sessionId: "session-one",
    prompt,
    workspaceDir,
    provider: "agentteams-gateway",
    modelId: "model-one",
    credential: "fixture-only",
    actor: { id: actorId, channel: "matrix", messageId: turnId },
    replyTarget,
    authorizedPeerTargets,
  });
}

function commit(probe, router, plan, route) {
  router.commit(route, { text: plan.text, replyTarget: plan.replyTarget });
  probe.commit(plan);
}

test("parses one strict nonce-bound command and ignores ordinary prompts", () => {
  assert.equal(parsePeerTransportCommand("ordinary request"), null);
  assert.deepEqual(
    parsePeerTransportCommand(`TG_PEER_START nonce=${NONCE}.`),
    { kind: "start", nonce: NONCE },
  );
  for (const malformed of [
    "TG_PEER_START nonce=short",
    `TG_PEER_START nonce=${NONCE} TG_PEER_PING nonce=${NONCE}`,
    `TG_PEER_DONE nonce=${NONCE}`,
  ]) {
    assert.throws(() => parsePeerTransportCommand(malformed), /malformed or ambiguous/);
  }
});

test("completes a deterministic authenticated start, ping, pong, and terminal plan", () => {
  const coordinatorProbe = new PeerTransportProbe();
  const coordinatorRouter = new PeerReplyRouter();
  const startRequest = request({
    turnId: "matrix:$start",
    actorId: "@admin:example.test",
    prompt: `TG_PEER_START nonce=${NONCE}`,
    authorizedPeerTargets: [ENGINEER],
  });
  const startRoute = coordinatorRouter.plan(startRequest.replyTarget);
  const start = coordinatorProbe.plan(parsePeerTransportCommand(startRequest.prompt), startRequest, startRoute);
  assert.equal(start.text, `TG_PEER_PING nonce=${NONCE}`);
  assert.deepEqual(start.replyTarget, ENGINEER);
  commit(coordinatorProbe, coordinatorRouter, start, startRoute);
  assert.equal(coordinatorProbe.pendingCount, 1);

  const engineerProbe = new PeerTransportProbe();
  const engineerRouter = new PeerReplyRouter();
  const pingRequest = request({
    turnId: "matrix:$ping",
    actorId: COORDINATOR.id,
    prompt: `TG_PEER_PING nonce=${NONCE}`,
    replyTarget: COORDINATOR,
  });
  const pingRoute = engineerRouter.plan(pingRequest.replyTarget);
  const ping = engineerProbe.plan(parsePeerTransportCommand(pingRequest.prompt), pingRequest, pingRoute);
  assert.equal(ping.text, `TG_PEER_PONG nonce=${NONCE}`);
  assert.deepEqual(ping.replyTarget, COORDINATOR);
  commit(engineerProbe, engineerRouter, ping, pingRoute);

  const pongRequest = request({
    turnId: "matrix:$pong",
    actorId: ENGINEER.id,
    prompt: `TG_PEER_PONG nonce=${NONCE}`,
    replyTarget: ENGINEER,
  });
  const pongRoute = coordinatorRouter.plan(pongRequest.replyTarget);
  const pong = coordinatorProbe.plan(parsePeerTransportCommand(pongRequest.prompt), pongRequest, pongRoute);
  assert.equal(pong.text, `TG_PEER_DONE nonce=${NONCE}`);
  assert.equal(pong.replyTarget, null);
  commit(coordinatorProbe, coordinatorRouter, pong, pongRoute);
  assert.equal(coordinatorProbe.pendingCount, 0);
});

test("fails closed on ambiguous targets, unauthenticated peers, nonce mismatch, and replay", () => {
  const probe = new PeerTransportProbe();
  const router = new PeerReplyRouter();
  const ambiguous = request({
    turnId: "matrix:$ambiguous",
    actorId: "@admin:example.test",
    prompt: `TG_PEER_START nonce=${NONCE}`,
    authorizedPeerTargets: [ENGINEER, COORDINATOR],
  });
  assert.throws(
    () => probe.plan(parsePeerTransportCommand(ambiguous.prompt), ambiguous, router.plan(null)),
    /exactly one authorized peer/,
  );

  const startRequest = request({
    turnId: "matrix:$start",
    actorId: "@admin:example.test",
    prompt: `TG_PEER_START nonce=${NONCE}`,
    authorizedPeerTargets: [ENGINEER],
  });
  const startRoute = router.plan(null);
  const start = probe.plan(parsePeerTransportCommand(startRequest.prompt), startRequest, startRoute);
  commit(probe, router, start, startRoute);
  assert.throws(
    () => probe.plan(parsePeerTransportCommand(startRequest.prompt), startRequest, router.plan(null)),
    /already consumed/,
  );

  const wrongPong = request({
    turnId: "matrix:$wrong-pong",
    actorId: ENGINEER.id,
    prompt: `TG_PEER_PONG nonce=${OTHER_NONCE}`,
    replyTarget: ENGINEER,
  });
  assert.throws(
    () => probe.plan(parsePeerTransportCommand(wrongPong.prompt), wrongPong, router.plan(ENGINEER)),
    /does not match/,
  );

  const unauthenticated = request({
    turnId: "matrix:$unauthorized",
    actorId: "@unknown:example.test",
    prompt: `TG_PEER_PING nonce=${NONCE}`,
  });
  assert.throws(
    () => probe.plan(parsePeerTransportCommand(unauthenticated.prompt), unauthenticated, router.plan(null)),
    /authenticated reply route/,
  );
});
