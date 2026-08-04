import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  DEFAULT_AGENTTEAMS_RUNNER_BROKER_ENDPOINT,
  createRunnerBrokerExecutor,
  runnerBrokerEndpointForWorker,
} from "../agent/runner/broker-client.mjs";
import {
  createDockerPeerAuthenticator,
  createRunnerBrokerHandler,
  validateBrokerConfig,
} from "../agent/runner/broker-server.mjs";
import { runCommand, runnerInvocationIdentity } from "../agent/runner/runner-port.mjs";
import { createChangeRevisionRef } from "../agent/work/change-revision-ref.mjs";

const RUN_ID = "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID = "task-implement-a";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const WORKER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const REVISION_REF = createChangeRevisionRef({
  producerTaskId: TASK_ID,
  artifactPath: "objects/task-implement-a/revision",
  artifactDigest: "f".repeat(64),
  revision: 0,
});
const EVIDENCE = Object.freeze({
  schemaVersion: 1,
  runId: RUN_ID,
  invocationKey: "unused",
  imageId: IMAGE_ID,
  policyDigest: "c".repeat(64),
  containerConfigDigest: "d".repeat(64),
  fixtureDigest: "e".repeat(64),
});

function configInput() {
  return {
    schemaVersion: 1,
    network: "runner-test-net",
    listenPort: 18090,
    bindings: [{
      workerName: "tiangong-implementor",
      containerName: "agentteams-worker-tiangong-implementor",
      workerImageId: WORKER_IMAGE_ID,
      role: "implementor",
      taskId: TASK_ID,
      runId: RUN_ID,
      runnerImageId: IMAGE_ID,
      execution: { command: ["node", "test.mjs"], timeoutMs: 1000, outputLimitBytes: 1024 },
      revisionIndex: 0,
      fixtureId: "software-change-fixture",
      inputRevisionTaskId: null,
    }],
  };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/v1/execute`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function request() {
  return {
    runId: RUN_ID,
    command: ["node", "test.mjs"],
    cwd: "scratch/revision",
    timeoutMs: 1000,
    outputLimitBytes: 1024,
  };
}

test("broker client reaches only the bound Task and returns invocation-bound runner Evidence", async () => {
  const binding = validateBrokerConfig(configInput()).bindings[0];
  let executions = 0;
  const handler = createRunnerBrokerHandler({
    async authenticatePeer(address, taskId) {
      assert.equal(address, "127.0.0.1");
      assert.equal(taskId, TASK_ID);
      return binding;
    },
    async execute(receivedBinding, command) {
      executions += 1;
      assert.equal(receivedBinding, binding);
      const identity = runnerInvocationIdentity(command);
      return {
        outcome: "completed",
        invocationKey: identity.invocationKey,
        exitCode: 0,
        stdout: "tests passed\n",
        stderr: "",
        durationMs: 8,
        runnerEvidence: { ...EVIDENCE, invocationKey: identity.invocationKey },
        changeRevisionRef: REVISION_REF,
      };
    },
  });
  const server = await listen(handler);
  try {
    const executor = createRunnerBrokerExecutor({ endpoint: server.endpoint, taskId: TASK_ID });
    const plan = await executor.plan({ runId: RUN_ID });
    assert.deepEqual(plan.command, ["node", "test.mjs"]);
    assert.match(plan.contentDigest, /^[0-9a-f]{64}$/u);
    const result = await runCommand({
      runId: plan.runId,
      command: plan.command,
      cwd: plan.cwd,
      timeoutMs: plan.timeoutMs,
      outputLimitBytes: plan.outputLimitBytes,
    }, { executor, env: {} });
    assert.equal(result.outcome, "completed");
    assert.equal(result.stdout, "tests passed\n");
    assert.equal(result.runnerEvidence.imageId, IMAGE_ID);
    assert.equal(result.runnerEvidence.executionPlanDigest, plan.contentDigest);
    assert.equal(result.changeRevisionRef.contentDigest, REVISION_REF.contentDigest);
    assert.equal(executions, 1);
  } finally {
    await server.close();
  }
});

test("broker rejects Task, run, invocation, route, and peer mismatches before execution", async () => {
  const binding = validateBrokerConfig(configInput()).bindings[0];
  let executions = 0;
  const allowed = await listen(createRunnerBrokerHandler({
    async authenticatePeer() { return binding; },
    async execute() { executions += 1; },
  }));
  try {
    const identity = runnerInvocationIdentity(request());
    const base = {
      schemaVersion: 1,
      taskId: TASK_ID,
      invocationKey: identity.invocationKey,
      ...request(),
      env: {},
    };
    for (const body of [
      { ...base, taskId: "task-other" },
      { ...base, runId: "run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...base, invocationKey: "f".repeat(64) },
      { ...base, command: ["node", "other.mjs"] },
    ]) {
      const response = await fetch(allowed.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403);
    }
    const route = await fetch(allowed.endpoint.replace("/v1/execute", "/v1/other"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(route.status, 404);
    assert.equal(executions, 0);
  } finally {
    await allowed.close();
  }

  const denied = await listen(createRunnerBrokerHandler({
    async authenticatePeer() { throw new Error("untrusted"); },
    async execute() { executions += 1; },
  }));
  try {
    const executor = createRunnerBrokerExecutor({ endpoint: denied.endpoint, taskId: TASK_ID });
    await assert.rejects(() => executor.plan({ runId: RUN_ID }), /REQUEST_REJECTED/u);
    assert.equal(executions, 0);
  } finally {
    await denied.close();
  }
});

test("Docker peer authentication binds source IP, exact container, Worker name, image, and network", async () => {
  const config = validateBrokerConfig(configInput());
  const binding = config.bindings[0];
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    if (args[0] === "network") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{
          Name: config.network,
          Containers: {
            abc: { Name: binding.containerName, IPv4Address: "172.30.0.5/16" },
          },
        }]),
        stderr: "",
        timedOut: false,
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify([{
        Name: `/${binding.containerName}`,
        Image: binding.workerImageId,
        State: { Running: true },
        Config: { Env: [`AGENTTEAMS_WORKER_NAME=${binding.workerName}`] },
        NetworkSettings: { Networks: { [config.network]: { IPAddress: "172.30.0.5" } } },
      }]),
      stderr: "",
      timedOut: false,
    };
  };
  const authenticate = createDockerPeerAuthenticator({ config, runDocker });
  assert.equal(await authenticate("::ffff:172.30.0.5"), binding);
  const sequentialConfig = validateBrokerConfig({
    ...configInput(),
    bindings: [
      configInput().bindings[0],
      {
        ...configInput().bindings[0],
        taskId: "task-implement-b",
        runId: "run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        revisionIndex: 1,
      },
    ],
  });
  const authenticateSequential = createDockerPeerAuthenticator({ config: sequentialConfig, runDocker });
  assert.equal((await authenticateSequential("172.30.0.5", "task-implement-b")).taskId, "task-implement-b");
  await assert.rejects(() => authenticateSequential("172.30.0.5"), /TASK_REQUIRED/u);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ["network", "inspect", config.network],
    ["container", "inspect", binding.containerName],
    ["network", "inspect", sequentialConfig.network],
    ["container", "inspect", binding.containerName],
    ["network", "inspect", sequentialConfig.network],
  ]);

  const mismatch = createDockerPeerAuthenticator({
    config,
    runDocker: async (args) => {
      const result = await runDocker(args);
      if (args[0] === "container") {
        const [container] = JSON.parse(result.stdout);
        container.Image = IMAGE_ID;
        result.stdout = JSON.stringify([container]);
      }
      return result;
    },
  });
  await assert.rejects(() => mismatch("172.30.0.5"), /IDENTITY_MISMATCH/u);
});

test("AgentTeams professional Workers use the fixed broker service when custom env is unavailable", () => {
  assert.equal(runnerBrokerEndpointForWorker({
    role: "implementor",
    env: { AGENTTEAMS_WORKER_NAME: "impl" },
  }), DEFAULT_AGENTTEAMS_RUNNER_BROKER_ENDPOINT);
  assert.equal(runnerBrokerEndpointForWorker({
    role: "assessor",
    env: { AGENTTEAMS_WORKER_NAME: "assess", TIANGONG_RUNNER_BROKER_ENDPOINT: "http://custom-broker:9000/v1/execute" },
  }), "http://custom-broker:9000/v1/execute");
  assert.equal(runnerBrokerEndpointForWorker({ role: "operator", env: { AGENTTEAMS_WORKER_NAME: "op" } }), undefined);
  assert.equal(runnerBrokerEndpointForWorker({ role: "implementor", env: {} }), undefined);
  assert.throws(
    () => runnerBrokerEndpointForWorker({ role: "implementor", env: { AGENTTEAMS_WORKER_NAME: "impl", TIANGONG_RUNNER_BROKER_ENDPOINT: "" } }),
    /empty/,
  );
});

test("broker config and client endpoint are closed, bounded contracts", () => {
  assert.throws(
    () => validateBrokerConfig({ ...configInput(), extra: true }),
    /missing or unknown/u,
  );
  const malformedPlan = configInput();
  malformedPlan.bindings[0].execution.command = [];
  assert.throws(() => validateBrokerConfig(malformedPlan), /non-empty string array/u);
  const duplicate = configInput();
  duplicate.bindings.push({ ...duplicate.bindings[0] });
  assert.throws(() => validateBrokerConfig(duplicate), /unique Task/u);
  const sequential = configInput();
  sequential.bindings.push({
    ...sequential.bindings[0],
    taskId: "task-implement-b",
    runId: "run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    revisionIndex: 1,
  });
  assert.equal(validateBrokerConfig(sequential).bindings.length, 2);
  const paired = configInput();
  paired.bindings.push({
    workerName: "tiangong-assessor",
    containerName: "agentteams-worker-tiangong-assessor",
    workerImageId: WORKER_IMAGE_ID,
    role: "assessor",
    taskId: "task-assess-a",
    runId: "run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    runnerImageId: IMAGE_ID,
    execution: { command: ["node", "test.mjs"], timeoutMs: 1000, outputLimitBytes: 1024 },
    revisionIndex: 0,
    fixtureId: null,
    inputRevisionTaskId: TASK_ID,
  });
  assert.equal(validateBrokerConfig(paired).bindings.length, 2);
  paired.bindings[1].revisionIndex = 1;
  assert.throws(() => validateBrokerConfig(paired), /same revision/u);
  assert.throws(
    () => createRunnerBrokerExecutor({ endpoint: "http://user:secret@broker/v1/execute", taskId: TASK_ID }),
    /credential-free/u,
  );
  assert.throws(
    () => createRunnerBrokerExecutor({ endpoint: "http://broker/v1/other", taskId: TASK_ID }),
    /credential-free/u,
  );
});
