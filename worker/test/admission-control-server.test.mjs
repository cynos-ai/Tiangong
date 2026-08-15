import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admitBeforeModel,
  admitBeforeTool,
  AdmissionDeniedError,
} from "../agent/gates/admission-boundary.mjs";
import { createControlAdmissionResolver } from "../agent/gates/admission-context.mjs";
import {
  AdmissionBindingStore,
  AdmissionReplayStore,
  createAdmissionControlPlane,
  createAdmissionControlServer,
} from "../agent/gates/admission-control-server.mjs";

const binding = {
  workerName: "worker-one",
  runtimeLane: "openclaw-canary",
  configRevision: "config-1",
  capabilityRevision: "capability-1",
  allowedChannels: ["matrix"],
  allowedActors: ["@human:example.test"],
  allowedRoutes: ["team-room"],
  allowedSessions: ["session-1"],
  active: true,
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-admission-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bindingStore = new AdmissionBindingStore({ filePath: join(directory, "binding.json") });
  const replayStore = new AdmissionReplayStore({ filePath: join(directory, "replay.json") });
  await bindingStore.write(binding, { updatedAt: "2026-08-15T00:00:00.000Z" });
  const server = createAdmissionControlServer({
    plane: createAdmissionControlPlane({ bindingStore, replayStore, now: () => "2026-08-15T00:00:01.000Z" }),
    readiness: () => bindingStore.read(),
  }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const resolve = createControlAdmissionResolver({
    url: `${baseUrl}/v1/admission`,
    workerName: binding.workerName,
    runtimeLane: binding.runtimeLane,
  });
  return { bindingStore, directory, replayPath: join(directory, "replay.json"), healthUrl: `${baseUrl}/healthz`, resolve };
}

function modelEvent(content = "hello", overrides = {}) {
  return {
    channel: "matrix",
    route: "team-room",
    senderId: "@human:example.test",
    messageId: "$event-1",
    sessionKey: "session-1",
    content,
    ...overrides,
  };
}

function toolEvent(overrides = {}) {
  return {
    toolName: "read",
    toolCallId: "call-1",
    messageId: "$event-1",
    sessionKey: "session-1",
    ...overrides,
  };
}

test("durable Control API admits model and tool phases and replays after restart", async (t) => {
  const { directory, replayPath, resolve } = await fixture(t);
  const model = await resolve({ phase: "model", event: modelEvent() });
  assert.equal(admitBeforeModel(model).phase, "model");
  const tool = await resolve({ phase: "tool", event: toolEvent() });
  assert.equal(admitBeforeTool(tool).phase, "tool");

  const raw = await readFile(replayPath, "utf8");
  assert.equal(raw.includes("hello"), false);
  assert.equal(raw.includes('"requestDigest"'), true);

  const bindingStore = new AdmissionBindingStore({ filePath: join(directory, "binding.json") });
  const replayStore = new AdmissionReplayStore({ filePath: replayPath });
  const restarted = createAdmissionControlServer({
    plane: createAdmissionControlPlane({ bindingStore, replayStore }),
  }).listen(0);
  t.after(() => restarted.close());
  const address = restarted.address();
  const replayedResolve = createControlAdmissionResolver({
    url: `http://127.0.0.1:${address.port}/v1/admission`,
    workerName: binding.workerName,
    runtimeLane: binding.runtimeLane,
  });
  const replayed = await replayedResolve({ phase: "model", event: modelEvent() });
  assert.deepEqual(replayed, model);
});

test("durable Control API exposes a bounded readiness endpoint", async (t) => {
  const { directory, healthUrl } = await fixture(t);
  const response = await fetch(healthUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
  await rm(join(directory, "binding.json"), { force: true });
  const unavailable = await fetch(healthUrl);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "ADMISSION_CONTEXT_UNAVAILABLE" });
});

test("durable Control API rejects changed, wrong-actor, and pre-model tool requests", async (t) => {
  const { resolve } = await fixture(t);
  await resolve({ phase: "model", event: modelEvent() });
  await assert.rejects(
    resolve({ phase: "model", event: modelEvent("changed") }),
    (error) => error instanceof AdmissionDeniedError && error.code === "ADMISSION_REQUEST_CHANGED",
  );
  await assert.rejects(
    resolve({ phase: "model", event: modelEvent("hello", { senderId: "@intruder:example.test" }) }),
    (error) => error instanceof AdmissionDeniedError && error.code === "ADMISSION_ACTOR_INVALID",
  );
  await assert.rejects(
    resolve({ phase: "tool", event: toolEvent({ messageId: "$missing", sessionKey: "session-1" }) }),
    (error) => error instanceof AdmissionDeniedError && error.code === "ADMISSION_MODEL_REQUIRED",
  );
});

test("durable Control API rejects a replay after the binding revision changes", async (t) => {
  const { bindingStore, resolve } = await fixture(t);
  await resolve({ phase: "model", event: modelEvent() });
  await bindingStore.write({ ...binding, configRevision: "config-2" }, { updatedAt: "2026-08-15T00:00:02.000Z" });
  await assert.rejects(
    resolve({ phase: "model", event: modelEvent() }),
    (error) => error instanceof AdmissionDeniedError && error.code === "ADMISSION_REVISION_STALE",
  );
});
