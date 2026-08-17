import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdmissionDeniedError } from "../agent/gates/admission-boundary.mjs";
import {
  AdmissionContextFileStore,
  createFileAdmissionResolver,
} from "../agent/gates/admission-context-file.mjs";

const context = {
  source: { channel: "matrix", actorId: "@human:example.test", messageId: "$event", route: "team-room", authenticated: true },
  binding: { workerName: "worker-one", runtimeLane: "openclaw-canary", configRevision: "c1", capabilityRevision: "k1", allowedChannels: ["matrix"], active: true },
  request: { workerName: "worker-one", runtimeLane: "openclaw-canary", turnId: "turn-1", requestDigest: "digest-1", configRevision: "c1", capabilityRevision: "k1" },
};

test("writes and reopens a bounded admission context atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-admission-context-"));
  const filePath = join(directory, "admission.json");
  try {
    const store = new AdmissionContextFileStore({ filePath });
    const saved = await store.write(context, { updatedAt: "2026-08-13T00:00:00.000Z" });
    assert.equal(saved.version, 1);
    assert.deepEqual(await createFileAdmissionResolver({ filePath })(), context);
    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes("prompt-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed for missing, malformed, oversized, and stale-shaped context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-admission-context-invalid-"));
  const filePath = join(directory, "admission.json");
  try {
    const resolve = createFileAdmissionResolver({ filePath });
    await assert.rejects(resolve(), (error) => error instanceof AdmissionDeniedError && error.code === "ADMISSION_CONTEXT_UNAVAILABLE");
    const store = new AdmissionContextFileStore({ filePath });
    await store.write(context);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, "not-json"));
    await assert.rejects(resolve(), (error) => error instanceof AdmissionDeniedError && error.code === "ADMISSION_CONTEXT_INVALID");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
