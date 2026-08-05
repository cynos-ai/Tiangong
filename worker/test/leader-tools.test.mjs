import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TurnGateState } from "../agent/gates/turn-state.mjs";
import { readPlaybookManifest } from "../agent/playbook/resolver.mjs";
import { projectDisposition } from "../agent/team/project-chain.mjs";
import { TeamCoordinationGate } from "../agent/team/tool-wrapper.mjs";
import { submitResult } from "../agent/team/team-task-port.mjs";
import { createLeaderToolRegistry } from "../agent/work/leader-tools.mjs";
import { createResultEnvelope } from "../agent/work/result-envelope.mjs";

const LEADER = "tiangong-leader";
const DESIGNER = "tiangong-designer";
const IMPL = "tiangong-implementor";
const ROLE_BINDINGS_INPUT = {
  designer: DESIGNER,
  implementor: IMPL,
  assessor: "tiangong-assessor",
  operator: "tiangong-operator",
};
const PROJECT_ID = "proj-leader-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
    async reportRequester(requester, projectId, disposition, reportDigest, summary) {
      calls.push({ kind: "reportRequester", requester, projectId, disposition, reportDigest, summary });
      return { queued: true, delivered: false };
    },
  };
}
function evidence() {
  const events = [];
  return { events, async append(event) { events.push(event); } };
}
function depsFor(root, worker = LEADER, extra = {}) {
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
      actor: { id: "@admin:example.test" },
      turnState: new TurnGateState(),
      resumed: false,
    }),
    now: () => T(1),
    ...extra,
  };
}
function details(result) { return JSON.parse(result.content[0].text); }
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-leader-tools-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function definition(registry, name) {
  return registry.definitions().find((tool) => tool.name === name);
}
async function createAndDispatch(registry, taskId = "task-design-0") {
  await definition(registry, "team_create_project").execute("create", {
    projectId: PROJECT_ID,
    roleBindings: ROLE_BINDINGS_INPUT,
  });
  return definition(registry, "team_dispatch_task").execute("dispatch", {
    projectId: PROJECT_ID,
    taskId,
    taskKind: "design",
    revisionIndex: 0,
    assignee: DESIGNER,
    objective: "Design the bounded change.",
  });
}
function designResult(pb, taskId, taskBindingDigest) {
  return createResultEnvelope({
    taskId,
    projectId: PROJECT_ID,
    producer: DESIGNER,
    taskKind: "design",
    revisionIndex: 0,
    sourceRole: "designer",
    playbookDigest: pb.contentDigest,
    taskBindingDigest,
    completionContractDigest: pb.completionSchemaDigest,
    sourceProfileDigest: "232ef7080049e1fae32926caa5bb23c9b758cfc09f7afe83bd3b489e71e5c6b1",
    sourceSkillId: "designer-design-delivery-v1",
    skillDigest: "42b3946603971a7ea5d5a6d0fd596698441d06ac149c311c9fe5b4d5832bc477",
    claim: "design done",
    evidenceRefs: ["evidence-design"],
    createdAt: T(2),
  });
}

test("createLeaderToolRegistry requires loaded playbook and wrapped team dependencies", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  assert.throws(() => createLeaderToolRegistry({ deps: { rootDir: "/x" } }), /loaded playbook/u);
  assert.throws(() => createLeaderToolRegistry({ playbook: pb, deps: { rootDir: "/x" } }), /Gate, Evidence/u);
});

test("the Leader exposes only the wrapped closed coordination surface", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  const registry = createLeaderToolRegistry({ playbook: pb, deps: depsFor("/x") });
  assert.deepEqual(registry.names(), [
    "team_create_project",
    "team_dispatch_task",
    "team_check_result",
    "team_decide_task",
    "team_report",
  ]);
});

test("Leader creates an AgentTeams Project and dispatches only one active design Task", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const deps = depsFor(root);
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    const dispatched = await createAndDispatch(registry);
    assert.equal(details(dispatched).notified, false);
    assert.equal(details(dispatched).notificationQueued, true);
    assert.ok(deps.evidence.events.some((event) => event.type === "gate.decided"));
    const project = JSON.parse(await (await import("node:fs/promises")).readFile(
      join(root, "projects", PROJECT_ID, "tiangong", "project-binding.json"), "utf8",
    ));
    assert.equal(project.requester, "@admin:example.test");
    const task = JSON.parse(await (await import("node:fs/promises")).readFile(
      join(root, "tasks", "task-design-0", "tiangong", "task-binding.json"), "utf8",
    ));
    assert.equal(task.objective, "Design the bounded change.");

    await assert.rejects(
      () => definition(registry, "team_dispatch_task").execute("dispatch-2", {
        projectId: PROJECT_ID,
        taskId: "task-design-duplicate",
        taskKind: "design",
        revisionIndex: 0,
        assignee: DESIGNER,
        objective: "Design a duplicate change.",
      }),
      /undecided Task/u,
    );
  });
});

test("accept binds the current schema-valid ResultEnvelope", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const deps = depsFor(root);
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    await createAndDispatch(registry);
    await assert.rejects(
      () => definition(registry, "team_decide_task").execute("accept-empty", {
        taskId: "task-design-0",
        decision: "accept",
      }),
      /No task result/u,
    );

    const taskBinding = JSON.parse(await (await import("node:fs/promises")).readFile(
      join(root, "tasks", "task-design-0", "tiangong", "task-binding.json"), "utf8",
    ));
    const result = designResult(pb, "task-design-0", taskBinding.contentDigest);
    await submitResult(result, depsFor(root, DESIGNER));
    const accepted = await definition(registry, "team_decide_task").execute("accept", {
      taskId: "task-design-0",
      decision: "accept",
    });
    assert.equal(details(accepted).decision, "accept");
  });
});

test("a blocked immutable task chain authorizes a RECOVERY_REQUIRED report", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    let deps;
    deps = depsFor(root, LEADER, {
      getProjectDisposition: (projectId) => projectDisposition(projectId, deps),
    });
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    await createAndDispatch(registry);
    const taskBinding = JSON.parse(await (await import("node:fs/promises")).readFile(
      join(root, "tasks", "task-design-0", "tiangong", "task-binding.json"), "utf8",
    ));
    const blocker = createResultEnvelope({
      taskId: taskBinding.taskId,
      projectId: PROJECT_ID,
      producer: DESIGNER,
      taskKind: "design",
      revisionIndex: 0,
      sourceRole: "designer",
      playbookDigest: pb.contentDigest,
      taskBindingDigest: taskBinding.contentDigest,
      completionContractDigest: pb.completionSchemaDigest,
      sourceProfileDigest: taskBinding.sourceProfileDigest,
      sourceSkillId: taskBinding.sourceSkillId,
      skillDigest: taskBinding.sourceSkillDigest,
      blocker: "required design evidence is unavailable",
      createdAt: T(2),
    });
    await submitResult(blocker, depsFor(root, DESIGNER));
    const blocked = await definition(registry, "team_decide_task").execute("block", {
      taskId: taskBinding.taskId,
      decision: "blocked",
    });
    assert.equal(details(blocked).requiredNextTool, "team_report");
    assert.equal(details(blocked).terminalDisposition, "RECOVERY_REQUIRED");
    const reported = await definition(registry, "team_report").execute("report-recovery", {
      projectId: PROJECT_ID,
      summary: "The request is blocked and requires recovery.",
      disposition: "RECOVERY_REQUIRED",
    });
    assert.equal(details(reported).queued, true);
    const stored = JSON.parse(await (await import("node:fs/promises")).readFile(
      join(root, "projects", PROJECT_ID, "tiangong", "terminal-report.json"), "utf8",
    ));
    assert.equal(stored.disposition, "RECOVERY_REQUIRED");
    assert.equal(stored.reportedBy, LEADER);
  });
});

test("terminal reporting fails closed without exact authoritative disposition", async () => {
  await withRoot(async (root) => {
    const pb = readPlaybookManifest("software-change-delivery");
    const blocked = createLeaderToolRegistry({ playbook: pb, deps: depsFor(root) });
    await assert.rejects(
      () => definition(blocked, "team_report").execute("report", {
        projectId: PROJECT_ID,
        summary: "premature",
        disposition: "DELIVERED",
      }),
      /disposition is unavailable/u,
    );

    const deps = depsFor(root, LEADER, { getProjectDisposition: async () => "FAILED_SAFE" });
    const registry = createLeaderToolRegistry({ playbook: pb, deps });
    await definition(registry, "team_create_project").execute("create-report-project", {
      projectId: PROJECT_ID,
      roleBindings: ROLE_BINDINGS_INPUT,
    });
    await assert.rejects(
      () => definition(registry, "team_report").execute("report-wrong", {
        projectId: PROJECT_ID,
        summary: "wrong",
        disposition: "DELIVERED",
      }),
      /does not match authoritative/u,
    );
    const queued = await definition(registry, "team_report").execute("report-safe", {
      projectId: PROJECT_ID,
      summary: "new change was not delivered; previous digest restored",
      disposition: "FAILED_SAFE",
    });
    assert.equal(details(queued).reported, false);
    assert.equal(details(queued).queued, true);
    const replay = await definition(registry, "team_report").execute("report-safe-replay", {
      projectId: PROJECT_ID,
      summary: "new change was not delivered; previous digest restored",
      disposition: "FAILED_SAFE",
    });
    assert.equal(details(replay).queued, true);
    await assert.rejects(
      () => definition(registry, "team_report").execute("report-conflict", {
        projectId: PROJECT_ID,
        summary: "different terminal prose",
        disposition: "FAILED_SAFE",
      }),
      /different terminal report/u,
    );
  });
});
