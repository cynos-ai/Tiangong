import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { RUNNER_BROKER_ENDPOINT_DIGEST } from "../agent/runner/preparation-client.mjs";
import { createDeploymentOutcome } from "../agent/deployment/client.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import { projectDisposition } from "../agent/team/project-chain.mjs";
import {
  checkResult,
  createProject,
  createTaskDecision,
  dispatchTask,
  recordTaskDecision,
  resolveAssignedTask,
  submitResult,
} from "../agent/team/team-task-port.mjs";
import { createChangeRevisionRef } from "../agent/work/change-revision-ref.mjs";
import { createResultEnvelope } from "../agent/work/result-envelope.mjs";
import { readTaskBinding } from "../agent/team/manifest-store.mjs";

const PLAYBOOK_DIGEST = sha256("playbook-1");
const CONTRACT_DIGEST = sha256("contract");
const PROFILE_DIGEST = sha256("profile");
const SKILL_DIGEST = sha256("skill");
const T0 = "2026-08-01T12:00:00Z";
const T1 = "2026-08-01T12:01:00Z";
const T2 = "2026-08-01T12:02:00Z";
const LEADER = "tiangong-leader";
const DESIGNER = "tiangong-designer";
const IMPL = "tiangong-implementor";
const ASSESSOR = "tiangong-assessor";
const OPERATOR = "tiangong-operator";

function channel() {
  const calls = [];
  return {
    calls,
    async assertTeamIdentity(role) { return { team: "team-1", role }; },
    async assertTeamRoster() { return { roomId: "!team:example.test", roomIdDigest: "f".repeat(64), memberDigests: [] }; },
    async notifyAssignee(worker, taskId, digest) {
      calls.push({ kind: "notifyAssignee", worker, taskId, digest });
      return { queued: true, delivered: false };
    },
    async notifyLeader(taskId, digest) {
      calls.push({ kind: "notifyLeader", taskId, digest });
      return { queued: true, delivered: false };
    },
    async reportRequester() {
      return { queued: true, delivered: false };
    },
  };
}
function evidence() {
  const events = [];
  return { events, async append(event) { events.push(event); } };
}
function sync() {
  const calls = [];
  return {
    calls,
    async beforeRead() { calls.push("beforeRead"); },
    async afterWrite() { calls.push("afterWrite"); },
  };
}
function depsFor(worker, root, extra = {}) {
  return {
    rootDir: root,
    env: {
      AGENTTEAMS_WORKER_NAME: worker,
      AGENTTEAMS_WORKER_ROLE: worker === LEADER ? "team_leader" : "worker",
      AGENTTEAMS_WORKER_ROOM_ID: `room-${worker}`,
      AGENTTEAMS_MATRIX_DOMAIN: "example.test",
    },
    channel: channel(),
    sync: sync(),
    evidence: evidence(),
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
    ...extra,
  };
}
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-team-port-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function projectBinding() {
  return createProjectBinding({
    projectId: "proj-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookId: "software-change-delivery",
    playbookVersion: "1.0.0",
    playbookDigest: PLAYBOOK_DIGEST,
    requester: "@manager:example.test",
    roleBindings: {
      team_leader: LEADER,
      designer: DESIGNER,
      implementor: IMPL,
      assessor: ASSESSOR,
      operator: OPERATOR,
    },
    createdAt: T0,
  });
}
function taskBinding(overrides = {}) {
  return createTaskBinding({
    taskId: "task-design-0",
    projectId: projectBinding().projectId,
    playbookStepId: "design",
    taskKind: "design",
    revisionIndex: 0,
    assignee: DESIGNER,
    objective: "Design the bounded change and acceptance contract.",
    completionContractDigest: CONTRACT_DIGEST,
    sourceProfileDigest: PROFILE_DIGEST,
    sourceSkillId: "designer-v1",
    sourceSkillDigest: SKILL_DIGEST,
    inputRefs: [],
    createdAt: T1,
    ...overrides,
  });
}
function resultEnvelope(task, overrides = {}) {
  return createResultEnvelope({
    taskId: task.taskId,
    projectId: task.projectId,
    producer: task.assignee,
    taskKind: task.taskKind,
    revisionIndex: task.revisionIndex,
    sourceRole: "designer",
    playbookDigest: PLAYBOOK_DIGEST,
    taskBindingDigest: task.contentDigest,
    completionContractDigest: task.completionContractDigest,
    sourceProfileDigest: PROFILE_DIGEST,
    sourceSkillId: "designer-v1",
    skillDigest: SKILL_DIGEST,
    claim: "design complete",
    artifactRefs: [],
    evidenceRefs: ["evidence-design"],
    createdAt: T2,
    ...overrides,
  });
}

async function setup(root) {
  const project = projectBinding();
  const task = taskBinding();
  await createProject(project, depsFor(LEADER, root));
  await dispatchTask(task, depsFor(LEADER, root));
  return { project, task };
}

test("full bound flow writes static-oracle-compatible AgentTeams Project/Task records", async () => {
  await withRoot(async (root) => {
    const { project, task } = await setup(root);
    const resolved = await resolveAssignedTask(task.taskId, depsFor(DESIGNER, root));
    assert.equal(resolved.taskBinding.assignee, DESIGNER);

    const result = resultEnvelope(task);
    const workerDeps = depsFor(DESIGNER, root);
    const submitted = await submitResult(result, workerDeps);
    assert.equal(submitted.notified, false);
    assert.equal(submitted.notificationQueued, true);
    const submittedMeta = JSON.parse(await readFile(join(root, "tasks", task.taskId, "meta.json"), "utf8"));
    assert.equal(submittedMeta.status, "assigned");

    const checked = await checkResult(task.taskId, depsFor(LEADER, root));
    assert.deepEqual(checked.result, result);
    const decision = createTaskDecision({
      taskId: task.taskId,
      projectId: project.projectId,
      playbookDigest: project.playbookDigest,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: result.contentDigest,
      createdAt: T2,
    });
    await recordTaskDecision(decision, depsFor(LEADER, root));

    const projectMeta = JSON.parse(await readFile(join(root, "projects", project.projectId, "meta.json"), "utf8"));
    const meta = JSON.parse(await readFile(join(root, "tasks", task.taskId, "meta.json"), "utf8"));
    const resultMarkdown = await readFile(join(root, "tasks", task.taskId, "result.md"), "utf8");
    const plan = await readFile(join(root, "projects", project.projectId, "plan.md"), "utf8");
    assert.deepEqual(Object.keys(projectMeta).sort(), ["confirmed_at", "created_at", "project_id", "project_room_id", "status", "title", "workers"]);
    assert.equal(projectMeta.project_room_id, "!team:example.test");
    assert.deepEqual(Object.keys(meta).sort(), ["assigned_at", "assigned_to", "depends_on", "project_id", "room_id", "status", "task_id", "task_title"]);
    assert.equal(meta.room_id, "!team:example.test");
    assert.equal(meta.status, "completed");
    assert.match(resultMarkdown, /\*\*Status\*\*: SUCCESS/u);
    assert.match(plan, new RegExp(`- \\[x\\] ${task.taskId}`));
    assert.match(plan, /Tiangong Binding/u);
  });
});

test("Runner preparation completes before an implement Task notification", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    await createProject(project, depsFor(LEADER, root));
    const task = taskBinding({ taskId: "task-implement-prepared", taskKind: "implement", assignee: IMPL, sourceSkillId: "implementor-v1" });
    const order = [];
    const deps = depsFor(LEADER, root);
    deps.runnerBrokerPreparation = {
      async prepare({ taskBinding: prepared }) {
        order.push("prepare");
        return {
          schemaVersion: 1,
          status: "ready",
          taskId: prepared.taskId,
          taskBindingDigest: prepared.contentDigest,
          bindingDigest: "b".repeat(64),
          endpointDigest: RUNNER_BROKER_ENDPOINT_DIGEST,
          replayed: false,
        };
      },
    };
    deps.channel = {
      ...deps.channel,
      async notifyAssignee() {
        order.push("notify");
        return { queued: true, delivered: false };
      },
    };
    await dispatchTask(task, deps);
    assert.deepEqual(order, ["prepare", "notify"]);
    assert.equal(deps.evidence.events.filter((event) => event.type === "runner.broker.prepared").length, 1);
  });
});

test("Runner preparation failure leaves the Task durable but does not notify the assignee", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    await createProject(project, depsFor(LEADER, root));
    const task = taskBinding({ taskId: "task-implement-unprepared", taskKind: "implement", assignee: IMPL, sourceSkillId: "implementor-v1" });
    const deps = depsFor(LEADER, root);
    let notifications = 0;
    let preparations = 0;
    deps.runnerBrokerPreparation = {
      async prepare() {
        preparations += 1;
        const error = new Error("hidden preparation failure");
        error.code = "RUNNER_BROKER_PREPARATION_REJECTED";
        throw error;
      },
    };
    deps.channel = {
      ...deps.channel,
      async notifyAssignee() {
        notifications += 1;
        return { queued: true, delivered: false };
      },
    };
    await assert.rejects(
      () => dispatchTask(task, deps),
      (error) => error.code === "RUNNER_BROKER_PREPARATION_REJECTED",
    );
    assert.equal(notifications, 0);
    assert.equal(preparations, 1);
    assert.equal((await readTaskBinding(task.taskId, deps)).contentDigest, task.contentDigest);
    await assert.rejects(
      () => dispatchTask(task, deps),
      (error) => error.code === "RUNNER_BROKER_PREPARATION_RETRY_BLOCKED",
    );
    assert.equal(preparations, 1);
    assert.equal(notifications, 0);
    const failure = deps.evidence.events.find((event) => event.type === "runner.broker.preparation.failed");
    assert.equal(failure.errorCode, "RUNNER_BROKER_PREPARATION_REJECTED");
    assert.equal(deps.evidence.events.filter((event) => event.type === "runner.broker.preparation.retry_blocked").length, 1);
  });
});

test("an accepted release machine outcome authorizes DELIVERED", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    await createProject(project, depsFor(LEADER, root));
    const tasks = {
      design: taskBinding({ taskId: "design-delivered", createdAt: "2026-08-01T12:01:00Z" }),
      implement: taskBinding({ taskId: "implement-delivered", taskKind: "implement", assignee: IMPL, sourceSkillId: "implementor-v1", inputRefs: ["design-delivered"], createdAt: "2026-08-01T12:02:00Z" }),
      assess: taskBinding({ taskId: "assess-delivered", taskKind: "assess", assignee: ASSESSOR, sourceSkillId: "assessor-v1", inputRefs: ["implement-delivered"], createdAt: "2026-08-01T12:03:00Z" }),
      release: taskBinding({ taskId: "release-delivered", taskKind: "release", assignee: OPERATOR, sourceSkillId: "operator-v1", inputRefs: ["assess-delivered"], createdAt: "2026-08-01T12:04:00Z" }),
    };
    const revision = createChangeRevisionRef({ producerTaskId: tasks.implement.taskId, artifactPath: "revision.tar", artifactDigest: "9".repeat(64), revision: 0 });
    const results = {
      design: resultEnvelope(tasks.design),
      implement: resultEnvelope(tasks.implement, { sourceRole: "implementor", sourceSkillId: "implementor-v1", claim: "implemented", changeRevisionRef: revision, evidenceRefs: ["runner-implement"] }),
      assess: resultEnvelope(tasks.assess, { sourceRole: "assessor", sourceSkillId: "assessor-v1", claim: "verified", changeRevisionRef: revision, evidenceRefs: ["runner-assess"] }),
    };
    const outcome = createDeploymentOutcome({ taskId: tasks.release.taskId, targetId: "target-a", operationDigest: "8".repeat(64), previousDigest: "7".repeat(64), currentDigest: revision.artifactDigest, changeRevisionRef: revision, disposition: "DELIVERED", postVerifyHealthy: true, rollbackPerformed: false, previousVerifyHealthy: null });
    results.release = resultEnvelope(tasks.release, { sourceRole: "operator", sourceSkillId: "operator-v1", claim: "deployed and verified", changeRevisionRef: revision, releaseOutcome: outcome, evidenceRefs: ["deployment-receipt"] });
    for (const kind of ["design", "implement", "assess", "release"]) {
      const task = tasks[kind]; const result = results[kind];
      await dispatchTask(task, depsFor(LEADER, root));
      await submitResult(result, depsFor(task.assignee, root));
      await recordTaskDecision(createTaskDecision({ taskId: task.taskId, projectId: project.projectId, playbookDigest: project.playbookDigest, decision: "accept", revisionIndex: 0, decidedBy: LEADER, resultDigest: result.contentDigest, createdAt: T2 }), depsFor(LEADER, root));
    }
    assert.equal(await projectDisposition(project.projectId, { rootDir: root, maxRevisionWaves: 2 }), "DELIVERED");
  });
});

test("a blocker ResultEnvelope cannot be accepted or advance the Task", async () => {
  await withRoot(async (root) => {
    const { project, task } = await setup(root);
    const result = resultEnvelope(task, { blocker: "controlled executor unavailable" });
    await submitResult(result, depsFor(DESIGNER, root));
    const fields = {
      taskId: task.taskId,
      projectId: project.projectId,
      playbookDigest: project.playbookDigest,
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: result.contentDigest,
      createdAt: T2,
    };
    const accept = createTaskDecision({ ...fields, decision: "accept" });
    await assert.rejects(
      () => recordTaskDecision(accept, depsFor(LEADER, root)),
      /requires a blocked decision/u,
    );
    const blocked = createTaskDecision({ ...fields, decision: "blocked" });
    await recordTaskDecision(blocked, depsFor(LEADER, root));
    const meta = JSON.parse(await readFile(join(root, "tasks", task.taskId, "meta.json"), "utf8"));
    assert.equal(meta.status, "blocked");
    assert.equal(await projectDisposition(project.projectId, { rootDir: root }), "RECOVERY_REQUIRED");
  });
});

test("Assessor Results must bind the exact accepted Implementor ChangeRevision", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    await createProject(project, depsFor(LEADER, root));
    const implementTask = taskBinding({
      taskId: "task-implement-0",
      taskKind: "implement",
      assignee: IMPL,
      sourceSkillId: "implementor-v1",
    });
    await dispatchTask(implementTask, depsFor(LEADER, root));
    const revision = {
      producerTaskId: implementTask.taskId,
      artifactPath: "objects/task-implement-0/revision",
      artifactDigest: sha256("revision-0"),
      revision: 0,
    };
    const implementation = resultEnvelope(implementTask, {
      sourceRole: "implementor",
      sourceSkillId: "implementor-v1",
      claim: "implementation complete",
      changeRevisionRef: revision,
    });
    await submitResult(implementation, depsFor(IMPL, root));
    await recordTaskDecision(createTaskDecision({
      taskId: implementTask.taskId,
      projectId: project.projectId,
      playbookDigest: project.playbookDigest,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: implementation.contentDigest,
      createdAt: T2,
    }), depsFor(LEADER, root));

    const assessTask = taskBinding({
      taskId: "task-assess-0",
      taskKind: "assess",
      assignee: ASSESSOR,
      sourceSkillId: "assessor-v1",
      inputRefs: [implementTask.taskId],
    });
    await dispatchTask(assessTask, depsFor(LEADER, root));
    const assessmentInput = {
      sourceRole: "assessor",
      sourceSkillId: "assessor-v1",
      claim: "assessment complete",
    };
    const forged = resultEnvelope(assessTask, {
      ...assessmentInput,
      changeRevisionRef: { ...revision, artifactDigest: sha256("forged") },
    });
    await assert.rejects(
      () => submitResult(forged, depsFor(ASSESSOR, root)),
      /not the accepted Implementor artifact/u,
    );
    const assessment = resultEnvelope(assessTask, { ...assessmentInput, changeRevisionRef: revision });
    assert.equal((await submitResult(assessment, depsFor(ASSESSOR, root))).result.contentDigest, assessment.contentDigest);
  });
});

test("immutable operation replay re-syncs and re-drives the idempotent notification boundary", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    const leaderDeps = depsFor(LEADER, root);
    await createProject(project, leaderDeps);
    const replayProject = await createProject(project, leaderDeps);
    assert.equal(replayProject.replayed, true);
    assert.equal(leaderDeps.sync.calls.filter((call) => call === "afterWrite").length, 2);

    const task = taskBinding();
    const firstDeps = depsFor(LEADER, root);
    await dispatchTask(task, firstDeps);
    const replayDeps = depsFor(LEADER, root);
    const replay = await dispatchTask(task, replayDeps);
    assert.equal(replay.replayed, true);
    assert.equal(replayDeps.channel.calls.length, 1);
    assert.ok(replayDeps.sync.calls.includes("afterWrite"));
  });
});

test("ResultEnvelope source and every binding digest fail closed", async () => {
  await withRoot(async (root) => {
    const { task } = await setup(root);
    await assert.rejects(
      () => submitResult(resultEnvelope(task, { producer: IMPL }), depsFor(DESIGNER, root)),
      /producer does not match/u,
    );
    await assert.rejects(
      () => submitResult(resultEnvelope(task, { taskBindingDigest: sha256("stale") }), depsFor(DESIGNER, root)),
      /taskBindingDigest does not match/u,
    );
    await assert.rejects(
      () => submitResult(resultEnvelope(task, { completionContractDigest: sha256("wrong") }), depsFor(DESIGNER, root)),
      /completionContractDigest does not match/u,
    );
    await assert.rejects(
      () => submitResult(resultEnvelope(task, { sourceProfileDigest: sha256("forged-profile") }), depsFor(DESIGNER, root)),
      /sourceProfileDigest does not match/u,
    );
    await assert.rejects(
      () => submitResult(resultEnvelope(task, { skillDigest: sha256("forged-skill") }), depsFor(DESIGNER, root)),
      /skillDigest does not match/u,
    );
  });
});

test("assigned Task resolution uses the bounded pre-task Team identity gate", async () => {
  await withRoot(async (root) => {
    const { task } = await setup(root);
    const deps = depsFor(DESIGNER, root);
    let readinessCalls = 0;
    deps.channel = {
      ...deps.channel,
      async waitForTeamIdentity(role) {
        readinessCalls += 1;
        assert.equal(role, "worker");
        return { team: "team-1", role };
      },
    };
    const resolved = await resolveAssignedTask(task.taskId, deps);
    assert.equal(resolved.taskBinding.taskId, task.taskId);
    assert.equal(readinessCalls, 1);
  });
});

test("non-assignee and forged Leader decision identities are rejected", async () => {
  await withRoot(async (root) => {
    const { project, task } = await setup(root);
    await assert.rejects(() => resolveAssignedTask(task.taskId, depsFor(IMPL, root)), /not the assignee/u);
    const result = resultEnvelope(task);
    await submitResult(result, depsFor(DESIGNER, root));
    const forged = createTaskDecision({
      taskId: task.taskId,
      projectId: project.projectId,
      playbookDigest: project.playbookDigest,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: "forged-leader",
      resultDigest: result.contentDigest,
      createdAt: T2,
    });
    await assert.rejects(() => recordTaskDecision(forged, depsFor(LEADER, root)), /decidedBy/u);
    assert.throws(
      () => createTaskDecision({
        taskId: task.taskId,
        projectId: project.projectId,
        playbookDigest: project.playbookDigest,
        decision: "accept",
        revisionIndex: 0,
        decidedBy: LEADER,
        createdAt: T2,
      }),
      /resultDigest/u,
    );
  });
});

test("a Task has exactly one terminal decision and replay is exact", async () => {
  await withRoot(async (root) => {
    const { project, task } = await setup(root);
    const result = resultEnvelope(task);
    await submitResult(result, depsFor(DESIGNER, root));
    const accept = createTaskDecision({
      taskId: task.taskId,
      projectId: project.projectId,
      playbookDigest: project.playbookDigest,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: result.contentDigest,
      createdAt: T2,
    });
    await recordTaskDecision(accept, depsFor(LEADER, root));
    const replay = await recordTaskDecision(accept, depsFor(LEADER, root));
    assert.equal(replay.replayed, true);
    const blocked = createTaskDecision({
      taskId: task.taskId,
      projectId: project.projectId,
      playbookDigest: project.playbookDigest,
      decision: "blocked",
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: result.contentDigest,
      createdAt: T2,
    });
    await assert.rejects(() => recordTaskDecision(blocked, depsFor(LEADER, root)), /different terminal decision/u);
  });
});
