import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TurnGateState } from "../agent/gates/turn-state.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import { TeamCoordinationGate } from "../agent/team/tool-wrapper.mjs";
import { createProject, dispatchTask } from "../agent/team/team-task-port.mjs";
import { createMemberToolRegistry } from "../agent/work/member-tools.mjs";

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
    gate: new TeamCoordinationGate(),
    getInvocation: () => ({
      sessionId: `session-${worker}`,
      turnId: `turn-${worker}`,
      actor: { id: `@leader:example.test` },
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
function designTask(boundProject, id) {
  return createTaskBinding({
    taskId: id,
    projectId: boundProject.projectId,
    playbookStepId: "software-change-delivery-transition-v1:design",
    taskKind: "design",
    revisionIndex: 0,
    assignee: DESIGNER,
    completionContractDigest: CONTRACT,
    sourceProfileDigest: PROFILE,
    sourceSkillId: "designer-v1",
    sourceSkillDigest: SKILL,
    inputRefs: [],
    createdAt: T(0),
  });
}

test("createMemberToolRegistry exposes only wrapped resolve + submit", () => {
  const registry = createMemberToolRegistry({ deps: depsFor(DESIGNER, "/x") });
  assert.deepEqual(registry.names(), ["team_resolve_task", "team_submit_result"]);
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
