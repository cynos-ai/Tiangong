import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanaryAdmissionResolver } from "../agent/gates/canary-admission.mjs";

test("admits an allowlisted canary Matrix turn and reuses its model admission for tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-canary-admission-"));
  const configPath = join(directory, "openclaw.json");
  try {
    await writeFile(configPath, JSON.stringify({
      channels: {
        matrix: {
          groupAllowFrom: ["@manager:example.test"],
          dm: { allowFrom: ["@admin:example.test"] },
        },
      },
    }), { mode: 0o600 });
    const resolve = createCanaryAdmissionResolver({
      configPath,
      workerName: "worker-one",
      runtimeLane: "openclaw-canary",
    });
    const model = await resolve({
      phase: "model",
      event: { senderId: "@manager:example.test", messageId: "$event-1", sessionKey: "matrix:room" },
      ctx: {},
    });
    assert.equal(model.source.authenticated, true);
    assert.equal(model.source.channel, "matrix");
    assert.equal(model.binding.workerName, "worker-one");
    const tool = await resolve({
      phase: "tool",
      event: { toolName: "read", sessionKey: "matrix:room" },
      ctx: {},
    });
    assert.equal(tool.admission.phase, "model");
    assert.equal(tool.toolName, "read");
    assert.equal(tool.requestDigest, model.request.requestDigest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed for an actor outside the Matrix allowlist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-canary-admission-denied-"));
  const configPath = join(directory, "openclaw.json");
  try {
    await writeFile(configPath, JSON.stringify({ channels: { matrix: { groupAllowFrom: ["@manager:example.test"] } } }), { mode: 0o600 });
    const resolve = createCanaryAdmissionResolver({ configPath, workerName: "worker-one", runtimeLane: "openclaw-canary" });
    await assert.rejects(
      resolve({ phase: "model", event: { senderId: "@unknown:example.test", messageId: "$event-2" }, ctx: {} }),
      /canary Matrix actor is not allowlisted/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses the bounded file admission when model and tool hooks run in different processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-canary-admission-file-"));
  const configPath = join(directory, "openclaw.json");
  const admissionFile = join(directory, "admission.json");
  try {
    await writeFile(configPath, JSON.stringify({ channels: { matrix: { groupAllowFrom: ["@manager:example.test"] } } }), { mode: 0o600 });
    const modelResolver = createCanaryAdmissionResolver({ configPath, admissionFile, workerName: "worker-one", runtimeLane: "openclaw-canary" });
    await modelResolver({ phase: "model", event: { senderId: "@manager:example.test", messageId: "$event-file", sessionKey: "matrix:file" }, ctx: {} });
    const toolResolver = createCanaryAdmissionResolver({ configPath, admissionFile, workerName: "worker-one", runtimeLane: "openclaw-canary" });
    const tool = await toolResolver({ phase: "tool", event: { toolName: "read", sessionKey: "matrix:file" }, ctx: {} });
    assert.equal(tool.admission.phase, "model");
    assert.equal(tool.toolName, "read");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
