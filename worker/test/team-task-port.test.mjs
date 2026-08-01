import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import {
  assertAssignee,
  assertLeaderForProject,
  loadWorkerIdentity,
} from "../agent/team/team-context.mjs";
import {
  checkResult,
  createProject,
  createTaskDecision,
  createTaskResult,
  dispatchTask,
  recordTaskDecision,
  resolveAssignedTask,
  submitResult,
} from "../agent/team/team-task-port.mjs";

const PLAYBOOK_DIGEST = sha256("playbook-1");
const CONTRACT_DIGEST = sha256("contract");
const T0 = "2026-08-01T12:00:00Z";
const T1 = "2026-08-01T12:01:00Z";
const T2 = "2026-08-01T12:02:00Z";
const LEADER = "tiangong-leader";
const IMPL = "tiangong-implementor";
const OTHER = "tiangong-other";

function recorder() {
  const calls = [];
  return {
    calls,
    notifyAssignee: (w, t, d) => calls.push({ kind: "notifyAssignee", worker: w, taskId: t, digest: d }),
    notifyLeader: (t, d) => calls.push({ kind: "notifyLeader", taskId: t, digest: d }),
  };
}
function evidenceRecorder() {
  const events = [];
  return { events, record: (event) => events.push(event) };
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-team-port-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function projectBinding() {
  return createProjectBinding({
    projectId: "proj-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookId: "software-change-delivery",
    playbookVersion: "1.0.0",
    playbookDigest: PLAYBOOK_DIGEST,
    roleBindings: { team_leader: LEADER, implementor: IMPL },
    createdAt: T0,
  });
}
function taskBinding(revisionIndex = 0) {
  return createTaskBinding({
    taskId: `task-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${String(revisionIndex).padStart(2, "0")}`,
    projectId: "proj-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookStepId: `implement.${revisionIndex + 1}`,
    taskKind: "implement",
    revisionIndex,
    assignee: IMPL,
    completionContractDigest: CONTRACT_DIGEST,
    inputRefs: [],
    createdAt: T1,
  });
}
function depsFor(worker, root, extra = {}) {
  return {
    rootDir: root,
    env: { AGENTTEAMS_WORKER_NAME: worker, AGENTTEAMS_WORKER_ROOM_ID: `room-${worker}` },
    channel: recorder(),
    sync: { beforeRead: () => {} },
    evidence: evidenceRecorder(),
    ...extra,
  };
}

test("full leader dispatch -> worker submit -> leader check -> accept coordination", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    await createProject(project, depsFor(LEADER, root));

    const task = taskBinding(0);
    const leaderDeps = depsFor(LEADER, root);
    const dispatched = await dispatchTask(task, leaderDeps);
    assert.equal(dispatched.replayed, false);
    assert.equal(dispatched.notified, true);
    assert.equal(leaderDeps.channel.calls.filter((c) => c.kind === "notifyAssignee").length, 1);

    const resolved = await resolveAssignedTask(task.taskId, depsFor(IMPL, root));
    assert.equal(resolved.taskBinding.assignee, IMPL);

    const result = createTaskResult({
      taskId: task.taskId,
      projectId: project.projectId,
      producer: IMPL,
      summary: "implemented and self-checked",
      artifactRefs: ["artifact-1"],
      createdAt: T2,
    });
    const workerDeps = depsFor(IMPL, root);
    const submitted = await submitResult(result, workerDeps);
    assert.equal(submitted.notified, true);
    assert.equal(workerDeps.channel.calls.filter((c) => c.kind === "notifyLeader").length, 1);

    const checked = await checkResult(task.taskId, depsFor(LEADER, root));
    assert.deepEqual(checked.result, result);
    assert.deepEqual(checked.decisions, []);

    const accept = createTaskDecision({
      decisionId: "dec-accept-1",
      taskId: task.taskId,
      projectId: project.projectId,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      resultDigest: result.contentDigest,
      createdAt: T2,
    });
    const decision = await recordTaskDecision(accept, depsFor(LEADER, root));
    assert.equal(decision.replayed, false);
  });
});

test("dispatch is idempotent: replay does not re-notify the assignee", async () => {
  await withRoot(async (root) => {
    await createProject(projectBinding(), depsFor(LEADER, root));
    const task = taskBinding(0);
    const d1 = depsFor(LEADER, root);
    await dispatchTask(task, d1);
    const d2 = depsFor(LEADER, root);
    const replayed = await dispatchTask(task, d2);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.notified, false);
    assert.equal(d2.channel.calls.length, 0);
  });
});

test("submit is idempotent: replay does not re-notify the leader", async () => {
  await withRoot(async (root) => {
    await createProject(projectBinding(), depsFor(LEADER, root));
    const task = taskBinding(0);
    await dispatchTask(task, depsFor(LEADER, root));
    const result = createTaskResult({
      taskId: task.taskId,
      projectId: projectBinding().projectId,
      producer: IMPL,
      summary: "done",
      createdAt: T2,
    });
    const w1 = depsFor(IMPL, root);
    await submitResult(result, w1);
    const w2 = depsFor(IMPL, root);
    const replayed = await submitResult(result, w2);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.notified, false);
    assert.equal(w2.channel.calls.length, 0);
  });
});

test("a decision replayed by the same decision id is idempotent", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    await createProject(project, depsFor(LEADER, root));
    const task = taskBinding(0);
    await dispatchTask(task, depsFor(LEADER, root));
    await submitResult(
      createTaskResult({
        taskId: task.taskId,
        projectId: project.projectId,
        producer: IMPL,
        summary: "done",
        createdAt: T2,
      }),
      depsFor(IMPL, root),
    );
    const accept = createTaskDecision({
      decisionId: "dec-accept-1",
      taskId: task.taskId,
      projectId: project.projectId,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      createdAt: T2,
    });
    const first = await recordTaskDecision(accept, depsFor(LEADER, root));
    const second = await recordTaskDecision(accept, depsFor(LEADER, root));
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
  });
});

test("a non-leader cannot dispatch, check, or decide", async () => {
  await withRoot(async (root) => {
    await createProject(projectBinding(), depsFor(LEADER, root));
    const task = taskBinding(0);
    await assert.rejects(() => dispatchTask(task, depsFor(OTHER, root)), /not the team_leader/u);
  });
});

test("a non-assignee cannot resolve or submit, and accept requires a result", async () => {
  await withRoot(async (root) => {
    const project = projectBinding();
    await createProject(project, depsFor(LEADER, root));
    const task = taskBinding(0);
    await dispatchTask(task, depsFor(LEADER, root));
    await assert.rejects(() => resolveAssignedTask(task.taskId, depsFor(OTHER, root)), /not the assignee/u);
    const result = createTaskResult({
      taskId: task.taskId,
      projectId: project.projectId,
      producer: OTHER,
      summary: "forged",
      createdAt: T2,
    });
    await assert.rejects(() => submitResult(result, depsFor(OTHER, root)), /not the assignee/u);
    const accept = createTaskDecision({
      decisionId: "dec-accept-1",
      taskId: task.taskId,
      projectId: project.projectId,
      decision: "accept",
      revisionIndex: 0,
      decidedBy: LEADER,
      createdAt: T2,
    });
    await assert.rejects(() => recordTaskDecision(accept, depsFor(LEADER, root)), /no submitted result/u);
  });
});

test("team context authorizes against immutable roleBindings and assignee", () => {
  const leader = loadWorkerIdentity({ env: { AGENTTEAMS_WORKER_NAME: LEADER } });
  const member = loadWorkerIdentity({ env: { AGENTTEAMS_WORKER_NAME: IMPL } });
  const project = projectBinding();
  assertLeaderForProject(leader, project);
  assert.throws(() => assertLeaderForProject(member, project), /not the team_leader/u);
  assertAssignee(member, taskBinding(0));
  assert.throws(() => assertAssignee(leader, taskBinding(0)), /not the assignee/u);
  assert.throws(
    () => loadWorkerIdentity({ env: { AGENTTEAMS_WORKER_NAME: "bad name!" } }),
    /missing or invalid/u,
  );
});

test("a result bound to the wrong project is rejected", async () => {
  await withRoot(async (root) => {
    await createProject(projectBinding(), depsFor(LEADER, root));
    const task = taskBinding(0);
    await dispatchTask(task, depsFor(LEADER, root));
    const result = createTaskResult({
      taskId: task.taskId,
      projectId: "proj-wrong",
      producer: IMPL,
      summary: "x",
      createdAt: T2,
    });
    await assert.rejects(() => submitResult(result, depsFor(IMPL, root)), /does not match/u);
  });
});
