import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createDeploymentOutcome } from "../agent/deployment/client.mjs";
import { TurnGateState } from "../agent/gates/turn-state.mjs";
import { RunnerJournal } from "../agent/runner/journal.mjs";
import { RUNNER_BROKER_ENDPOINT_DIGEST } from "../agent/runner/preparation-client.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import { TeamCoordinationGate } from "../agent/team/tool-wrapper.mjs";
import {
  createProject,
  createTaskDecision,
  dispatchTask,
  recordTaskDecision,
  submitResult,
} from "../agent/team/team-task-port.mjs";
import { createChangeRevisionRef } from "../agent/work/change-revision-ref.mjs";
import { createResultEnvelope } from "../agent/work/result-envelope.mjs";
import { createMemberToolRegistry } from "../agent/work/member-tools.mjs";
import { readTaskResult } from "../agent/team/manifest-store.mjs";

const LEADER = "tiangong-leader";
const DESIGNER = "tiangong-designer";
const CONTRACT = "c".repeat(64);
const PROFILE = "e".repeat(64);
const SKILL = "f".repeat(64);
const T = (n) => `2026-08-01T12:0${n}:00Z`;

function channel() {
  const calls = [];
  return {
    calls,
    async assertTeamIdentity(role) { return { team: "team-1", role }; },
    async assertTeamRoster() { return { roomId: "!team:example.test", roomIdDigest: "f".repeat(64), memberDigests: [] }; },
    async notifyAssignee(worker, taskId) {
      calls.push({ kind: "notifyAssignee", worker, taskId });
      return { queued: true, delivered: false };
    },
    async notifyLeader(taskId) {
      calls.push({ kind: "notifyLeader", taskId });
      return { queued: true, delivered: false };
    },
    async reportRequester() { return { queued: true, delivered: false }; },
  };
}
function evidence() {
  const events = [];
  return { events, async append(event) { events.push(event); } };
}
function depsFor(worker, root) {
  const ev = evidence();
  return {
    rootDir: root,
    env: {
      AGENTTEAMS_WORKER_NAME: worker,
      AGENTTEAMS_WORKER_ROLE: worker === LEADER ? "team_leader" : "worker",
      AGENTTEAMS_WORKER_ROOM_ID: `room-${worker}`,
      AGENTTEAMS_MATRIX_DOMAIN: "example.test",
    },
    channel: channel(),
    sync: { async beforeRead() {}, async afterWrite() {} },
    evidence: ev,
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
    gate: new TeamCoordinationGate(),
    getInvocation: () => ({
      sessionId: `session-${worker}`,
      turnId: `turn-${worker}`,
      actor: { id: `@${LEADER}:example.test` },
      turnState: new TurnGateState(),
      resumed: false,
    }),
    professionalRole: "designer",
    sourceProfileDigest: PROFILE,
    sourceSkillId: "designer-v1",
    sourceSkillDigest: SKILL,
    now: () => T(1),
  };
}
function details(result) { return JSON.parse(result.content[0].text); }
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-member-tools-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function project(id) {
  return createProjectBinding({
    projectId: id,
    playbookId: "software-change-delivery",
    playbookVersion: "1.0.0",
    playbookDigest: "d".repeat(64),
    requester: "@manager:example.test",
    roleBindings: {
      team_leader: LEADER,
      designer: DESIGNER,
      implementor: "tiangong-implementor",
      assessor: "tiangong-assessor",
      operator: "tiangong-operator",
    },
    createdAt: T(0),
  });
}
function professionalTask(boundProject, id, { taskKind = "design", assignee = DESIGNER, role = "designer", inputRefs = [] } = {}) {
  return createTaskBinding({
    taskId: id,
    projectId: boundProject.projectId,
    playbookStepId: `software-change-delivery-transition-v1:${taskKind}`,
    taskKind,
    revisionIndex: 0,
    assignee,
    objective: `Complete the assigned ${taskKind} work.`,
    completionContractDigest: CONTRACT,
    sourceProfileDigest: PROFILE,
    sourceSkillId: `${role}-v1`,
    sourceSkillDigest: SKILL,
    inputRefs,
    createdAt: T(0),
  });
}
function designTask(boundProject, id) {
  return professionalTask(boundProject, id);
}

test("createMemberToolRegistry exposes only each professional RoleProfile surface", () => {
  const designer = createMemberToolRegistry({ deps: depsFor(DESIGNER, "/x") });
  assert.deepEqual(designer.names(), ["team_resolve_task", "team_submit_result"]);
  const implementorDeps = depsFor("tiangong-implementor", "/x");
  implementorDeps.professionalRole = "implementor";
  implementorDeps.sourceSkillId = "implementor-v1";
  const implementor = createMemberToolRegistry({ deps: implementorDeps });
  assert.deepEqual(implementor.names(), ["team_resolve_task", "run_command", "team_submit_result"]);
  assert.deepEqual(Object.keys(implementor.definitions().find((tool) => tool.name === "run_command").parameters.properties), ["taskId"]);
  const assessorDeps = depsFor("tiangong-assessor", "/x");
  assessorDeps.professionalRole = "assessor";
  assessorDeps.sourceSkillId = "assessor-v1";
  const assessor = createMemberToolRegistry({ deps: assessorDeps });
  assert.deepEqual(assessor.names(), ["team_resolve_task", "run_test_command", "team_submit_result"]);
  assert.deepEqual(Object.keys(assessor.definitions().find((tool) => tool.name === "run_test_command").parameters.properties), ["taskId"]);
  const operatorDeps = depsFor("tiangong-operator", "/x");
  operatorDeps.professionalRole = "operator";
  operatorDeps.sourceSkillId = "operator-v1";
  operatorDeps.deploymentBrokerEndpoint = "http://tiangong-deployment-broker:8791/v1/deploy";
  operatorDeps.deploymentReceiptStore = { completedOutcome() {}, record() {} };
  operatorDeps.idempotencyStore = { get() {} };
  operatorDeps.pendingOperationStore = {};
  const operator = createMemberToolRegistry({ deps: operatorDeps });
  assert.deepEqual(operator.names(), ["team_resolve_task", "deploy_release", "team_submit_result"]);
});

test("an assignee resolves its Task and submits a bound ResultEnvelope", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-m-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const task = designTask(boundProject, "task-design-m");
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(task, depsFor(LEADER, root));

    const designerDeps = depsFor(DESIGNER, root);
    const registry = createMemberToolRegistry({ deps: designerDeps });
    const resolved = await registry.definitions().find((tool) => tool.name === "team_resolve_task")
      .execute("resolve-1", { taskId: task.taskId });
    assert.equal(details(resolved).taskKind, "design");

    const out = await registry.definitions().find((tool) => tool.name === "team_submit_result")
      .execute("submit-1", {
        taskId: task.taskId,
        claim: "design complete: approach X",
        evidenceRefs: ["evidence-design"],
      });
    assert.equal(details(out).producer, DESIGNER);
    assert.equal(details(out).notified, false);
    assert.equal(details(out).notificationQueued, true);
    assert.match(details(out).resultDigest, /^[0-9a-f]{64}$/u);
    assert.ok(designerDeps.channel.calls.some((call) => call.kind === "notifyLeader"));
    assert.ok(designerDeps.evidence.events.some((event) => event.type === "gate.decided"));
  });
});

test("a non-assignee cannot resolve or submit", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-m2-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const task = designTask(boundProject, "task-design-m2");
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(task, depsFor(LEADER, root));

    const intruder = createMemberToolRegistry({ deps: depsFor("tiangong-implementor", root) });
    await assert.rejects(
      () => intruder.definitions().find((tool) => tool.name === "team_resolve_task")
        .execute("resolve-x", { taskId: task.taskId }),
      /not the assignee/u,
    );
    await assert.rejects(
      () => intruder.definitions().find((tool) => tool.name === "team_submit_result")
        .execute("submit-x", { taskId: task.taskId, claim: "forged" }),
      /not the assignee/u,
    );
    const wrongProfileDeps = depsFor(DESIGNER, root);
    wrongProfileDeps.professionalRole = "implementor";
    const wrongProfile = createMemberToolRegistry({ deps: wrongProfileDeps });
    await assert.rejects(
      () => wrongProfile.definitions().find((tool) => tool.name === "team_submit_result")
        .execute("submit-wrong-profile", { taskId: task.taskId, claim: "forged" }),
      /RoleProfile does not match/u,
    );
  });
});

test("Implementor command runs only through the Task-bound broker and projects machine Evidence", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-run-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const task = professionalTask(boundProject, "task-implement-run", {
      taskKind: "implement",
      assignee: "tiangong-implementor",
      role: "implementor",
    });
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(task, depsFor(LEADER, root));
    const deps = depsFor("tiangong-implementor", root);
    deps.professionalRole = "implementor";
    deps.sourceSkillId = "implementor-v1";
    deps.runnerBrokerEndpoint = "http://runner-broker:18090/v1/execute";
    deps.runnerJournal = new RunnerJournal({ filePath: join(root, "runner.jsonl") });
    const revisionRef = createChangeRevisionRef({
      producerTaskId: task.taskId,
      artifactPath: "objects/implement/revision",
      artifactDigest: "d".repeat(64),
      revision: 0,
    });
    let brokerCalls = 0;
    let planDigest;
    deps.runnerFetch = async (url, options) => {
      brokerCalls += 1;
      const request = JSON.parse(options.body);
      assert.equal(request.taskId, task.taskId);
      if (new URL(url).pathname === "/v1/plan") {
        const plan = {
          schemaVersion: 1,
          taskId: task.taskId,
          runId: request.runId,
          command: ["node", "test.mjs"],
          cwd: "scratch/revision",
          timeoutMs: 1000,
          outputLimitBytes: 65536,
        };
        planDigest = sha256(plan);
        return new Response(JSON.stringify({ ...plan, contentDigest: planDigest }), { status: 200 });
      }
      assert.deepEqual(request.command, ["node", "test.mjs"]);
      assert.match(request.env.TIANGONG_FORBIDDEN_ENV_NAMES, /OPENAI_API_KEY/u);
      assert.match(request.env.TIANGONG_FORBIDDEN_NETWORK_TARGETS, /agentteams-controller/u);
      return new Response(JSON.stringify({
        status: "completed",
        exitCode: 0,
        stdout: "tests pass\n",
        stderr: "",
        durationMs: 7,
        runnerEvidence: {
          schemaVersion: 1,
          runId: request.runId,
          invocationKey: request.invocationKey,
          imageId: `sha256:${"a".repeat(64)}`,
          policyDigest: "b".repeat(64),
          containerConfigDigest: "c".repeat(64),
          fixtureDigest: "0".repeat(64),
          executionPlanDigest: planDigest,
        },
        changeRevisionRef: revisionRef,
      }), { status: 200 });
    };
    const command = createMemberToolRegistry({ deps }).definitions()
      .find((tool) => tool.name === "run_command");
    const params = { taskId: task.taskId };
    const first = await command.execute("run-1", params);
    assert.equal(details(first).stdout, "tests pass\n");
    assert.equal(details(first).replayed, false);
    assert.equal(details(first).changeRevisionRef.contentDigest, revisionRef.contentDigest);
    const submit = createMemberToolRegistry({ deps }).definitions().find((tool) => tool.name === "team_submit_result");
    await assert.rejects(
      () => submit.execute("submit-forged", {
        taskId: task.taskId,
        claim: "forged revision",
        changeRevisionRef: createChangeRevisionRef({ ...revisionRef, artifactDigest: "e".repeat(64) }),
      }),
      /not bound to a completed Runner invocation/u,
    );
    const submitted = await submit.execute("submit-implement", {
      taskId: task.taskId,
      claim: "implementation complete",
      changeRevisionRef: revisionRef,
    });
    assert.match(details(submitted).resultDigest, /^[0-9a-f]{64}$/u);
    const replay = await command.execute("run-2", params);
    assert.equal(details(replay).replayed, true);
    assert.equal(brokerCalls, 3);
    assert.equal(deps.evidence.events.filter((event) => event.type === "runner.plan.requested").length, 2);
    assert.equal(deps.evidence.events.filter((event) => event.type === "runner.plan.received").length, 2);
    const completion = deps.evidence.events.find((event) =>
      event.type === "tool.execution.completed" && event.executionCategory === "isolated-execution");
    assert.equal(completion.runnerImageId, `sha256:${"a".repeat(64)}`);
    assert.equal(completion.runnerPolicyDigest, "b".repeat(64));
    assert.equal(completion.runnerExecutionPlanDigest, planDigest);
    assert.equal(completion.runnerChangeRevisionRefDigest, revisionRef.contentDigest);
    assert.equal(completion.runnerChangeArtifactDigest, revisionRef.artifactDigest);
    assert.equal(Object.hasOwn(completion, "stdout"), false);
  });
});

test("Assessor test command is independently bound to an assess Task", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-assess-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const sourceTask = professionalTask(boundProject, "task-implement-source", {
      taskKind: "implement",
      assignee: "tiangong-implementor",
      role: "implementor",
    });
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(sourceTask, depsFor(LEADER, root));
    const task = professionalTask(boundProject, "task-assess-run", {
      taskKind: "assess",
      assignee: "tiangong-assessor",
      role: "assessor",
      inputRefs: [sourceTask.taskId],
    });
    await dispatchTask(task, depsFor(LEADER, root));
    const deps = depsFor("tiangong-assessor", root);
    deps.professionalRole = "assessor";
    deps.sourceSkillId = "assessor-v1";
    deps.runnerBrokerEndpoint = "http://runner-broker:18090/v1/execute";
    deps.runnerJournal = new RunnerJournal({ filePath: join(root, "assessor-runner.jsonl") });
    const assessedRevision = createChangeRevisionRef({
      producerTaskId: "task-implement-source",
      artifactPath: "objects/implement/source",
      artifactDigest: "d".repeat(64),
      revision: 0,
    });
    let planDigest;
    deps.runnerFetch = async (url, options) => {
      const request = JSON.parse(options.body);
      if (new URL(url).pathname === "/v1/plan") {
        const plan = {
          schemaVersion: 1,
          taskId: task.taskId,
          runId: request.runId,
          command: ["node", "test.mjs"],
          cwd: "fixture",
          timeoutMs: 1000,
          outputLimitBytes: 65536,
        };
        planDigest = sha256(plan);
        return new Response(JSON.stringify({ ...plan, contentDigest: planDigest }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        exitCode: 1,
        stdout: "",
        stderr: "test failed\n",
        durationMs: 5,
        runnerEvidence: {
          schemaVersion: 1,
          runId: request.runId,
          invocationKey: request.invocationKey,
          imageId: `sha256:${"a".repeat(64)}`,
          policyDigest: "b".repeat(64),
          containerConfigDigest: "c".repeat(64),
          fixtureDigest: "d".repeat(64),
          executionPlanDigest: planDigest,
        },
        changeRevisionRef: assessedRevision,
      }), { status: 200 });
    };
    const result = await createMemberToolRegistry({ deps }).definitions()
      .find((tool) => tool.name === "run_test_command")
      .execute("assess-run", { taskId: task.taskId });
    assert.equal(details(result).exitCode, 1);
    assert.equal(details(result).stderr, "test failed\n");
    assert.equal(details(result).changeRevisionRef.contentDigest, assessedRevision.contentDigest);
  });
});

test("Runner plan rejection occurs before the immutable Worker invocation journal", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-plan-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const task = professionalTask(boundProject, "task-implement-plan", {
      taskKind: "implement",
      assignee: "tiangong-implementor",
      role: "implementor",
    });
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(task, depsFor(LEADER, root));
    const journalPath = join(root, "plan-rejected-runner.jsonl");
    const deps = depsFor("tiangong-implementor", root);
    deps.professionalRole = "implementor";
    deps.sourceSkillId = "implementor-v1";
    deps.runnerBrokerEndpoint = "http://runner-broker:18090/v1/execute";
    deps.runnerJournal = new RunnerJournal({ filePath: journalPath });
    deps.runnerFetch = async () => new Response(JSON.stringify({ error: "rejected" }), { status: 403 });
    const command = createMemberToolRegistry({ deps }).definitions().find((tool) => tool.name === "run_command");
    await assert.rejects(
      () => command.execute("run-plan-rejected", { taskId: task.taskId }),
      (error) => error?.code === "TIANGONG_RUNNER_PLAN_UNAVAILABLE",
    );
    const planRequested = deps.evidence.events.find((event) => event.type === "runner.plan.requested");
    const planFailed = deps.evidence.events.find((event) => event.type === "runner.plan.failed");
    assert.equal(planRequested.taskId, task.taskId);
    assert.equal(planFailed.errorCode, "RUNNER_BROKER_REQUEST_REJECTED");
    assert.equal(planFailed.taskBindingDigest, task.contentDigest);
    await assert.rejects(() => access(journalPath), (error) => error?.code === "ENOENT");
  });
});

test("Runner plan transport causes are reduced to stable sanitized Evidence codes", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-plan-network-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const task = professionalTask(boundProject, "task-implement-network", {
      taskKind: "implement",
      assignee: "tiangong-implementor",
      role: "implementor",
    });
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(task, depsFor(LEADER, root));
    const journalPath = join(root, "plan-network-runner.jsonl");
    const deps = depsFor("tiangong-implementor", root);
    deps.professionalRole = "implementor";
    deps.sourceSkillId = "implementor-v1";
    deps.runnerBrokerEndpoint = "http://runner-broker:18090/v1/execute";
    deps.runnerJournal = new RunnerJournal({ filePath: journalPath });
    deps.runnerFetch = async () => {
      const cause = Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    };
    const command = createMemberToolRegistry({ deps }).definitions().find((tool) => tool.name === "run_command");
    await assert.rejects(
      () => command.execute("run-plan-network", { taskId: task.taskId }),
      (error) => error?.code === "TIANGONG_RUNNER_PLAN_UNAVAILABLE",
    );
    const planFailed = deps.evidence.events.find((event) => event.type === "runner.plan.failed");
    assert.equal(planFailed.errorCode, "RUNNER_BROKER_DNS_UNAVAILABLE");
    await assert.rejects(() => access(journalPath), (error) => error?.code === "ENOENT");
  });
});

test("member tools reject a non-Leader Matrix actor and unavailable Runner", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-auth-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const task = professionalTask(boundProject, "task-implement-auth", {
      taskKind: "implement",
      assignee: "tiangong-implementor",
      role: "implementor",
    });
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(task, depsFor(LEADER, root));
    const deps = depsFor("tiangong-implementor", root);
    deps.professionalRole = "implementor";
    deps.sourceSkillId = "implementor-v1";
    deps.getInvocation = () => ({
      sessionId: "session-intruder",
      turnId: "turn-intruder",
      actor: { id: "@manager:example.test" },
      turnState: new TurnGateState(),
      resumed: false,
    });
    const registry = createMemberToolRegistry({ deps });
    await assert.rejects(
      () => registry.definitions().find((tool) => tool.name === "team_resolve_task")
        .execute("resolve-intruder", { taskId: task.taskId }),
      /not the Project Leader/u,
    );
    deps.getInvocation = () => ({
      sessionId: "session-leader",
      turnId: "turn-leader",
      actor: { id: `@${LEADER}:example.test` },
      turnState: new TurnGateState(),
      resumed: false,
    });
    const leaderRegistry = createMemberToolRegistry({ deps });
    await assert.rejects(
      () => leaderRegistry.definitions().find((tool) => tool.name === "run_command")
        .execute("run-unavailable", { taskId: task.taskId }),
      (error) => error?.code === "TIANGONG_RUNNER_UNAVAILABLE",
    );
  });
});

test("exact ResultEnvelope replay re-drives the idempotent notification boundary", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-m3-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const task = designTask(boundProject, "task-design-m3");
    await createProject(boundProject, depsFor(LEADER, root));
    await dispatchTask(task, depsFor(LEADER, root));
    const deps = depsFor(DESIGNER, root);
    const submit = createMemberToolRegistry({ deps }).definitions().find((tool) => tool.name === "team_submit_result");
    const params = { taskId: task.taskId, claim: "first", evidenceRefs: ["evidence-design"] };
    await submit.execute("submit-1", params);
    const replay = await submit.execute("submit-2", params);
    assert.equal(details(replay).replayed, true);
    assert.equal(details(replay).notified, false);
    assert.equal(deps.channel.calls.filter((call) => call.kind === "notifyLeader").length, 2);
  });
});

test("approved deployment auto-submits one bound release ResultEnvelope", async () => {
  await withRoot(async (root) => {
    const boundProject = project("proj-auto-release-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await createProject(boundProject, depsFor(LEADER, root));
    const implementor = professionalTask(boundProject, "task-implement-auto", {
      taskKind: "implement", assignee: "tiangong-implementor", role: "implementor",
    });
    await dispatchTask(implementor, depsFor(LEADER, root));
    const changeRevisionRef = createChangeRevisionRef({
      producerTaskId: implementor.taskId,
      artifactPath: "artifacts/change.tar",
      artifactDigest: "a".repeat(64),
      revision: 0,
      contentDigest: "b".repeat(64),
    });
    const implementResult = createResultEnvelope({
      taskId: implementor.taskId,
      projectId: boundProject.projectId,
      producer: implementor.assignee,
      taskKind: implementor.taskKind,
      revisionIndex: implementor.revisionIndex,
      sourceRole: "implementor",
      playbookDigest: boundProject.playbookDigest,
      taskBindingDigest: implementor.contentDigest,
      completionContractDigest: implementor.completionContractDigest,
      sourceProfileDigest: implementor.sourceProfileDigest,
      sourceSkillId: implementor.sourceSkillId,
      skillDigest: implementor.sourceSkillDigest,
      claim: "sealed",
      changeRevisionRef,
      createdAt: T(2),
    });
    await submitResult(implementResult, depsFor(implementor.assignee, root));
    await recordTaskDecision(createTaskDecision({
      taskId: implementor.taskId,
      projectId: boundProject.projectId,
      playbookDigest: boundProject.playbookDigest,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: implementResult.contentDigest,
      createdAt: T(3),
    }), depsFor(LEADER, root));

    const assessor = professionalTask(boundProject, "task-assess-auto", {
      taskKind: "assess", assignee: "tiangong-assessor", role: "assessor", inputRefs: [implementor.taskId],
    });
    await dispatchTask(assessor, depsFor(LEADER, root));
    const assessorResult = createResultEnvelope({
      taskId: assessor.taskId,
      projectId: boundProject.projectId,
      producer: assessor.assignee,
      taskKind: assessor.taskKind,
      revisionIndex: assessor.revisionIndex,
      sourceRole: "assessor",
      playbookDigest: boundProject.playbookDigest,
      taskBindingDigest: assessor.contentDigest,
      completionContractDigest: assessor.completionContractDigest,
      sourceProfileDigest: assessor.sourceProfileDigest,
      sourceSkillId: assessor.sourceSkillId,
      skillDigest: assessor.sourceSkillDigest,
      claim: "accepted",
      changeRevisionRef,
      createdAt: T(4),
    });
    await submitResult(assessorResult, depsFor(assessor.assignee, root));
    await recordTaskDecision(createTaskDecision({
      taskId: assessor.taskId,
      projectId: boundProject.projectId,
      playbookDigest: boundProject.playbookDigest,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: assessorResult.contentDigest,
      createdAt: T(5),
    }), depsFor(LEADER, root));

    const release = professionalTask(boundProject, "task-release-auto", {
      taskKind: "release", assignee: "tiangong-operator", role: "operator", inputRefs: [assessor.taskId],
    });
    await dispatchTask(release, depsFor(LEADER, root));
    const operatorDeps = depsFor(release.assignee, root);
    operatorDeps.professionalRole = "operator";
    operatorDeps.sourceSkillId = "operator-v1";
    operatorDeps.deploymentBrokerEndpoint = "http://deployment-broker:8791/v1/deploy";
    operatorDeps.deploymentReceiptStore = {};
    operatorDeps.idempotencyStore = { get() {} };
    operatorDeps.pendingOperationStore = {};
    const deployment = createMemberToolRegistry({ deps: operatorDeps }).definitions()
      .find((tool) => tool.name === "deploy_release");
    const outcome = createDeploymentOutcome({
      taskId: release.taskId,
      targetId: "target-auto",
      operationDigest: "c".repeat(64),
      previousDigest: "d".repeat(64),
      currentDigest: changeRevisionRef.artifactDigest,
      changeRevisionRef,
      disposition: "DELIVERED",
      postVerifyHealthy: true,
      rollbackPerformed: false,
      previousVerifyHealthy: null,
    });

    await deployment.onApprovalResult({ details: { outcome } });
    const stored = await readTaskResult(release.taskId, { rootDir: root });
    assert.equal(stored.releaseOutcome.contentDigest, outcome.contentDigest);
    assert.equal(stored.changeRevisionRef.contentDigest, changeRevisionRef.contentDigest);
    assert.equal(operatorDeps.channel.calls.filter((call) => call.kind === "notifyLeader").length, 1);
    assert.equal(operatorDeps.evidence.events.filter((event) => event.type === "deployment.release.result.autosubmitted").length, 1);
  });
});
