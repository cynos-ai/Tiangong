import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import {
  DEFAULT_AGENTTEAMS_RUNNER_BROKER_PREPARATION_ENDPOINT,
  RUNNER_BROKER_ENDPOINT_DIGEST,
  createRunnerBrokerPreparationClient,
  runnerPreparationFailureCode,
  validateRunnerPreparationReceipt,
} from "../agent/runner/preparation-client.mjs";

const PLAYBOOK = sha256("playbook");
const CONTRACT = sha256("contract");
const PROFILE = sha256("profile");
const SKILL = sha256("skill");
const CREATED = "2026-08-03T12:00:00Z";

function project() {
  return createProjectBinding({
    projectId: "prep-project-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookId: "software-change-delivery",
    playbookVersion: "1.0.0",
    playbookDigest: PLAYBOOK,
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

function task(boundProject, taskKind, inputRefs = []) {
  return createTaskBinding({
    taskId: `prep-${taskKind}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    projectId: boundProject.projectId,
    playbookStepId: `software-change-delivery-transition-v1:${taskKind}`,
    taskKind,
    revisionIndex: 0,
    assignee: taskKind === "implement" ? "tiangong-implementor" : "tiangong-assessor",
    objective: `Prepare the ${taskKind} Runner binding.`,
    completionContractDigest: CONTRACT,
    sourceProfileDigest: PROFILE,
    sourceSkillId: `${taskKind === "implement" ? "implementor" : "assessor"}-v1`,
    sourceSkillDigest: SKILL,
    inputRefs,
    createdAt: CREATED,
  });
}

function response(value, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    status,
    body: (async function* stream() { yield bytes; })(),
  };
}

function receipt(boundTask, overrides = {}) {
  return {
    schemaVersion: 1,
    status: "ready",
    taskId: boundTask.taskId,
    taskBindingDigest: boundTask.contentDigest,
    bindingDigest: "a".repeat(64),
    endpointDigest: RUNNER_BROKER_ENDPOINT_DIGEST,
    replayed: false,
    ...overrides,
  };
}

test("preparation client sends only immutable binding DTOs and validates the ready receipt", async () => {
  const boundProject = project();
  const boundTask = task(boundProject, "implement");
  let seen;
  const client = createRunnerBrokerPreparationClient({
    fetchImpl: async (url, options) => {
      seen = { url, options, body: JSON.parse(options.body) };
      return response(receipt(boundTask));
    },
  });
  const prepared = await client.prepare({ projectBinding: boundProject, taskBinding: boundTask, inputTaskBinding: null });
  assert.equal(prepared.status, "ready");
  assert.deepEqual(Object.keys(seen.body).sort(), ["inputTaskBinding", "projectBinding", "schemaVersion", "taskBinding"]);
  assert.equal(seen.url, DEFAULT_AGENTTEAMS_RUNNER_BROKER_PREPARATION_ENDPOINT);
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers["content-type"], "application/json");
  assert.equal(seen.body.schemaVersion, 1);
  assert.deepEqual(seen.body.taskBinding, boundTask);
  assert.equal(Object.hasOwn(seen.body.taskBinding, "contentDigest"), true);
});

test("assessor preparation requires exactly its Implementor input and binds both digests", async () => {
  const boundProject = project();
  const implementTask = task(boundProject, "implement");
  const assessTask = task(boundProject, "assess", [implementTask.taskId]);
  let calls = 0;
  const client = createRunnerBrokerPreparationClient({
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.inputTaskBinding.taskId, implementTask.taskId);
      return response(receipt(assessTask));
    },
  });
  await client.prepare({ projectBinding: boundProject, taskBinding: assessTask, inputTaskBinding: implementTask });
  assert.equal(calls, 1);
  await assert.rejects(
    () => client.prepare({ projectBinding: boundProject, taskBinding: assessTask, inputTaskBinding: null }),
    (error) => error.code === "RUNNER_BROKER_PREPARATION_INPUT_INVALID",
  );
  assert.equal(calls, 1);
});

test("preparation fails closed on rejected, malformed, and mismatched receipts", async () => {
  const boundProject = project();
  const boundTask = task(boundProject, "implement");
  const rejected = createRunnerBrokerPreparationClient({ fetchImpl: async () => response({ error: "hidden" }, 503) });
  await assert.rejects(
    () => rejected.prepare({ projectBinding: boundProject, taskBinding: boundTask, inputTaskBinding: null }),
    (error) => error.code === "RUNNER_BROKER_PREPARATION_REJECTED",
  );
  const malformed = createRunnerBrokerPreparationClient({
    fetchImpl: async () => response(receipt(boundTask, { endpointDigest: "b".repeat(64) })),
  });
  await assert.rejects(
    () => malformed.prepare({ projectBinding: boundProject, taskBinding: boundTask, inputTaskBinding: null }),
    (error) => error.code === "RUNNER_BROKER_PREPARATION_RESPONSE_INVALID",
  );
  assert.throws(
    () => validateRunnerPreparationReceipt({ ...receipt(boundTask), taskId: "other" }, boundTask),
    /RESPONSE_INVALID/u,
  );
});

test("preparation transport errors are reduced to stable codes without exposing the cause", async () => {
  const boundProject = project();
  const boundTask = task(boundProject, "implement");
  const client = createRunnerBrokerPreparationClient({
    timeoutMs: 100,
    fetchImpl: async () => {
      const cause = new Error("private endpoint details");
      cause.code = "ENOTFOUND";
      throw cause;
    },
  });
  await assert.rejects(
    () => client.prepare({ projectBinding: boundProject, taskBinding: boundTask, inputTaskBinding: null }),
    (error) => {
      assert.equal(error.code, "RUNNER_BROKER_PREPARATION_NETWORK_ERROR");
      assert.equal(error.message, "RUNNER_BROKER_PREPARATION_NETWORK_ERROR");
      return true;
    },
  );
  assert.equal(runnerPreparationFailureCode(Object.assign(new Error("ignored"), { code: "RUNNER_BROKER_PREPARATION_TIMEOUT" })), "RUNNER_BROKER_PREPARATION_TIMEOUT");
});
