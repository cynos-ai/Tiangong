import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenCodexSidecarController,
  OpenCodexSidecarError,
  OPENCODEX_SIDECAR_BRIDGE,
  OPENCODEX_SIDECAR_CREDENTIAL_SOURCE,
  OPENCODEX_SIDECAR_SCHEMA_VERSION,
  OPENCODEX_SIDECAR_TRANSPORT,
  isOpenCodexSidecarSnapshot,
  validateOpenCodexSidecarBinding,
} from "../agent/deployment/opencodex-sidecar.mjs";

const binding = Object.freeze({
  schemaVersion: OPENCODEX_SIDECAR_SCHEMA_VERSION,
  teamId: "team-qwen-canary",
  workerId: "worker-qwen-member",
  image: "ghcr.io/example/opencodex:2.15.0",
  endpoint: "http://opencodex-sidecar:8787",
  provider: "agentteams-gateway",
  model: "qwen3.7-plus",
  transport: OPENCODEX_SIDECAR_TRANSPORT,
  bridge: OPENCODEX_SIDECAR_BRIDGE,
  credentialSource: OPENCODEX_SIDECAR_CREDENTIAL_SOURCE,
  credentialRef: "agentteams://credentials/worker-qwen-member-g1",
  generation: 1,
});

function adapterFixture({ fail = new Set(), observedPhase = "ready" } = {}) {
  const calls = [];
  const adapter = {
    async provision(value) {
      calls.push(["provision", value]);
      if (fail.has("provision")) throw new Error("fixture provision failure");
      return { endpoint: value.endpoint, image: value.image, sidecarId: "sidecar-qwen-member" };
    },
    async probe({ binding: value }) {
      calls.push(["probe", value]);
      if (fail.has("probe")) throw new Error("fixture probe failure");
      return { generation: value.generation, healthz: "pass", model: value.model, provider: value.provider, readyz: "pass" };
    },
    async status({ binding: value }) {
      calls.push(["status", value]);
      return { generation: value?.generation ?? 1, phase: observedPhase };
    },
    async rotate(value) {
      calls.push(["rotate", value]);
      if (fail.has("rotate")) throw new Error("fixture rotation failure");
      return { generation: value.generation, status: "pass" };
    },
    async drain(value) {
      calls.push(["drain", value]);
      if (fail.has("drain")) throw new Error("fixture drain failure");
      return { generation: value.binding.generation, status: "pass" };
    },
    async remove(value) {
      calls.push(["remove", value]);
      if (fail.has("remove")) throw new Error("fixture remove failure");
      return { generation: 2, status: "pass" };
    },
  };
  return { adapter, calls };
}

test("validates the explicit bridge binding without accepting upstream credentials", () => {
  assert.deepEqual(validateOpenCodexSidecarBinding(binding), binding);
  assert.throws(
    () => validateOpenCodexSidecarBinding({ ...binding, endpoint: "http://localhost:8787" }),
    (error) => error instanceof OpenCodexSidecarError && error.code === "invalid-binding",
  );
  assert.throws(
    () => validateOpenCodexSidecarBinding({ ...binding, apiKey: "sk-never-persist-this" }),
    (error) => error instanceof OpenCodexSidecarError && error.code === "invalid-schema",
  );
});

test("runs provision, readiness, rotation, drain, remove, and restart reconciliation", async () => {
  const first = adapterFixture();
  const controller = new OpenCodexSidecarController({ adapter: first.adapter, clock: () => "2026-08-14T00:00:00.000Z" });
  assert.equal(controller.phase, "absent");
  assert.equal((await controller.provision(binding)).replayed, false);
  assert.equal(controller.phase, "provisioning");
  await controller.ready();
  assert.equal(controller.phase, "ready");

  const replay = await controller.provision(binding);
  assert.equal(replay.replayed, true);
  assert.equal(first.calls.filter(([name]) => name === "provision").length, 1);

  const rotated = await controller.rotate({
    credentialRef: "agentteams://credentials/worker-qwen-member-g2",
    generation: 2,
  });
  assert.equal(rotated.receipt.generation, 2);
  assert.equal(controller.phase, "ready");

  const snapshot = controller.snapshot();
  assert.equal(isOpenCodexSidecarSnapshot(snapshot), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /sk-|apiKey|access_token|authorization/iu);

  const restarted = new OpenCodexSidecarController({ adapter: first.adapter, snapshot });
  await restarted.reconcile();
  assert.equal(restarted.phase, "ready");
  await restarted.drain();
  assert.equal(restarted.phase, "drained");
  await restarted.remove();
  assert.equal(restarted.phase, "removed");
  assert.equal(restarted.snapshot().binding, null);
});

test("readiness failure keeps the Worker blocked before ready", async () => {
  const { adapter } = adapterFixture({ fail: new Set(["probe"]) });
  const controller = new OpenCodexSidecarController({ adapter });
  await controller.provision(binding);
  await assert.rejects(controller.ready(), /fixture probe failure/);
  assert.equal(controller.phase, "provisioning");
  await assert.rejects(controller.drain(), (error) => error.code === "sidecar-phase-invalid");
});

test("rotation and drain uncertainty fail closed until status reconciliation", async () => {
  const rotation = adapterFixture({ fail: new Set(["rotate"]) });
  const controller = new OpenCodexSidecarController({ adapter: rotation.adapter });
  await controller.provision(binding);
  await controller.ready();
  await assert.rejects(
    controller.rotate({ credentialRef: "agentteams://credentials/worker-qwen-member-g2", generation: 2 }),
    /fixture rotation failure/,
  );
  assert.equal(controller.phase, "rotating");
  await assert.rejects(controller.drain(), (error) => error.code === "sidecar-phase-invalid");

  const drain = adapterFixture({ fail: new Set(["drain"]) });
  const drainController = new OpenCodexSidecarController({ adapter: drain.adapter });
  await drainController.provision(binding);
  await drainController.ready();
  await assert.rejects(drainController.drain(), /fixture drain failure/);
  assert.equal(drainController.phase, "draining");
  await assert.rejects(drainController.remove(), (error) => error.code === "sidecar-phase-invalid");
});
