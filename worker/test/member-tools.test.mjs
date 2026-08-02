import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import { createProject, dispatchTask } from "../agent/team/team-task-port.mjs";
import { createMemberToolRegistry } from "../agent/work/member-tools.mjs";

const LEADER = "tiangong-leader";
const DESIGNER = "tiangong-designer";
const CONTRACT = "c".repeat(64);
const T = (n) => `2026-08-01T12:0${n}:00Z`;

function channel() {
  const calls = [];
  return {
    calls,
    notifyAssignee: (w, t) => calls.push({ kind: "notifyAssignee", worker: w, taskId: t }),
    notifyLeader: (t) => calls.push({ kind: "notifyLeader", taskId: t }),
    reportToRequester: () => {},
  };
}
function evidence() {
  const events = [];
  return { events, append: (e) => events.push(e) };
}
function depsFor(worker, root) {
  return { rootDir: root, env: { AGENTTEAMS_WORKER_NAME: worker, AGENTTEAMS_WORKER_ROOM_ID: `room-${worker}` }, channel: channel(), sync: { beforeRead: () => {} }, evidence: evidence(), now: () => T(1) };
}
function details(result) {
  return JSON.parse(result.content[0].text);
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-member-tools-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("createMemberToolRegistry exposes resolve + submit", () => {
  const registry = createMemberToolRegistry({ deps: { rootDir: "/x" } });
  assert.deepEqual(registry.names(), ["team_resolve_task", "team_submit_result"]);
});

test("an assignee resolves its task and submits a result that notifies the leader", async () => {
  await withRoot(async (root) => {
    // leader sets up project + design task assigned to the designer
    const project = createProjectBinding({
      projectId: "proj-m-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      playbookId: "software-change-delivery", playbookVersion: "1.0.0",
      playbookDigest: "d".repeat(64),
      roleBindings: { team_leader: LEADER, designer: DESIGNER, implementor: "i", assessor: "a", operator: "o" },
      createdAt: T(0),
    });
    await createProject(project, depsFor(LEADER, root));
    const task = createTaskBinding({
      taskId: "task-design-m", projectId: project.projectId,
      playbookStepId: "software-change-delivery-transition-v1:design",
      taskKind: "design", revisionIndex: 0, assignee: DESIGNER,
      completionContractDigest: CONTRACT, inputRefs: [], createdAt: T(0),
    });
    await dispatchTask(task, depsFor(LEADER, root));

    const registry = createMemberToolRegistry({ deps: depsFor(DESIGNER, root) });
    const resolved = await registry.definitions().find((t) => t.name === "team_resolve_task").execute(0, { taskId: "task-design-m" });
    assert.equal(details(resolved).assignee ?? DESIGNER, DESIGNER);
    assert.equal(details(resolved).taskKind, "design");

    const designerDeps = depsFor(DESIGNER, root);
    const submit = createMemberToolRegistry({ deps: designerDeps }).definitions().find((t) => t.name === "team_submit_result");
    const out = await submit.execute(0, { taskId: "task-design-m", summary: "design complete: approach X" });
    assert.equal(details(out).producer, DESIGNER);
    assert.equal(details(out).notified, true);
    assert.match(details(out).resultDigest, /^[0-9a-f]{64}$/);
    assert.ok(designerDeps.channel.calls.some((c) => c.kind === "notifyLeader"));
  });
});

test("a non-assignee cannot resolve or submit", async () => {
  await withRoot(async (root) => {
    const project = createProjectBinding({
      projectId: "proj-m2-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      playbookId: "software-change-delivery", playbookVersion: "1.0.0",
      playbookDigest: "d".repeat(64),
      roleBindings: { team_leader: LEADER, designer: DESIGNER, implementor: "i", assessor: "a", operator: "o" },
      createdAt: T(0),
    });
    await createProject(project, depsFor(LEADER, root));
    await dispatchTask(createTaskBinding({
      taskId: "task-design-m2", projectId: project.projectId,
      playbookStepId: "s", taskKind: "design", revisionIndex: 0, assignee: DESIGNER,
      completionContractDigest: CONTRACT, inputRefs: [], createdAt: T(0),
    }), depsFor(LEADER, root));

    const intruder = createMemberToolRegistry({ deps: depsFor("tiangong-implementor", root) });
    await assert.rejects(
      () => intruder.definitions().find((t) => t.name === "team_resolve_task").execute(0, { taskId: "task-design-m2" }),
      /not the assignee/u,
    );
    await assert.rejects(
      () => intruder.definitions().find((t) => t.name === "team_submit_result").execute(0, { taskId: "task-design-m2", summary: "forged" }),
      /not the assignee/u,
    );
  });
});

test("re-submitting a result is an idempotent replay that does not re-notify", async () => {
  await withRoot(async (root) => {
    const project = createProjectBinding({
      projectId: "proj-m3-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      playbookId: "software-change-delivery", playbookVersion: "1.0.0",
      playbookDigest: "d".repeat(64),
      roleBindings: { team_leader: LEADER, designer: DESIGNER, implementor: "i", assessor: "a", operator: "o" },
      createdAt: T(0),
    });
    await createProject(project, depsFor(LEADER, root));
    await dispatchTask(createTaskBinding({
      taskId: "task-design-m3", projectId: project.projectId,
      playbookStepId: "s", taskKind: "design", revisionIndex: 0, assignee: DESIGNER,
      completionContractDigest: CONTRACT, inputRefs: [], createdAt: T(0),
    }), depsFor(LEADER, root));
    const submit = createMemberToolRegistry({ deps: depsFor(DESIGNER, root) }).definitions().find((t) => t.name === "team_submit_result");
    await submit.execute(0, { taskId: "task-design-m3", summary: "first" });
    const replay = await submit.execute(0, { taskId: "task-design-m3", summary: "first" });
    assert.equal(details(replay).replayed, true);
    assert.equal(details(replay).notified, false);
  });
});
