// Leader pi tool registry (architecture §6): exposes the software-change-
// delivery coordination operations to the Tiangong Team Leader model as a
// closed, sequential tool surface. Every mutating operation is bound to the
// authenticated Leader identity and the immutable manifests; the deterministic
// TransitionPolicy gates task creation, and an accept must reference the
// current result. The model cannot authorize an illegal transition, rewrite a
// binding, or bypass the policy.
//
// These tools wrap TeamTaskPort operations, which already enforce Leader
// authorization (TeamContextPort), idempotent replay, and Evidence. Routing
// them through the unified Tiangong Gate wrapper is part of the Practice clean
// cut; for the leader roundtrip spike the team operations carry their own
// authorization, idempotency, and evidence.

import { Type } from "typebox";

import { TiangongToolRegistry } from "../tools/registry.mjs";
import { buildProjectBinding, buildTaskBinding } from "../playbook/resolver.mjs";
import { assertResultCurrent, assertTransitionAllowed } from "../playbook/transition-policy.mjs";
import { readProjectBinding, readTaskBinding, readTaskResult } from "../team/manifest-store.mjs";
import { projectChain } from "../team/project-chain.mjs";
import { loadWorkerIdentity } from "../team/team-context.mjs";
import {
  checkResult,
  createProject,
  createTaskDecision,
  dispatchTask,
  recordTaskDecision,
} from "../team/team-task-port.mjs";

const ID = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const DIGEST = Type.String({ pattern: "^[0-9a-f]{64}$" });
const TASK_KIND = Type.Union(
  [Type.Literal("design"), Type.Literal("implement"), Type.Literal("assess"), Type.Literal("release")],
  { description: "design | implement | assess | release" },
);
const DECISION = Type.Union(
  [Type.Literal("accept"), Type.Literal("revision"), Type.Literal("blocked")],
);
const DISPOSITION = Type.Union(
  [Type.Literal("delivered"), Type.Literal("failed_safe"), Type.Literal("recovery_required")],
);
const ROLE_BINDINGS_INPUT = Type.Object(
  {
    designer: ID,
    implementor: ID,
    assessor: ID,
    operator: ID,
  },
  { additionalProperties: false, description: "Professional role slots. team_leader is bound to the authenticated Leader, not model input." },
);

function nowISO(deps) {
  const value = deps?.now?.();
  return typeof value === "string" ? value : new Date().toISOString();
}

function leaderName(deps) {
  const name = deps?.env?.AGENTTEAMS_WORKER_NAME;
  if (typeof name !== "string" || name === "") {
    throw new Error("Leader identity (AGENTTEAMS_WORKER_NAME) is unavailable");
  }
  return name;
}

function ok(details) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

export function createLeaderToolRegistry({ playbook, deps }) {
  if (!playbook?.contentDigest) {
    throw new TypeError("createLeaderToolRegistry requires a loaded playbook");
  }
  if (!deps?.rootDir) {
    throw new TypeError("createLeaderToolRegistry requires team deps (rootDir)");
  }
  const registry = new TiangongToolRegistry();

  registry.register({
    name: "team_create_project",
    label: "Tiangong team create project",
    description:
      "Bind a new software-change-delivery project to the closed playbook and write its immutable roleBindings. The team_leader slot is bound to the authenticated Leader identity (not model input); only the four professional slots are provided. Only the team_leader may call this.",
    parameters: Type.Object({ projectId: ID, roleBindings: ROLE_BINDINGS_INPUT }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const identity = loadWorkerIdentity(deps);
      const project = buildProjectBinding({
        playbook,
        projectId: params.projectId,
        roleBindings: { ...params.roleBindings, team_leader: identity.workerName },
        createdAt: nowISO(deps),
      });
      const { projectBinding, manifestPath } = await createProject(project, deps);
      return ok({ projectId: projectBinding.projectId, manifestPath, playbookVersion: projectBinding.playbookVersion });
    },
  });

  registry.register({
    name: "team_dispatch_task",
    label: "Tiangong team dispatch task",
    description:
      "Create and dispatch the next playbook Task to its owning role. The deterministic TransitionPolicy validates the role and step order; re-dispatch of the same taskId is an idempotent replay that does not re-notify.",
    parameters: Type.Object(
      {
        projectId: ID,
        taskId: ID,
        taskKind: TASK_KIND,
        revisionIndex: Type.Integer({ minimum: 0 }),
        assignee: ID,
        completionContractDigest: Type.Optional(DIGEST),
        inputRefs: Type.Optional(Type.Array(ID, { maxItems: 32 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const project = await readProjectBinding(params.projectId, deps);
      const task = buildTaskBinding({
        playbook,
        taskId: params.taskId,
        projectId: params.projectId,
        taskKind: params.taskKind,
        revisionIndex: params.revisionIndex,
        assignee: params.assignee,
        completionContractDigest: params.completionContractDigest ?? playbook.contentDigest,
        inputRefs: params.inputRefs,
        createdAt: nowISO(deps),
      });
      const chain = await projectChain(params.projectId, deps);
      assertTransitionAllowed({
        projectBinding: project,
        taskBinding: task,
        chain,
        taskKindRoles: playbook.taskKindRoles,
        maxRevisionWaves: playbook.maxRevisionWaves,
      });
      const dispatched = await dispatchTask(task, deps);
      return ok({
        taskId: dispatched.taskBinding.taskId,
        taskKind: dispatched.taskBinding.taskKind,
        revisionIndex: dispatched.taskBinding.revisionIndex,
        assignee: dispatched.taskBinding.assignee,
        replayed: dispatched.replayed,
        notified: dispatched.notified,
      });
    },
  });

  registry.register({
    name: "team_check_result",
    label: "Tiangong team check result",
    description:
      "Inspect the submitted result and recorded decisions for a Task. Only the team_leader may call this.",
    parameters: Type.Object({ taskId: ID }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const checked = await checkResult(params.taskId, deps);
      return ok({
        taskId: checked.taskBinding.taskId,
        taskKind: checked.taskBinding.taskKind,
        revisionIndex: checked.taskBinding.revisionIndex,
        assignee: checked.taskBinding.assignee,
        resultDigest: checked.result?.contentDigest ?? null,
        decisions: checked.decisions.map((d) => ({ decisionId: d.decisionId, decision: d.decision })),
      });
    },
  });

  registry.register({
    name: "team_decide_task",
    label: "Tiangong team decide task",
    description:
      "Record the Leader decision (accept | revision | blocked) for a Task. An accept must reference the task's current submitted result; a prior-revision or stale result is rejected.",
    parameters: Type.Object(
      {
        taskId: ID,
        decision: DECISION,
        resultDigest: Type.Optional(DIGEST),
        note: Type.Optional(Type.String({ maxLength: 4096 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const task = await readTaskBinding(params.taskId, deps);
      let latestResultDigest;
      if (params.decision === "accept") {
        const result = await readTaskResult(params.taskId, deps);
        latestResultDigest = result.contentDigest;
      }
      const decision = createTaskDecision({
        decisionId: `dec-${params.taskId}-${params.decision}`,
        taskId: params.taskId,
        projectId: task.projectId,
        decision: params.decision,
        revisionIndex: task.revisionIndex,
        decidedBy: leaderName(deps),
        resultDigest: params.decision === "accept" ? latestResultDigest : params.resultDigest,
        note: params.note,
        createdAt: nowISO(deps),
      });
      if (params.decision === "accept") {
        assertResultCurrent({ decision, taskBinding: task, latestResultDigest });
      }
      const recorded = await recordTaskDecision(decision, deps);
      return ok({
        decisionId: decision.decisionId,
        decision: decision.decision,
        revisionIndex: decision.revisionIndex,
        replayed: recorded.replayed,
      });
    },
  });

  registry.register({
    name: "team_report",
    label: "Tiangong team report to requester",
    description:
      "Send the final Human-facing report for a project with its terminal disposition (delivered | failed_safe | recovery_required). A non-authoritative Concern cannot complete a project.",
    parameters: Type.Object(
      {
        projectId: ID,
        summary: Type.String({ minLength: 1, maxLength: 8192 }),
        disposition: DISPOSITION,
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await deps?.channel?.reportToRequester?.(params.projectId, params.summary, params.disposition);
      deps?.evidence?.record?.({
        type: "team.report.sent",
        projectId: params.projectId,
        disposition: params.disposition,
        at: nowISO(deps),
      });
      return ok({ projectId: params.projectId, disposition: params.disposition, reported: true });
    },
  });

  return registry;
}
