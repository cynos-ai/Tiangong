import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import {
  checkResult,
  createProject,
  createTaskDecision,
  dispatchTask,
  recordTaskDecision,
  resolveAssignedTask,
  submitResult,
} from "../agent/team/team-task-port.mjs";
import { createResultEnvelope } from "../agent/work/result-envelope.mjs";

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
