#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDockerCommandRunner } from "../../worker/agent/runner/docker-executor.mjs";
import { createProjectBinding, createTaskBinding } from "../../worker/agent/team/manifest.mjs";
import { FORBIDDEN_ENV_KEYS, FORBIDDEN_NETWORK_TARGETS } from "../../worker/agent/runner/runner-policy.mjs";
import { runnerRunIdForTask } from "../../worker/agent/runner/runner-port.mjs";

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
const projectId = `project-runner-${suffix}`;
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
const implementCommand = ["node", "--input-type=module", "-e", "await import('./probe.mjs'); const fs = await import('node:fs/promises'); await fs.appendFile('input.txt', 'sealed-change\\n');"];
const assessCommand = ["node", "--input-type=module", "-e", "const fs = await import('node:fs/promises'); const value = await fs.readFile('input.txt', 'utf8'); if (!value.endsWith('sealed-change\\n')) process.exit(41); try { await fs.appendFile('input.txt', 'forbidden'); process.exit(42); } catch (error) { if (!['EACCES', 'EROFS'].includes(error.code)) throw error; } console.log('assessor_revision_readonly=pass');"];
const projectBinding = createProjectBinding({
  projectId,
  playbookId: "software-change-delivery",
  playbookVersion: "1.0.0",
  playbookDigest: "b".repeat(64),
  requester: "@manager:example.test",
  roleBindings: {
    team_leader: "tiangong-leader",
    designer: `tiangong-designer-${suffix}`,
    implementor: workerName,
    assessor: `tiangong-assessor-role-${suffix}`,
    operator: `tiangong-operator-${suffix}`,
  },
  createdAt: new Date().toISOString(),
});
const taskBinding = createTaskBinding({
  taskId,
  projectId,
  playbookStepId: "software-change-delivery-transition-v1:implement",
  taskKind: "implement",
  revisionIndex: 0,
  assignee: workerName,
  objective: "Implement the bounded smoke change and return one immutable revision.",
  completionContractDigest: "c".repeat(64),
  sourceProfileDigest: "d".repeat(64),
  sourceSkillId: "implementor-controlled-implementation-v1",
  sourceSkillDigest: "e".repeat(64),
  inputRefs: [],
  createdAt: projectBinding.createdAt,
});
const runId = runnerRunIdForTask(taskBinding);
const ownerLabel = `io.tiangong.broker-run=${runId}`;
const tempRoot = await mkdtemp(path.join(tmpdir(), "tiangong-runner-broker-smoke-"));
const configPath = path.join(tempRoot, "config.json");
let cleanupFailed = false;

function fail(message) {
  process.stderr.write(`[Tiangong] ERROR: ${message}\n`);
  process.exitCode = 1;
}

async function docker(args, options = {}) {
  return runDocker(args, { ...options, timeoutMs: options.timeoutMs ?? 60_000, outputLimitBytes: 4 * 1024 * 1024 });
}

async function requireDocker(args, code, options) {
  const result = await docker(args, options);
  if (result.timedOut || result.exitCode !== 0) throw new Error(`${code}: ${result.stderr.trim().slice(0, 512)}`);
  return result;
}

async function tarDirectory(source) {
  return await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-cf", "-", "-C", source, "."], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8").slice(0, 1024); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`fixture archive failed: ${stderr.trim().slice(0, 512)}`));
      else resolve(Buffer.concat(chunks));
    });
  });
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
const [
  { createRunnerBrokerExecutor },
  { RunnerJournal },
  policy,
  { runCommand, runnerInvocationIdentity },
  { WorkRunStore },
  { ToolResultStore },
  { createMemberToolRegistry },
  { createProject, dispatchTask },
  { createProjectBinding, createTaskBinding },
  { TeamCoordinationGate },
  { TurnGateState },
  { RUNNER_BROKER_ENDPOINT_DIGEST },
  { readTaskResult },
  { sha256 },
] = await Promise.all([
  import("/opt/tiangong-worker/agent/runner/broker-client.mjs"),
  import("/opt/tiangong-worker/agent/runner/journal.mjs"),
  import("/opt/tiangong-worker/agent/runner/runner-policy.mjs"),
  import("/opt/tiangong-worker/agent/runner/runner-port.mjs"),
  import("/opt/tiangong-worker/agent/work/work-run-store.mjs"),
  import("/opt/tiangong-worker/agent/gates/tool-result-store.mjs"),
  import("/opt/tiangong-worker/agent/work/member-tools.mjs"),
  import("/opt/tiangong-worker/agent/team/team-task-port.mjs"),
  import("/opt/tiangong-worker/agent/team/manifest.mjs"),
  import("/opt/tiangong-worker/agent/team/tool-wrapper.mjs"),
  import("/opt/tiangong-worker/agent/gates/turn-state.mjs"),
  import("/opt/tiangong-worker/agent/runner/preparation-client.mjs"),
  import("/opt/tiangong-worker/agent/team/manifest-store.mjs"),
  import("/opt/tiangong-worker/agent/canonical-json.mjs"),
]);
const env = {
  TIANGONG_FORBIDDEN_ENV_NAMES: policy.FORBIDDEN_ENV_KEYS.join(","),
  TIANGONG_FORBIDDEN_NETWORK_TARGETS: policy.FORBIDDEN_NETWORK_TARGETS.join(","),
};
const executor = createRunnerBrokerExecutor({ endpoint: process.env.TEST_BROKER_ENDPOINT, taskId: process.env.TEST_TASK_ID });
const project = createProjectBinding(JSON.parse(process.env.TEST_PROJECT_BINDING));
const task = createTaskBinding(JSON.parse(process.env.TEST_TASK_BINDING));
const evidence = { events: [], async append(event) { this.events.push(event); } };
const channel = {
  calls: [],
  async waitForTeamIdentity(role) { return { team: "team-smoke", role }; },
  async assertTeamIdentity(role) { return { team: "team-smoke", role }; },
  async assertTeamRoster() { return { roomId: "!team-smoke:example.test", roomIdDigest: "f".repeat(64), memberDigests: [] }; },
  async notifyAssignee(worker, taskId) { this.calls.push({ kind: "notifyAssignee", worker, taskId }); return { queued: true, delivered: true }; },
  async notifyLeader(taskId) { this.calls.push({ kind: "notifyLeader", taskId }); return { queued: true, delivered: true }; },
};
const coordination = {
  rootDir: "/tmp/tiangong-shared",
  channel,
  sync: { async beforeRead() {}, async afterWrite() {} },
  evidence,
  now: () => task.createdAt,
  runnerBrokerPreparation: {
    async prepare({ taskBinding }) {
      return {
        schemaVersion: 1,
        status: "ready",
        taskId: taskBinding.taskId,
        taskBindingDigest: taskBinding.contentDigest,
        bindingDigest: "a".repeat(64),
        endpointDigest: RUNNER_BROKER_ENDPOINT_DIGEST,
        replayed: false,
      };
    },
  },
};
const leaderEnv = {
  AGENTTEAMS_WORKER_NAME: project.roleBindings.team_leader,
  AGENTTEAMS_WORKER_ROLE: "team_leader",
  AGENTTEAMS_WORKER_ROOM_ID: "room-leader",
  AGENTTEAMS_MATRIX_DOMAIN: "example.test",
};
await createProject(project, { ...coordination, env: leaderEnv });
await dispatchTask(task, { ...coordination, env: leaderEnv });
const plan = await executor.plan({ runId: process.env.TEST_RUN_ID });
console.log("runner_broker_plan=pass plan_digest=" + plan.contentDigest);
const request = { runId: plan.runId, command: plan.command, cwd: plan.cwd, timeoutMs: plan.timeoutMs, outputLimitBytes: plan.outputLimitBytes };
const restartJournalPath = "/tmp/client-restart.jsonl";
const restartJournal = new RunnerJournal({ filePath: restartJournalPath });
const restartIdentity = runnerInvocationIdentity(request);
await restartJournal.begin(restartIdentity.invocationKey, restartIdentity.requestDigest);
const reopenedRestartJournal = new RunnerJournal({ filePath: restartJournalPath });
const unresolvedAfterRestart = await runCommand(request, { executor, journal: reopenedRestartJournal, env });
if (unresolvedAfterRestart.outcome !== "outcome_uncertain" || unresolvedAfterRestart.replayed !== true) process.exit(19);
console.log("b4_restart_unresolved=pass");
const altered = { ...request, command: ["node", "-e", "process.exit(99)"] };
const alteredIdentity = runnerInvocationIdentity(altered);
const rejected = await fetch(process.env.TEST_BROKER_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, taskId: process.env.TEST_TASK_ID, invocationKey: alteredIdentity.invocationKey, ...altered, env }) });
if (rejected.status !== 403) process.exit(20);
console.log("runner_broker_changed_plan_rejected=pass");
const memberDeps = {
  ...coordination,
  env: {
    AGENTTEAMS_WORKER_NAME: task.assignee,
    AGENTTEAMS_WORKER_ROLE: "worker",
    AGENTTEAMS_WORKER_ROOM_ID: "room-member",
    AGENTTEAMS_MATRIX_DOMAIN: "example.test",
  },
  professionalRole: "implementor",
  sourceProfileDigest: task.sourceProfileDigest,
  sourceSkillId: task.sourceSkillId,
  sourceSkillDigest: task.sourceSkillDigest,
  runnerBrokerEndpoint: process.env.TEST_BROKER_ENDPOINT,
  runnerFetch: fetch,
  runnerJournal: new RunnerJournal({ filePath: "/tmp/client-first.jsonl" }),
  workRunStore: new WorkRunStore({ directory: "/tmp/client-work-runs", now: () => new Date(task.createdAt) }),
  gate: new TeamCoordinationGate(),
  getInvocation: () => ({
    sessionId: "session-member-smoke",
    turnId: "turn-member-smoke",
    actor: { id: "@tiangong-leader:example.test" },
    turnState: new TurnGateState(),
    resumed: false,
  }),
};
const registry = createMemberToolRegistry({ deps: memberDeps });
const resolve = registry.definitions().find((tool) => tool.name === "team_resolve_task");
const resolved = await resolve.execute("resolve-smoke", { taskId: task.taskId });
if (resolved.details.workRunPhase !== "executing") process.exit(21);
const toolStore = new ToolResultStore({ filePath: "/tmp/client-tool-results.json" });
const toolCallKey = sha256({ actorId: task.assignee, sessionKey: "session-member-smoke", toolCallId: "run-smoke" });
const toolResult = {
  toolResultId: sha256({ source: "b4.runner.tool-result", callKey: toolCallKey }),
  callKey: toolCallKey,
  workId: resolved.details.workRunId,
  taskId: task.taskId,
  actorId: task.assignee,
  runtimeProfile: "tiangong-implementor",
  tool: "run_command",
  requestSummary: { toolName: "run_command", taskId: task.taskId },
  resultSummary: { outcome: "success", hasData: true },
  outputRef: null,
  startedAt: task.createdAt,
  completedAt: task.createdAt,
};
const storedToolResult = await toolStore.append(toolResult);
await toolStore.markRetention(storedToolResult.result.toolResultId, { workId: resolved.details.workRunId, until: "2026-12-01T00:00:00.000Z" });
const reopenedToolStore = new ToolResultStore({ filePath: "/tmp/client-tool-results.json" });
const toolState = await reopenedToolStore.list();
if (toolState.results.length !== 1 || toolState.retentionMarks.length !== 1) process.exit(20);
const run = registry.definitions().find((tool) => tool.name === "run_command");
const first = await run.execute("run-smoke", { taskId: task.taskId });
if (first.details.outcome !== "completed" || first.details.exitCode !== 0 ||
    first.details.stdout.trim() !== "runner_probe=pass" || !first.details.changeRevisionRef ||
    first.details.changeRevisionRef.producerTaskId !== task.taskId) {
  console.error("runner_client_failure outcome=" + (first.details.outcome ?? "missing") +
    " exit=" + (first.details.exitCode ?? "missing") +
    " stdout_match=" + (first.details.stdout?.trim() === "runner_probe=pass") +
    " revision_present=" + Boolean(first.details.changeRevisionRef));
  process.exit(22);
}
const submit = registry.definitions().find((tool) => tool.name === "team_submit_result");
const submitted = await submit.execute("submit-smoke", {
  taskId: task.taskId,
  claim: "The bounded implementation command completed and sealed one ChangeRevision.",
  evidenceRefs: [storedToolResult.result.toolResultId],
  changeRevisionRef: first.details.changeRevisionRef,
});
const persisted = await readTaskResult(task.taskId, { rootDir: coordination.rootDir });
const workRun = await memberDeps.workRunStore.latestForTask(task.taskId);
if (submitted.details.replayed || persisted.contentDigest !== submitted.details.resultDigest || workRun.phase !== "finalized") process.exit(23);
const brokerReplay = await run.execute("run-smoke-replay", { taskId: task.taskId });
if (brokerReplay.details.outcome !== "completed" || brokerReplay.details.replayed !== true) process.exit(24);
console.log("runner_broker_client=pass");
console.log("runner_broker_evidence=pass invocation_key=" + first.details.invocationKey + " policy_digest=" + first.details.runnerEvidence.policyDigest);
console.log("runner_broker_revision_sealed=pass artifact_digest=" + first.details.changeRevisionRef.artifactDigest);
console.log("b4_work_task_runner=pass task_id=" + task.taskId);
console.log("b4_result_persisted=pass result_digest=" + persisted.contentDigest + " work_run_phase=" + workRun.phase);
console.log("b4_toolresult_retention=pass tool_result_id=" + storedToolResult.result.toolResultId);
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
    // The broker runs inside a control container on Docker Desktop. Host
    // bind sources such as its /tmp or /workspace are not visible to the
    // Docker daemon, so project bounded inputs through tmpfs and stdin.
    "--tmpfs", "/run/tiangong-runner-broker:rw,noexec,nosuid,nodev,size=1m",
    "--tmpfs", "/opt/tiangong-runner-fixtures/isolation:rw,noexec,nosuid,nodev,size=64m",
    "--mount", `type=volume,src=${stateVolume},dst=/var/lib/tiangong-runner-broker`,
    "--entrypoint", "/bin/sh",
    brokerImageId,
    "-c", "while [ ! -s /run/tiangong-runner-broker/config.json ]; do sleep 0.1; done; exec /usr/bin/node /opt/tiangong-worker/agent/runner/broker-server.mjs",
  ], "broker container create failed");
  await requireDocker(["container", "start", broker], "broker container start failed");
  await requireDocker(["container", "exec", broker, "mkdir", "-p", "/tmp/fixture-input"], "broker fixture staging failed");
  await requireDocker(["container", "exec", "-i", broker, "tar", "--no-same-owner", "-xf", "-", "-C", "/tmp/fixture-input"], "broker fixture projection failed", { input: await tarDirectory(fixture) });
  await requireDocker(["container", "exec", broker, "sh", "-c", "cp -a /tmp/fixture-input/. /opt/tiangong-runner-fixtures/isolation/"], "broker fixture projection failed");
  await requireDocker(["container", "exec", "-i", broker, "sh", "-c", "cat > /tmp/config.json"], "broker config projection failed", { input: await readFile(configPath) });
  await requireDocker(["container", "exec", broker, "sh", "-c", "cp /tmp/config.json /run/tiangong-runner-broker/config.json"], "broker config projection failed");

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
    "--env", `TEST_PROJECT_BINDING=${JSON.stringify(projectBinding)}`,
    "--env", `TEST_TASK_BINDING=${JSON.stringify(taskBinding)}`,
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
