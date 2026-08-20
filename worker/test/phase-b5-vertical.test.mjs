import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeRouteFromEnvironment } from "../agent/runtime-routing.mjs";
import { RUNNER_BROKER_ENDPOINT_DIGEST } from "../agent/runner/preparation-client.mjs";
import { buildProjectBinding, buildTaskBinding, readPlaybookManifest } from "../agent/playbook/resolver.mjs";
import { createProject, createTaskDecision, dispatchTask, recordTaskDecision, submitResult } from "../agent/team/team-task-port.mjs";
import { createResultEnvelope } from "../agent/work/result-envelope.mjs";
import { WorkRunStore } from "../agent/work/work-run-store.mjs";

const LEADER = "b5-vertical-leader";
const DESIGNER = "b5-vertical-designer";
const IMPLEMENTOR = "b5-vertical-implementor";
const PROJECT_ID = "b5-vertical-project-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = (n) => `2026-08-16T01:0${n}:00Z`;

function channel() {
  const calls = [];
  return {
    calls,
    async assertTeamIdentity(role) { return { team: "b5-vertical-team", role }; },
    async assertTeamRoster() { return { roomId: "!b5vertical:example.test", roomIdDigest: "f".repeat(64), memberDigests: [] }; },
    async notifyAssignee(worker, taskId) { calls.push({ kind: "notifyAssignee", worker, taskId }); return { queued: true, delivered: false }; },
    async notifyLeader(taskId) { calls.push({ kind: "notifyLeader", taskId }); return { queued: true, delivered: false }; },
  };
}

function deps(root, worker, ch) {
  return {
    rootDir: root,
    env: {
      AGENTTEAMS_WORKER_NAME: worker,
      AGENTTEAMS_WORKER_ROLE: worker === LEADER ? "team_leader" : "worker",
      AGENTTEAMS_WORKER_ROOM_ID: `room-${worker}`,
      AGENTTEAMS_MATRIX_DOMAIN: "example.test",
    },
    channel: ch,
    evidence: { async append() {} },
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
    sync: { async beforeRead() {}, async afterWrite() {} },
  };
}

function resultFor({ task, role, claim, playbookDigest }) {
  const input = {
    taskId: task.taskId,
    projectId: task.projectId,
    taskKind: task.taskKind,
    revisionIndex: task.revisionIndex,
    producer: task.assignee,
    sourceRole: role,
    playbookDigest,
    taskBindingDigest: task.contentDigest,
    completionContractDigest: task.completionContractDigest,
    sourceProfileDigest: task.sourceProfileDigest,
    sourceSkillId: task.sourceSkillId,
    skillDigest: task.sourceSkillDigest,
    claim,
    evidenceRefs: [`toolresult-${task.taskId}`],
    createdAt: T(3),
  };
  if (task.taskKind === "implement") {
    input.changeRevisionRef = {
      producerTaskId: task.taskId,
      artifactPath: `artifacts/${task.taskId}.tar`,
      artifactDigest: "a".repeat(64),
      revision: task.revisionIndex,
    };
    input.artifactRefs = ["a".repeat(64)];
  }
  return createResultEnvelope(input);
}

test("B5 vertical contract keeps one authority while routing Leader and Developer through built-in", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-b5-vertical-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const playbook = readPlaybookManifest("software-change-delivery");
  const project = buildProjectBinding({
    playbook,
    projectId: PROJECT_ID,
    requester: "@b5-requester:example.test",
    roleBindings: { team_leader: LEADER, designer: DESIGNER, implementor: IMPLEMENTOR, assessor: "b5-vertical-assessor", operator: "b5-vertical-operator" },
    createdAt: T(0),
  });
  const leaderRoute = runtimeRouteFromEnvironment({
    AGENTTEAMS_WORKER_ROLE: "team_leader",
    TIANGONG_MEMBER_RUNTIME: "openclaw-built-in",
    TIANGONG_MEMBER_MODEL: "glm-5",
    AGENTTEAMS_MODEL: "glm-5",
    TIANGONG_CODEX_RUNTIME: "0",
    OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
  });
  const implementorRoute = runtimeRouteFromEnvironment({
    TIANGONG_MEMBER_RESPONSIBILITY: "developer",
    TIANGONG_MEMBER_RUNTIME: "openclaw-built-in",
    TIANGONG_MEMBER_MODEL: "glm-5",
    AGENTTEAMS_MODEL: "glm-5",
    TIANGONG_CODEX_RUNTIME: "0",
    OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
  });
  assert.equal(leaderRoute.runtime, "openclaw-built-in");
  assert.equal(implementorRoute.runtime, "openclaw-built-in");
  await createProject(project, deps(root, LEADER, channel()));

  const design = buildTaskBinding({
    playbook, taskId: "b5-vertical-design", projectId: PROJECT_ID, taskKind: "design", revisionIndex: 0,
    assignee: DESIGNER, objective: "Define the bounded change.", completionContractDigest: playbook.completionSchemaDigest,
    createdAt: T(1),
  });
  const leaderChannel = channel();
  await dispatchTask(design, deps(root, LEADER, leaderChannel));
  const designerStore = new WorkRunStore({ directory: join(root, "designer"), ownerId: "owner-designer" });
  await designerStore.open({
    runId: "run-b5-vertical-design", taskId: design.taskId, role: "designer", skillId: design.sourceSkillId,
    skillDigest: design.sourceSkillDigest, objective: design.objective, scope: "design", completionContractDigest: design.completionContractDigest,
    createdAt: T(1),
  });
  await designerStore.transition("run-b5-vertical-design", "executing");
  await designerStore.transition("run-b5-vertical-design", "verifying");
  await designerStore.transition("run-b5-vertical-design", "finalized");
  const designResult = resultFor({ task: design, role: "designer", playbookDigest: project.playbookDigest, claim: "bounded design ready" });
  await submitResult(designResult, deps(root, DESIGNER, channel()));
  await recordTaskDecision(createTaskDecision({
    kind: "tiangong.task-decision", schemaVersion: 1, taskId: design.taskId, projectId: PROJECT_ID,
    playbookDigest: project.playbookDigest, decision: "accept", revisionIndex: 0,
    decidedBy: LEADER, resultDigest: designResult.contentDigest, createdAt: T(4),
  }), deps(root, LEADER, channel()));

  const implement = buildTaskBinding({
    playbook, taskId: "b5-vertical-implement", projectId: PROJECT_ID, taskKind: "implement", revisionIndex: 0,
    assignee: IMPLEMENTOR, objective: "Make the exact local edit and report the ToolResult.", completionContractDigest: playbook.completionSchemaDigest,
    inputRefs: [design.taskId], createdAt: T(2),
  });
  await dispatchTask(implement, deps(root, LEADER, channel()));
  const first = new WorkRunStore({ directory: join(root, "implementor"), ownerId: "owner-implementor-before-restart" });
  await first.open({
    runId: "run-b5-vertical-implement", taskId: implement.taskId, role: "implementor", skillId: implement.sourceSkillId,
    skillDigest: implement.sourceSkillDigest, objective: implement.objective, scope: "scratch/revision", completionContractDigest: implement.completionContractDigest,
    createdAt: T(2),
  });
  await first.transition("run-b5-vertical-implement", "executing");
  await first.release("run-b5-vertical-implement");
  const restarted = new WorkRunStore({
    directory: join(root, "implementor"), ownerId: "owner-implementor-after-restart",
    authorizeRecovery: async ({ runId, action }) => assert.deepEqual({ runId, action }, { runId: "run-b5-vertical-implement", action: "resume" }),
  });
  await assert.rejects(() => restarted.claim("run-b5-vertical-implement"), (error) => error.code === "TIANGONG_WORK_RUN_RECOVERY_REQUIRED");
  await restarted.reconcile("run-b5-vertical-implement", { action: "resume", reason: "WORKER_RESTART" });
  await restarted.transition("run-b5-vertical-implement", "verifying");
  await restarted.transition("run-b5-vertical-implement", "finalized");
  const implementResult = resultFor({ task: implement, role: "implementor", playbookDigest: project.playbookDigest, claim: "local edit and test ToolResult captured" });
  await submitResult(implementResult, deps(root, IMPLEMENTOR, channel()));

  assert.equal((await restarted.read("run-b5-vertical-implement")).events.at(-1).toPhase, "finalized");
  assert.equal(implementResult.evidenceRefs[0], "toolresult-b5-vertical-implement");
});
