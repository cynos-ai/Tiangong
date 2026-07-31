import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRoleProfileBundle } from "../agent/config/role-profile.mjs";
import { PeerReplyRouter } from "../agent/peer-reply-router.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import {
  parsePeerTransportCommand,
  PeerTransportProbe,
} from "../agent/peer-transport-probe.mjs";
import { TiangongAgentRuntime } from "../agent/runtime.mjs";
import { createTurnRequest } from "../agent/turn-contract.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

test("runtime handles the transport control without dispatching a model request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-peer-probe-"));
  const workspaceDir = join(directory, "workspace");
  const configPath = join(directory, "openclaw.json");
  await mkdir(workspaceDir);
  await writeFile(configPath, JSON.stringify({
    models: {
      providers: {
        "agentteams-gateway": {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [{
            id: "model-one",
            name: "Fixture",
            contextWindow: 32000,
            maxTokens: 100,
            reasoning: false,
            input: ["text"],
          }],
        },
      },
    },
  }));
  const profileBundle = await loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", "kernel.json"),
    resourceRoot: WORKER_ROOT,
  });
  const runtime = new TiangongAgentRuntime({
    configPath,
    provider: "agentteams-gateway",
    profileBundle,
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const phases = [];
  const observability = {
    checkpoint(phase) { phases.push(phase); },
    startOperation() { return { end() {} }; },
  };
  const result = await runtime.runTurn(request({
    turnId: "matrix:$runtime-start",
    actorId: "@admin:example.test",
    prompt: `TG_PEER_START nonce=${NONCE}`,
    authorizedPeerTargets: [ENGINEER],
    workspaceDir,
  }), observability);
  assert.deepEqual(phases, ["runtime.start", "gateway.resolved", "session.ready", "peer.transport.start"]);
  assert.equal(result.text, `TG_PEER_PING nonce=${NONCE}`);
  assert.deepEqual(result.replyTarget, ENGINEER);
  assert.equal(result.usage.totalTokens, 0);
  const stateDirectory = join(workspaceDir, ".tiangong", "runtime");
  const paths = statePathsForSession({ stateDirectory, sessionId: "session-one" });
  const sessionFiles = (await readdir(paths.piDirectory)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(sessionFiles.length, 1);
  assert.match(await readFile(join(paths.piDirectory, sessionFiles[0]), "utf8"), new RegExp(NONCE, "u"));

  const evidenceSentinel = join(paths.evidenceDirectory, "reset-sentinel");
  await mkdir(paths.evidenceDirectory, { recursive: true });
  await writeFile(evidenceSentinel, "preserved\n");
  await runtime.reset("session-one");
  await assert.rejects(readdir(paths.piDirectory), { code: "ENOENT" });
  assert.equal(await readFile(evidenceSentinel, "utf8"), "preserved\n");
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
