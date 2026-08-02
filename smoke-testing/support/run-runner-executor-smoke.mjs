#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDisposableDockerExecutor,
  createDockerCommandRunner,
} from "../../worker/agent/runner/docker-executor.mjs";
import {
  FORBIDDEN_ENV_KEYS,
  FORBIDDEN_NETWORK_TARGETS,
} from "../../worker/agent/runner/runner-policy.mjs";
import { runCommand } from "../../worker/agent/runner/runner-port.mjs";

const supportDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(supportDirectory, "../..");
const fixtureSource = path.join(repositoryRoot, "smoke-testing/fixtures/runner-isolation");
const image = process.env.TIANGONG_RUNNER_IMAGE ?? "tiangong-worker-implementor:dev";
const dockerPath = process.env.TIANGONG_DOCKER_PATH ?? "/usr/bin/docker";
const runId = `run-${randomUUID()}`;
const runDocker = createDockerCommandRunner({ dockerPath });

function fail(message) {
  process.stderr.write(`[Tiangong] ERROR: ${message}\n`);
  process.exitCode = 1;
}

async function dockerOutput(args) {
  const result = await runDocker(args, { timeoutMs: 30_000 });
  if (result.timedOut || result.exitCode !== 0) throw new Error("Docker control command failed");
  return result.stdout.trim();
}

try {
  const imageId = await dockerOutput(["image", "inspect", "--format", "{{.Id}}", image]);
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageId)) throw new Error("runner image did not resolve to an immutable ID");

  const executor = createDisposableDockerExecutor({ imageId, fixtureSource, runDocker });
  const result = await runCommand({
    runId,
    command: ["node", "/workspace/fixture/probe.mjs"],
    cwd: "fixture",
    timeoutMs: 30_000,
    outputLimitBytes: 64 * 1024,
  }, {
    executor,
    env: {
      TIANGONG_FORBIDDEN_ENV_NAMES: FORBIDDEN_ENV_KEYS.join(","),
      TIANGONG_FORBIDDEN_NETWORK_TARGETS: FORBIDDEN_NETWORK_TARGETS.join(","),
    },
  });
  if (result.outcome !== "completed" || result.exitCode !== 0) {
    throw new Error(`runner invocation did not complete: ${result.outcome}`);
  }
  if (result.stdout.trim() !== "runner_probe=pass") throw new Error("runner probe marker is missing");
  if (result.runnerEvidence?.imageId !== imageId || result.runnerEvidence.runId !== runId) {
    throw new Error("runner machine Evidence is not bound to the invocation");
  }

  process.stdout.write("runner_executor_daemon_policy=pass\n");
  process.stdout.write("runner_probe=pass\n");
  process.stdout.write(
    `runner_executor_machine_evidence=pass run_id=${runId} image_id=${imageId} ` +
    `policy_digest=${result.runnerEvidence.policyDigest} ` +
    `config_digest=${result.runnerEvidence.containerConfigDigest} ` +
    `fixture_digest=${result.runnerEvidence.fixtureDigest}\n`,
  );

  const timeoutRunId = `run-${randomUUID()}`;
  const timeoutResult = await runCommand({
    runId: timeoutRunId,
    command: ["node", "-e", "setTimeout(() => {}, 5000)"],
    cwd: "fixture",
    timeoutMs: 100,
    outputLimitBytes: 1024,
  }, { executor, env: {} });
  if (timeoutResult.outcome !== "outcome_uncertain") {
    throw new Error("interrupted runner invocation was not outcome-uncertain");
  }
  process.stdout.write("runner_executor_timeout_uncertain=pass\n");

  for (const ownedRunId of [runId, timeoutRunId]) {
    const resourceFilter = `label=io.tiangong.run-id=${ownedRunId}`;
    const remainingContainers = await dockerOutput([
      "container", "ls", "--all", "--filter", resourceFilter, "--format", "{{.Names}}",
    ]);
    const remainingVolumes = await dockerOutput([
      "volume", "ls", "--filter", resourceFilter, "--format", "{{.Name}}",
    ]);
    if (remainingContainers || remainingVolumes) throw new Error("run-owned Docker resources remain after cleanup");
  }
  process.stdout.write("runner_executor_cleanup=pass\n");
} catch (error) {
  fail(error instanceof Error ? error.message : "runner executor smoke failed");
}
