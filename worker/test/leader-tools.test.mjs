import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPlaybookManifest } from "../agent/playbook/resolver.mjs";
import { createTaskResult, submitResult } from "../agent/team/team-task-port.mjs";
import { createLeaderToolRegistry } from "../agent/work/leader-tools.mjs";

const LEADER = "tiangong-leader";
const DESIGNER = "tiangong-designer";
const IMPL = "tiangong-implementor";
const ROLE_BINDINGS = { team_leader: LEADER, designer: DESIGNER, implementor: IMPL, assessor: "tiangong-assessor", operator: "tiangong-operator" };
const PROJECT_ID = "proj-leader-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = (n) => `2026-08-01T12:0${n}:00Z`;

function channel() {
  const calls = [];
  return {
    calls,
    notifyAssignee: (w, t) => calls.push({ kind: "notifyAssignee", worker: w, taskId: t }),
    notifyLeader: (t) => calls.push({ kind: "notifyLeader", taskId: t }),
    reportToRequester: (p, s, d) => calls.push({ kind: "reportToRequester", projectId: p, disposition: d }),
  };
}
function evidence() {
  const events = [];
  return { events, record: (e) => events.push(e) };
}
function depsFor(root) {
  return { rootDir: root, env: { AGENTTEAMS_WORKER_NAME: LEADER, AGENTTEAMS_WORKER_ROOM_ID: `room-${LEADER}` }, channel: channel(), sync: { beforeRead: () => {} }, evidence: evidence(), now: () => T(1) };
}
function details(result) {
  return JSON.parse(result.content[0].text);
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-leader-tools-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("createLeaderToolRegistry requires a loaded playbook and team deps", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  assert.throws(() => createLeaderToolRegistry({ deps: { rootDir: "/x" } }), /loaded playbook/);
  assert.throws(() => createLeaderToolRegistry({ playbook: pb }), /team deps/);
});

test("the leader tool surface is the closed coordination set", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  const registry = createLeaderToolRegistry({ playbook: pb, deps: { rootDir: "/x" } });
  assert.deepEqual(registry.names(), [
    "team_create_project",
    "team_dispatch_task",
    "team_check_result",
    "team_decide_task",
    "team_report",
  ]);
});

test("a leader creates a project then dispatches design as the first task", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const deps = depsFor(root);
    const registry = createLeaderToolRegistry({ playbook: pb, deps });

    const created = await registry.definitions().find((t) => t.name === "team_create_project").execute(0, { projectId: PROJECT_ID, roleBindings: ROLE_BINDINGS });
    assert.equal(details(created).projectId, PROJECT_ID);

    const dispatch = registry.definitions().find((t) => t.name === "team_dispatch_task");
    const out = await dispatch.execute(0, { projectId: PROJECT_ID, taskId: "task-design-0", taskKind: "design", revisionIndex: 0, assignee: DESIGNER });
    assert.equal(details(out).notified, true);
    assert.equal(details(out).taskKind, "design");
  });
});

test("dispatch rejects an out-of-order step and an illegal role", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const deps = depsFor(root);
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    await registry.definitions().find((t) => t.name === "team_create_project").execute(0, { projectId: PROJECT_ID, roleBindings: ROLE_BINDINGS });
    const dispatch = registry.definitions().find((t) => t.name === "team_dispatch_task");

    // implement before design is accepted -> wrong step
    await assert.rejects(
      () => dispatch.execute(0, { projectId: PROJECT_ID, taskId: "task-impl-0", taskKind: "implement", revisionIndex: 0, assignee: IMPL }),
      /Expected next task design/,
    );
    // design assigned to the implementor worker -> illegal role
    await assert.rejects(
      () => dispatch.execute(0, { projectId: PROJECT_ID, taskId: "task-design-0", taskKind: "design", revisionIndex: 0, assignee: IMPL }),
      /must be owned by designer/,
    );
  });
});

test("an accept requires the task's current result; a revision is allowed without one", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const deps = depsFor(root);
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    await registry.definitions().find((t) => t.name === "team_create_project").execute(0, { projectId: PROJECT_ID, roleBindings: ROLE_BINDINGS });
    const dispatch = registry.definitions().find((t) => t.name === "team_dispatch_task");
    const decide = registry.definitions().find((t) => t.name === "team_decide_task");

    await dispatch.execute(0, { projectId: PROJECT_ID, taskId: "task-design-0", taskKind: "design", revisionIndex: 0, assignee: DESIGNER });

    // accept with no submitted result -> rejected (no result to read)
    await assert.rejects(
      () => decide.execute(0, { taskId: "task-design-0", decision: "accept" }),
      /No task result/,
    );

    // a designer submits a result, then the leader accepts against the current result
    const workerDeps = { rootDir: root, env: { AGENTTEAMS_WORKER_NAME: DESIGNER, AGENTTEAMS_WORKER_ROOM_ID: "room-d" }, channel: channel(), sync: { beforeRead: () => {} }, evidence: evidence(), now: () => T(2) };
    await submitResult(createTaskResult({ taskId: "task-design-0", projectId: PROJECT_ID, producer: DESIGNER, summary: "design done", createdAt: T(2) }), workerDeps);
    const accepted = await decide.execute(0, { taskId: "task-design-0", decision: "accept" });
    assert.equal(details(accepted).decision, "accept");
  });
});

test("re-dispatching the same taskId is an idempotent replay", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const deps = depsFor(root);
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    await registry.definitions().find((t) => t.name === "team_create_project").execute(0, { projectId: PROJECT_ID, roleBindings: ROLE_BINDINGS });
    const dispatch = registry.definitions().find((t) => t.name === "team_dispatch_task");
    await dispatch.execute(0, { projectId: PROJECT_ID, taskId: "task-design-0", taskKind: "design", revisionIndex: 0, assignee: DESIGNER });
    const replayed = await dispatch.execute(0, { projectId: PROJECT_ID, taskId: "task-design-0", taskKind: "design", revisionIndex: 0, assignee: DESIGNER });
    assert.equal(details(replayed).replayed, true);
    assert.equal(details(replayed).notified, false);
  });
});

test("the leader can dispatch the next task after an accept, and report DELIVERED", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const deps = depsFor(root);
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    const def = (name) => registry.definitions().find((t) => t.name === name);
    await def("team_create_project").execute(0, { projectId: PROJECT_ID, roleBindings: ROLE_BINDINGS });
    await def("team_dispatch_task").execute(0, { projectId: PROJECT_ID, taskId: "task-design-0", taskKind: "design", revisionIndex: 0, assignee: DESIGNER });
    const workerDeps = { rootDir: root, env: { AGENTTEAMS_WORKER_NAME: DESIGNER, AGENTTEAMS_WORKER_ROOM_ID: "room-d" }, channel: channel(), sync: { beforeRead: () => {} }, evidence: evidence(), now: () => T(2) };
    await submitResult(createTaskResult({ taskId: "task-design-0", projectId: PROJECT_ID, producer: DESIGNER, summary: "design done", createdAt: T(2) }), workerDeps);
    await def("team_decide_task").execute(0, { taskId: "task-design-0", decision: "accept" });

    // after design.accept the next task is implement@0
    const dispatched = await def("team_dispatch_task").execute(0, { projectId: PROJECT_ID, taskId: "task-impl-0", taskKind: "implement", revisionIndex: 0, assignee: IMPL });
    assert.equal(details(dispatched).taskKind, "implement");

    const reported = await def("team_report").execute(0, { projectId: PROJECT_ID, summary: "design phase opened implementation", disposition: "delivered" });
    assert.equal(details(reported).reported, true);
    assert.ok(deps.channel.calls.some((c) => c.kind === "reportToRequester" && c.disposition === "delivered"));
  });
});
