import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import {
  createDockerPeerAuthenticator,
  createRunnerBrokerBindingRegistry,
  createRunnerBrokerPreparationService,
  runnerBrokerBindingDigest,
  validateBrokerConfig,
} from "../agent/runner/broker-server.mjs";
import { RUNNER_BROKER_ENDPOINT_DIGEST } from "../agent/runner/preparation-client.mjs";

const LEADER_IMAGE = `sha256:${"1".repeat(64)}`;
const IMPLEMENTOR_IMAGE = `sha256:${"2".repeat(64)}`;
const ASSESSOR_IMAGE = `sha256:${"3".repeat(64)}`;
const RUNNER_IMPLEMENTOR = `sha256:${"4".repeat(64)}`;
const RUNNER_ASSESSOR = `sha256:${"5".repeat(64)}`;
const CREATED = "2026-08-03T12:00:00Z";

function project() {
  return createProjectBinding({
    projectId: "broker-prep-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookId: "software-change-delivery",
    playbookVersion: "1.0.0",
    playbookDigest: sha256("playbook"),
    requester: "@requester:example.test",
    roleBindings: {
      team_leader: "tiangong-leader",
      designer: "tiangong-designer",
      implementor: "tiangong-implementor",
      assessor: "tiangong-assessor",
      operator: "tiangong-operator",
    },
    createdAt: CREATED,
  });
}

function task(boundProject, taskKind, taskId, assignee, inputRefs = [], revisionIndex = 0) {
  return createTaskBinding({
    taskId,
    projectId: boundProject.projectId,
    playbookStepId: `software-change-delivery-transition-v1:${taskKind}`,
    taskKind,
    revisionIndex,
    assignee,
    objective: `Prepare the ${taskKind} Runner binding.`,
    completionContractDigest: sha256("contract"),
    sourceProfileDigest: sha256(`${taskKind}-profile`),
    sourceSkillId: `${taskKind}-v1`,
    sourceSkillDigest: sha256(`${taskKind}-skill`),
    inputRefs,
    createdAt: CREATED,
  });
}

function config() {
  return validateBrokerConfig({
    schemaVersion: 1,
    network: "agentteams-net",
    listenPort: 8787,
    bindings: [],
    preparation: {
      leaderImageId: LEADER_IMAGE,
      runnerImageIds: { implementor: RUNNER_IMPLEMENTOR, assessor: RUNNER_ASSESSOR },
    },
  });
}

function dockerAdapter() {
  const containers = {
    "agentteams-worker-tiangong-leader": {
      Name: "/agentteams-worker-tiangong-leader",
      Image: LEADER_IMAGE,
      State: { Running: true, Paused: false },
      Config: { Env: ["AGENTTEAMS_WORKER_NAME=tiangong-leader"] },
      NetworkSettings: { Networks: { "agentteams-net": { IPAddress: "172.30.0.2" } } },
    },
    "agentteams-worker-tiangong-implementor": {
      Name: "/agentteams-worker-tiangong-implementor",
      Image: IMPLEMENTOR_IMAGE,
      State: { Running: true, Paused: true },
      Config: { Env: ["AGENTTEAMS_WORKER_NAME=tiangong-implementor"] },
      NetworkSettings: { Networks: { "agentteams-net": { IPAddress: "172.30.0.3" } } },
    },
    "agentteams-worker-tiangong-assessor": {
      Name: "/agentteams-worker-tiangong-assessor",
      Image: ASSESSOR_IMAGE,
      State: { Running: true, Paused: true },
      Config: { Env: ["AGENTTEAMS_WORKER_NAME=tiangong-assessor"] },
      NetworkSettings: { Networks: { "agentteams-net": { IPAddress: "172.30.0.4" } } },
    },
  };
  const network = {
    Name: "agentteams-net",
    Containers: Object.fromEntries(Object.entries(containers).map(([name, value], index) => [
      `id-${index}`,
      { Name: name, IPv4Address: `${value.NetworkSettings.Networks["agentteams-net"].IPAddress}/16` },
    ])),
  };
  return async (args) => {
    if (args[0] === "network" && args[1] === "inspect") {
      return { exitCode: 0, timedOut: false, stdout: JSON.stringify([network]), stderr: "" };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const value = containers[args[2]];
      return value
        ? { exitCode: 0, timedOut: false, stdout: JSON.stringify([value]), stderr: "" }
        : { exitCode: 1, timedOut: false, stdout: "", stderr: "" };
    }
    throw new Error("unexpected docker operation");
  };
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-runner-preparation-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("preparation registers one immutable binding before notification, accepts exact replay, and persists it", async () => {
  await withRoot(async (stateRoot) => {
    const boundProject = project();
    const implementTask = task(boundProject, "implement", "prep-implement-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tiangong-implementor");
    const assessTask = task(boundProject, "assess", "prep-assess-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tiangong-assessor", [implementTask.taskId]);
    const brokerConfig = config();
    const registry = await createRunnerBrokerBindingRegistry({ config: brokerConfig, stateRoot });
    const service = createRunnerBrokerPreparationService({ config: brokerConfig, registry, runDocker: dockerAdapter() });

    const first = await service("172.30.0.2", {
      schemaVersion: 1,
      projectBinding: boundProject,
      taskBinding: implementTask,
      inputTaskBinding: null,
    });
    assert.equal(first.status, "ready");
    assert.equal(first.replayed, false);
    assert.equal(first.endpointDigest, RUNNER_BROKER_ENDPOINT_DIGEST);
    assert.equal(Object.hasOwn(first, "endpoint"), false);
    const registeredImplement = registry.get(implementTask.taskId);
    assert.equal(registeredImplement.role, "implementor");
    assert.deepEqual(registeredImplement.execution.command, ["node", "probe.mjs"]);
    assert.equal(registeredImplement.execution.timeoutMs, 30000);
    assert.equal(registeredImplement.execution.outputLimitBytes, 65536);
    assert.equal(runnerBrokerBindingDigest(registeredImplement), first.bindingDigest);

    const replay = await service("172.30.0.2", {
      schemaVersion: 1,
      projectBinding: boundProject,
      taskBinding: implementTask,
      inputTaskBinding: null,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.bindingDigest, first.bindingDigest);

    const preparedAssess = await service("172.30.0.2", {
      schemaVersion: 1,
      projectBinding: boundProject,
      taskBinding: assessTask,
      inputTaskBinding: implementTask,
    });
    assert.equal(preparedAssess.status, "ready");
    assert.equal(registry.get(assessTask.taskId).inputRevisionTaskId, implementTask.taskId);

    const revisionTask = task(
      boundProject,
      "implement",
      "prep-implement-revision-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "tiangong-implementor",
      [],
      1,
    );
    const preparedRevision = await service("172.30.0.2", {
      schemaVersion: 1,
      projectBinding: boundProject,
      taskBinding: revisionTask,
      inputTaskBinding: null,
    });
    assert.equal(preparedRevision.status, "ready");
    assert.equal(preparedRevision.replayed, false);
    assert.equal(registry.config().bindings.length, 3);
    const sequentialAuthenticator = createDockerPeerAuthenticator({
      config: registry.config(),
      runDocker: dockerAdapter(),
    });
    assert.equal(
      (await sequentialAuthenticator("172.30.0.3", revisionTask.taskId)).taskId,
      revisionTask.taskId,
    );

    const restarted = await createRunnerBrokerBindingRegistry({ config: brokerConfig, stateRoot });
    assert.equal(restarted.get(implementTask.taskId).taskId, implementTask.taskId);
    assert.equal(restarted.get(assessTask.taskId).taskId, assessTask.taskId);
  });
});

test("preparation rejects non-Leader peers, missing inputs, and binding conflicts before Worker notification", async () => {
  await withRoot(async (stateRoot) => {
    const boundProject = project();
    const implementTask = task(boundProject, "implement", "prep-negative-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tiangong-implementor");
    const brokerConfig = config();
    const registry = await createRunnerBrokerBindingRegistry({ config: brokerConfig, stateRoot });
    const service = createRunnerBrokerPreparationService({ config: brokerConfig, registry, runDocker: dockerAdapter() });
    const request = { schemaVersion: 1, projectBinding: boundProject, taskBinding: implementTask, inputTaskBinding: null };
    await assert.rejects(() => service("172.30.0.3", request), /PEER_UNAUTHORIZED/u);
    await assert.rejects(() => service("172.30.0.2", { ...request, inputTaskBinding: implementTask }), /INPUT_INVALID/u);
    await service("172.30.0.2", request);
    const changed = createTaskBinding({
      ...implementTask,
      objective: "changed immutable objective",
      contentDigest: undefined,
    });
    await assert.rejects(
      () => service("172.30.0.2", { ...request, taskBinding: changed }),
      /BINDING_CONFLICT/u,
    );
  });
});

test("Runner peer authentication remains closed over the dynamically registered exact Worker", async () => {
  await withRoot(async (stateRoot) => {
    const brokerConfig = config();
    const registry = await createRunnerBrokerBindingRegistry({ config: brokerConfig, stateRoot });
    await assert.rejects(
      () => createDockerPeerAuthenticator({ config: registry.config(), runDocker: dockerAdapter() })("172.30.0.3"),
      /PEER_UNAUTHORIZED/u,
    );
  });
});
