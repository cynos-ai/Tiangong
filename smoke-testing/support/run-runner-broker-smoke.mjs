#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDockerCommandRunner } from "../../worker/agent/runner/docker-executor.mjs";
import { FORBIDDEN_ENV_KEYS, FORBIDDEN_NETWORK_TARGETS } from "../../worker/agent/runner/runner-policy.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const fixture = path.join(root, "smoke-testing/fixtures/runner-isolation");
const brokerImage = process.env.TIANGONG_RUNNER_BROKER_IMAGE ?? "tiangong-runner-broker:dev";
const workerImage = process.env.TIANGONG_RUNNER_IMAGE ?? "tiangong-worker-implementor:dev";
const assessorImage = process.env.TIANGONG_ASSESSOR_IMAGE ?? "tiangong-worker-assessor:dev";
const dockerPath = process.env.TIANGONG_DOCKER_PATH ?? "/usr/bin/docker";
const runDocker = createDockerCommandRunner({ dockerPath });
const nonce = randomUUID();
const suffix = nonce.replaceAll("-", "").slice(0, 16);
const runId = `run-${nonce}`;
const assessorRunId = `run-${randomUUID()}`;
const smokeStartedAt = Math.floor(Date.now() / 1000) - 1;
const taskId = `task-runner-${suffix}`;
const assessorTaskId = `task-assess-${suffix}`;
const workerName = `tiangong-runner-${suffix}`;
const assessorWorkerName = `tiangong-assessor-${suffix}`;
const network = `tiangong-runner-broker-${suffix}`;
const broker = `tiangong-runner-broker-${suffix}`;
const client = `tiangong-runner-client-${suffix}`;
const assessorClient = `tiangong-assessor-client-${suffix}`;
const intruder = `tiangong-runner-intruder-${suffix}`;
const stateVolume = `tiangong-runner-broker-state-${suffix}`;
const ownerLabel = `io.tiangong.broker-run=${runId}`;
const implementCommand = ["node", "--input-type=module", "-e", "await import('./probe.mjs'); const fs = await import('node:fs/promises'); await fs.appendFile('input.txt', 'sealed-change\\n');"];
const assessCommand = ["node", "--input-type=module", "-e", "const fs = await import('node:fs/promises'); const value = await fs.readFile('input.txt', 'utf8'); if (!value.endsWith('sealed-change\\n')) process.exit(41); try { await fs.appendFile('input.txt', 'forbidden'); process.exit(42); } catch (error) { if (!['EACCES', 'EROFS'].includes(error.code)) throw error; } console.log('assessor_revision_readonly=pass');"];
const tempRoot = await mkdtemp(path.join(tmpdir(), "tiangong-runner-broker-smoke-"));
const configPath = path.join(tempRoot, "config.json");
let cleanupFailed = false;

function fail(message) {
  process.stderr.write(`[Tiangong] ERROR: ${message}\n`);
  process.exitCode = 1;
}

async function docker(args, options = {}) {
  return runDocker(args, { timeoutMs: options.timeoutMs ?? 60_000, outputLimitBytes: 4 * 1024 * 1024 });
}

async function requireDocker(args, code, options) {
  const result = await docker(args, options);
  if (result.timedOut || result.exitCode !== 0) throw new Error(code);
  return result;
}

async function inspectId(image) {
  const result = await requireDocker(["image", "inspect", "--format", "{{.Id}}", image], "image inspect failed");
  const value = result.stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error("image did not resolve to an immutable ID");
  return value;
}

async function assertAbsent(kind, name) {
  const result = await docker([kind, "inspect", name]);
  if (result.exitCode === 0) throw new Error(`reserved ${kind} already exists: ${name}`);
}

async function removeOwned(kind, name) {
  const inspected = await docker([kind, "inspect", name]);
  if (inspected.exitCode !== 0) return;
  let value;
  try {
    [value] = JSON.parse(inspected.stdout);
  } catch {
    cleanupFailed = true;
    return;
  }
  const labels = kind === "network" ? value?.Labels : (kind === "volume" ? value?.Labels : value?.Config?.Labels);
  if (labels?.["io.tiangong.broker-run"] !== runId) {
    cleanupFailed = true;
    return;
  }
  const args = kind === "container" ? ["container", "rm", "--force", name] : [kind, "rm", name];
  const removed = await docker(args);
  if (removed.exitCode !== 0 || (await docker([kind, "inspect", name])).exitCode === 0) cleanupFailed = true;
}

const clientProgram = String.raw`
const [{ createRunnerBrokerExecutor }, { RunnerJournal }, policy, { runCommand, runnerInvocationIdentity }] = await Promise.all([
  import("/opt/tiangong-worker/agent/runner/broker-client.mjs"),
  import("/opt/tiangong-worker/agent/runner/journal.mjs"),
  import("/opt/tiangong-worker/agent/runner/runner-policy.mjs"),
  import("/opt/tiangong-worker/agent/runner/runner-port.mjs"),
]);
const env = {
  TIANGONG_FORBIDDEN_ENV_NAMES: policy.FORBIDDEN_ENV_KEYS.join(","),
  TIANGONG_FORBIDDEN_NETWORK_TARGETS: policy.FORBIDDEN_NETWORK_TARGETS.join(","),
};
const executor = createRunnerBrokerExecutor({ endpoint: process.env.TEST_BROKER_ENDPOINT, taskId: process.env.TEST_TASK_ID });
const plan = await executor.plan({ runId: process.env.TEST_RUN_ID });
console.log("runner_broker_plan=pass plan_digest=" + plan.contentDigest);
const request = { runId: plan.runId, command: plan.command, cwd: plan.cwd, timeoutMs: plan.timeoutMs, outputLimitBytes: plan.outputLimitBytes };
const altered = { ...request, command: ["node", "-e", "process.exit(99)"] };
const alteredIdentity = runnerInvocationIdentity(altered);
const rejected = await fetch(process.env.TEST_BROKER_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, taskId: process.env.TEST_TASK_ID, invocationKey: alteredIdentity.invocationKey, ...altered, env }) });
if (rejected.status !== 403) process.exit(20);
console.log("runner_broker_changed_plan_rejected=pass");
const first = await runCommand(request, {
  executor,
  journal: new RunnerJournal({ filePath: "/tmp/client-first.jsonl" }),
  env,
});
if (first.outcome !== "completed" || first.exitCode !== 0 || first.stdout.trim() !== "runner_probe=pass" ||
    !first.changeRevisionRef || first.changeRevisionRef.producerTaskId !== process.env.TEST_TASK_ID) {
  console.error("runner_client_failure outcome=" + first.outcome + " exit=" + first.exitCode +
    " stdout_match=" + (first.stdout?.trim() === "runner_probe=pass") +
    " revision_present=" + Boolean(first.changeRevisionRef) + " reason=" + (first.reason ?? "none"));
  process.exit(21);
}
const brokerReplay = await runCommand(request, {
  executor,
  journal: new RunnerJournal({ filePath: "/tmp/client-second.jsonl" }),
  env,
});
if (brokerReplay.outcome !== "completed" || brokerReplay.invocationKey !== first.invocationKey) process.exit(22);
console.log("runner_broker_client=pass");
console.log("runner_broker_evidence=pass invocation_key=" + first.invocationKey + " policy_digest=" + first.runnerEvidence.policyDigest);
console.log("runner_broker_revision_sealed=pass artifact_digest=" + first.changeRevisionRef.artifactDigest);
console.log("runner_broker_replay=pass");
`;

const assessorProgram = String.raw`
const [{ createRunnerBrokerExecutor }, { RunnerJournal }, { runCommand }] = await Promise.all([
  import("/opt/tiangong-worker/agent/runner/broker-client.mjs"),
  import("/opt/tiangong-worker/agent/runner/journal.mjs"),
  import("/opt/tiangong-worker/agent/runner/runner-port.mjs"),
]);
const executor = createRunnerBrokerExecutor({ endpoint: process.env.TEST_BROKER_ENDPOINT, taskId: process.env.TEST_TASK_ID });
const plan = await executor.plan({ runId: process.env.TEST_RUN_ID });
const request = { runId: plan.runId, command: plan.command, cwd: plan.cwd, timeoutMs: plan.timeoutMs, outputLimitBytes: plan.outputLimitBytes };
const result = await runCommand(request, {
  executor,
  journal: new RunnerJournal({ filePath: "/tmp/assessor.jsonl" }),
  env: {},
});
if (result.outcome !== "completed" || result.exitCode !== 0 ||
    result.stdout.trim() !== "assessor_revision_readonly=pass" || !result.changeRevisionRef ||
    result.changeRevisionRef.producerTaskId !== process.env.TEST_PRODUCER_TASK_ID ||
    result.runnerEvidence.fixtureDigest !== result.changeRevisionRef.artifactDigest) process.exit(43);
console.log("runner_broker_assessor_materialization=pass artifact_digest=" + result.changeRevisionRef.artifactDigest);
console.log("runner_broker_assessor_readonly=pass");
`;

const intruderProgram = String.raw`
const { createRunnerBrokerExecutor } = await import("/opt/tiangong-worker/agent/runner/broker-client.mjs");
const executor = createRunnerBrokerExecutor({ endpoint: process.env.TEST_BROKER_ENDPOINT, taskId: process.env.TEST_TASK_ID });
try { await executor.plan({ runId: process.env.TEST_RUN_ID }); process.exit(31); }
catch (error) { if (!String(error.message).includes("REQUEST_REJECTED")) throw error; }
console.log("runner_broker_unauthorized_peer=pass");
`;

try {
  for (const [kind, name] of [
    ["network", network], ["container", broker], ["container", client], ["container", assessorClient],
    ["container", intruder], ["volume", stateVolume],
  ]) await assertAbsent(kind, name);

  const [workerImageId, assessorImageId, brokerImageId] = await Promise.all([
    inspectId(workerImage), inspectId(assessorImage), inspectId(brokerImage),
  ]);
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    network,
    listenPort: 18090,
    bindings: [{
      workerName,
      containerName: client,
      workerImageId,
      role: "implementor",
      taskId,
      runId,
      runnerImageId: workerImageId,
      execution: { command: implementCommand, timeoutMs: 30000, outputLimitBytes: 65536 },
      revisionIndex: 0,
      fixtureId: "isolation",
      inputRevisionTaskId: null,
    }, {
      workerName: assessorWorkerName,
      containerName: assessorClient,
      workerImageId: assessorImageId,
      role: "assessor",
      taskId: assessorTaskId,
      runId: assessorRunId,
      runnerImageId: assessorImageId,
      execution: { command: assessCommand, timeoutMs: 30000, outputLimitBytes: 65536 },
      revisionIndex: 0,
      fixtureId: null,
      inputRevisionTaskId: taskId,
    }],
  })}\n`, { mode: 0o444 });
  await chmod(configPath, 0o444);

  await requireDocker(["network", "create", "--label", ownerLabel, network], "broker network create failed");
  await requireDocker(["volume", "create", "--label", ownerLabel, stateVolume], "broker state volume create failed");
  await requireDocker([
    "container", "create",
    "--name", broker,
    "--label", ownerLabel,
    "--network", network,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", "512m",
    "--cpus", "1",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--env", "HOME=/tmp",
    "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    "--mount", `type=bind,src=${configPath},dst=/run/tiangong-runner-broker/config.json,readonly`,
    "--mount", `type=bind,src=${fixture},dst=/opt/tiangong-runner-fixtures/isolation,readonly`,
    "--mount", `type=volume,src=${stateVolume},dst=/var/lib/tiangong-runner-broker`,
    brokerImageId,
  ], "broker container create failed");
  await requireDocker(["container", "start", broker], "broker container start failed");

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logs = await docker(["container", "logs", broker]);
    if (logs.stdout.includes("runner_broker_ready=pass")) { ready = true; break; }
    const state = await requireDocker(["container", "inspect", "--format", "{{.State.Running}}", broker], "broker inspect failed");
    if (state.stdout.trim() !== "true") {
      const diagnostic = `${logs.stdout}\n${logs.stderr}`.trim().slice(0, 1024).replaceAll(tempRoot, "<temp>");
      throw new Error(`broker stopped before readiness: ${diagnostic || "no bounded logs"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("broker readiness timed out");
  process.stdout.write("runner_broker_ready=pass\n");

  const commonClientArgs = [
    "--network", network,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", "256m",
    "--cpus", "1",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--env", `TEST_BROKER_ENDPOINT=http://${broker}:18090/v1/execute`,
  ];
  const clientResult = await docker([
    "container", "run", "--name", client, "--label", ownerLabel,
    ...commonClientArgs,
    "--env", `TEST_TASK_ID=${taskId}`,
    "--env", `TEST_RUN_ID=${runId}`,
    "--env", `AGENTTEAMS_WORKER_NAME=${workerName}`,
    "--entrypoint", "/usr/bin/node", workerImageId,
    "--input-type=module", "-e", clientProgram,
  ], { timeoutMs: 120_000 });
  if (clientResult.timedOut || clientResult.exitCode !== 0 ||
      !clientResult.stdout.includes("runner_broker_client=pass") ||
      !clientResult.stdout.includes("runner_broker_plan=pass") ||
      !clientResult.stdout.includes("runner_broker_changed_plan_rejected=pass") ||
      !clientResult.stdout.includes("runner_broker_replay=pass")) {
    const brokerLogs = await docker(["container", "logs", broker]);
    const diagnostic = `client_exit=${clientResult.exitCode} timed_out=${clientResult.timedOut}\n${clientResult.stderr}\n${brokerLogs.stderr}\n${clientResult.stdout}\n${brokerLogs.stdout}`
      .trim().slice(0, 2048).replaceAll(tempRoot, "<temp>");
    throw new Error(`authorized broker client failed: ${diagnostic || "no bounded logs"}`);
  }
  process.stdout.write(clientResult.stdout);

  const assessorResult = await docker([
    "container", "run", "--name", assessorClient, "--label", ownerLabel,
    ...commonClientArgs,
    "--env", `TEST_TASK_ID=${assessorTaskId}`,
    "--env", `TEST_PRODUCER_TASK_ID=${taskId}`,
    "--env", `TEST_RUN_ID=${assessorRunId}`,
    "--env", `AGENTTEAMS_WORKER_NAME=${assessorWorkerName}`,
    "--entrypoint", "/usr/bin/node", assessorImageId,
    "--input-type=module", "-e", assessorProgram,
  ], { timeoutMs: 120_000 });
  if (assessorResult.timedOut || assessorResult.exitCode !== 0 ||
      !assessorResult.stdout.includes("runner_broker_assessor_materialization=pass") ||
      !assessorResult.stdout.includes("runner_broker_assessor_readonly=pass")) {
    const brokerLogs = await docker(["container", "logs", broker]);
    const diagnostic = `assessor_exit=${assessorResult.exitCode} timed_out=${assessorResult.timedOut}\n${assessorResult.stderr}\n${brokerLogs.stderr}`
      .trim().slice(0, 2048).replaceAll(tempRoot, "<temp>");
    throw new Error(`assessor materialization failed: ${diagnostic || "no bounded logs"}`);
  }
  process.stdout.write(assessorResult.stdout);

  const createEvents = await requireDocker([
    "events",
    "--since", String(smokeStartedAt),
    "--until", String(Math.floor(Date.now() / 1000) + 1),
    "--filter", "type=container",
    "--filter", "event=create",
    "--filter", `label=io.tiangong.run-id=${runId}`,
    "--format", "{{.Actor.Attributes.name}}",
  ], "runner event query failed", { timeoutMs: 10_000 });
  const createdRunners = createEvents.stdout.split("\n").filter(Boolean);
  if (createdRunners.length !== 2 ||
      createdRunners.filter((name) => name.includes("-seed-")).length !== 1 ||
      createdRunners.filter((name) => !name.includes("-seed-")).length !== 1) {
    throw new Error("broker replay created an unexpected number of runner containers");
  }
  process.stdout.write("runner_broker_single_execution=pass\n");

  const intruderResult = await docker([
    "container", "run", "--name", intruder, "--label", ownerLabel,
    ...commonClientArgs,
    "--env", `TEST_TASK_ID=${taskId}`,
    "--env", `TEST_RUN_ID=${runId}`,
    "--env", "AGENTTEAMS_WORKER_NAME=tiangong-intruder",
    "--entrypoint", "/usr/bin/node", workerImageId,
    "--input-type=module", "-e", intruderProgram,
  ], { timeoutMs: 60_000 });
  if (intruderResult.timedOut || intruderResult.exitCode !== 0 ||
      !intruderResult.stdout.includes("runner_broker_unauthorized_peer=pass")) {
    throw new Error("unauthorized peer oracle failed");
  }
  process.stdout.write(intruderResult.stdout);

  const socketProbe = await requireDocker([
    "container", "inspect", "--format", "{{json .Mounts}}", client, assessorClient,
  ], "client mount inspect failed");
  if (socketProbe.stdout.includes("docker.sock")) throw new Error("professional Worker received the Docker socket");
  process.stdout.write("runner_broker_worker_socket_absent=pass\n");
} catch (error) {
  fail(error instanceof Error ? error.message : "runner broker smoke failed");
} finally {
  for (const name of [intruder, assessorClient, client, broker]) await removeOwned("container", name);
  await removeOwned("volume", stateVolume);
  await removeOwned("network", network);
  try {
    await rm(tempRoot, { recursive: true });
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) fail("runner broker cleanup failed");
  else process.stdout.write("runner_broker_cleanup=pass\n");
}
