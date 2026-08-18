// Leader OpenClaw tool registry (architecture §6): exposes the software-change-
// delivery coordination operations to the Tiangong Team Leader model as a
// closed, sequential tool surface. Every mutating operation is bound to the
// authenticated Leader identity and the immutable manifests; the deterministic
// TransitionPolicy gates task creation, and an accept must reference the
// current result. The model cannot authorize an illegal transition, rewrite a
// binding, or bypass the policy.
//
// These tools wrap TeamTaskPort operations, which already enforce Leader
// authorization (TeamContextPort), idempotent replay, and Evidence. Routing
// them through the unified Tiangong Gate wrapper keeps the coordination
// operations evidence-backed; the team operations also carry their own
// authorization and idempotency.

import { Type } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { TiangongToolRegistry } from "../tools/registry.mjs";
import { buildProjectBinding, buildTaskBinding } from "../playbook/resolver.mjs";
import { assertDecisionResultCompatible, assertTransitionAllowed } from "../playbook/transition-policy.mjs";
import {
  readProjectBinding,
  readProjectReport,
  readTaskBinding,
  readTaskDecisions,
  readTaskResult,
  writeProjectReport,
} from "../team/manifest-store.mjs";
import { createProjectReport } from "../team/manifest.mjs";
import { projectChain } from "../team/project-chain.mjs";
import { loadWorkerIdentity } from "../team/team-context.mjs";
import { wrapTeamTool } from "../team/tool-wrapper.mjs";
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
  [Type.Literal("DELIVERED"), Type.Literal("FAILED_SAFE"), Type.Literal("RECOVERY_REQUIRED")],
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
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx, invocation) {
      const identity = loadWorkerIdentity(deps);
      const project = buildProjectBinding({
        playbook,
        projectId: params.projectId,
        requester: invocation?.actor?.id,
        roleBindings: { ...params.roleBindings, team_leader: identity.workerName },
        createdAt: nowISO(deps),
      });
      const { projectBinding, replayed } = await createProject(project, deps);
      return ok({
        projectId: projectBinding.projectId,
        bindingDigest: projectBinding.contentDigest,
        playbookVersion: projectBinding.playbookVersion,
        replayed,
      });
    },
  });

  registry.register({
    name: "team_dispatch_task",
    label: "Tiangong team dispatch task",
    description:
      "Create and dispatch the next playbook Task with a bounded immutable objective to its owning role. The deterministic TransitionPolicy validates the role and step order; re-dispatch of the same taskId is an idempotent replay that does not re-notify.",
    parameters: Type.Object(
      {
        projectId: ID,
        taskId: ID,
        taskKind: TASK_KIND,
        revisionIndex: Type.Integer({ minimum: 0 }),
        assignee: ID,
        objective: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\r\\n]+$" }),
        completionContractDigest: Type.Optional(DIGEST),
        inputRefs: Type.Optional(Type.Array(ID, { maxItems: 32 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await deps.sync.beforeRead();
      const project = await readProjectBinding(params.projectId, deps);
      let task = buildTaskBinding({
        playbook,
        taskId: params.taskId,
        projectId: params.projectId,
        taskKind: params.taskKind,
        revisionIndex: params.revisionIndex,
        assignee: params.assignee,
        objective: params.objective,
        completionContractDigest: params.completionContractDigest ?? playbook.completionSchemaDigest,
        inputRefs: params.inputRefs,
        createdAt: nowISO(deps),
      });
      let existingTask;
      try {
        existingTask = await readTaskBinding(params.taskId, deps);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (existingTask) {
        // createdAt is part of the immutable Task binding but is not a model
        // parameter. Rebuild the candidate with the stored timestamp so an
        // exact replay survives a fresh Leader process.
        task = buildTaskBinding({
          playbook,
          taskId: params.taskId,
          projectId: params.projectId,
          taskKind: params.taskKind,
          revisionIndex: params.revisionIndex,
          assignee: params.assignee,
          objective: params.objective,
          completionContractDigest: params.completionContractDigest ?? playbook.completionSchemaDigest,
          inputRefs: params.inputRefs,
          createdAt: existingTask.createdAt,
        });
      } else {
        const chain = await projectChain(params.projectId, deps);
        assertTransitionAllowed({
          projectBinding: project,
          taskBinding: task,
          chain,
          taskKindRoles: playbook.taskKindRoles,
          maxRevisionWaves: playbook.maxRevisionWaves,
        });
      }
      // An exact Task replay must remain available after a Leader restart even
      // while the durable Task is still awaiting its Worker Result. The
      // immutable binding check in dispatchTask rejects changed parameters;
      // requiring a complete projectChain here would incorrectly reject that
      // safe replay because projectChain intentionally rejects undecided Tasks.
      const dispatched = await dispatchTask(task, deps);
      return ok({
        taskId: dispatched.taskBinding.taskId,
        taskKind: dispatched.taskBinding.taskKind,
        revisionIndex: dispatched.taskBinding.revisionIndex,
        assignee: dispatched.taskBinding.assignee,
        replayed: dispatched.replayed,
        notified: dispatched.notified,
        notificationQueued: dispatched.notificationQueued,
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
        objective: checked.taskBinding.objective,
        resultDigest: checked.result?.contentDigest ?? null,
        result: checked.result ? {
          claim: checked.result.claim ?? null,
          blocker: checked.result.blocker ?? null,
          artifactRefs: checked.result.artifactRefs,
          evidenceRefs: checked.result.evidenceRefs,
          changeRevisionRef: checked.result.changeRevisionRef ?? null,
          releaseOutcome: checked.result.releaseOutcome ?? null,
          revisionRequest: checked.result.revisionRequest ?? null,
        } : null,
        decisions: checked.decisions.map((d) => ({ decisionId: d.decisionId, decision: d.decision })),
      });
    },
  });

  registry.register({
    name: "team_decide_task",
    label: "Tiangong team decide task",
    description:
      "Record the Leader decision (accept | revision | blocked) for a Task. An accept must reference the task's current submitted result; a prior-revision or stale result is rejected. After a blocked decision, immediately call team_report with RECOVERY_REQUIRED in this same turn.",
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
      let latestResult;
      try {
        latestResult = await readTaskResult(params.taskId, deps);
      } catch (error) {
        if (error?.code !== "ENOENT" || params.decision !== "blocked") throw error;
      }
      const project = await readProjectBinding(task.projectId, deps);
      const existingDecisions = await readTaskDecisions(params.taskId, deps);
      if (existingDecisions.length > 1) throw new Error("Task has conflicting terminal decisions");
      const existingDecision = existingDecisions[0];
      const decision = createTaskDecision({
        taskId: params.taskId,
        projectId: task.projectId,
        playbookDigest: project.playbookDigest,
        decision: params.decision,
        revisionIndex: task.revisionIndex,
        decidedBy: leaderName(deps),
        resultDigest: latestResult?.contentDigest ?? params.resultDigest,
        note: params.note === undefined ? existingDecision?.note : params.note,
        // createdAt is part of the immutable transition record but is not a
        // model parameter. Reuse it for an exact decision replay after a
        // Leader restart.
        createdAt: existingDecision?.createdAt ?? nowISO(deps),
      });
      assertDecisionResultCompatible({ decision, taskBinding: task, result: latestResult });
      const recorded = await recordTaskDecision(decision, deps);
      const terminalDisposition = decision.decision === "blocked"
        ? "RECOVERY_REQUIRED"
        : (task.taskKind === "release" && decision.decision === "accept"
          ? await deps.getProjectDisposition?.(task.projectId)
          : null);
      return ok({
        decisionId: decision.decisionId,
        decision: decision.decision,
        revisionIndex: decision.revisionIndex,
        replayed: recorded.replayed,
        requiredNextTool: terminalDisposition ? "team_report" : null,
        terminalDisposition,
      });
    },
  });

  registry.register({
    name: "team_report",
    label: "Tiangong team report to requester",
    description:
      "Deliver a final Human-facing report only after a code-owned disposition store proves the exact terminal disposition. A Concern or model claim cannot complete a project.",
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
      if (typeof deps.getProjectDisposition !== "function") {
        throw new Error("Authoritative project disposition is unavailable");
      }
      const authoritative = await deps.getProjectDisposition(params.projectId);
      if (authoritative !== params.disposition) {
        throw new Error("Requested report disposition does not match authoritative machine state");
      }
      if (typeof deps.channel.waitForTeamIdentity === "function") {
        await deps.channel.waitForTeamIdentity("team_leader");
      } else {
        await deps.channel.assertTeamIdentity("team_leader");
      }
      await deps.sync.beforeRead();
      const project = await readProjectBinding(params.projectId, deps);
      const identity = loadWorkerIdentity(deps);
      if (project.roleBindings.team_leader !== identity.workerName) {
        throw new Error("Authenticated Worker is not the bound Project Leader");
      }
      const summaryDigest = sha256(params.summary);
      const dispositionDigest = sha256(canonicalJson({
        projectId: params.projectId,
        disposition: params.disposition,
      }));
      const reportFields = {
        projectId: params.projectId,
        requester: project.requester,
        reportedBy: identity.workerName,
        disposition: params.disposition,
        dispositionDigest,
        summaryDigest,
      };
      let report;
      try {
        report = await readProjectReport(params.projectId, deps);
        for (const [field, expected] of Object.entries(reportFields)) {
          if (report[field] !== expected) throw new Error("Project already has a different terminal report");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        report = createProjectReport({ ...reportFields, createdAt: nowISO(deps) });
        try {
          await writeProjectReport(report, deps);
        } catch (writeError) {
          if (writeError?.code !== "EEXIST") throw writeError;
          report = await readProjectReport(params.projectId, deps);
          for (const [field, expected] of Object.entries(reportFields)) {
            if (report[field] !== expected) throw new Error("Project already has a different terminal report");
          }
        }
      }
      await deps.sync.afterWrite({ projectIds: [params.projectId] });
      const delivery = await deps.channel.reportRequester(
        project.requester,
        params.projectId,
        params.disposition,
        report.contentDigest,
        params.summary,
      );
      await deps.evidence.append({
        type: "team.report.delivered",
        projectId: params.projectId,
        disposition: params.disposition,
        summaryDigest,
        delivered: delivery?.delivered === true,
        at: nowISO(deps),
      });
      return ok({
        projectId: params.projectId,
        disposition: params.disposition,
        reported: delivery?.delivered === true,
        queued: delivery?.queued === true,
      });
    },
  });

  if (deps.coordinationStore && typeof deps.coordinationStore.getWork === "function") {
    registry.register({
      name: "team_read_coordination_work",
      label: "Tiangong read durable coordination Work",
      description:
        "Read the authoritative PG Coordination Work referenced by a Leader resume wake. This is read-only; use it before deciding the next bounded coordination action. The returned projection contains no credentials or raw Matrix payload.",
      parameters: Type.Object({ workId: ID }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const work = await deps.coordinationStore.getWork(params.workId);
        if (!work) throw new Error("Coordination Work was not found");
        return ok({
          work: {
            workId: work.work?.workId ?? params.workId,
            teamId: work.work?.teamId ?? null,
            routeId: work.work?.routeId ?? null,
            status: work.status ?? null,
            epoch: Number.isSafeInteger(work.epoch) ? work.epoch : null,
            leaderSessionId: work.work?.leaderSessionId ?? null,
            currentWorkSpec: work.currentWorkSpec ? {
              revision: Number.isSafeInteger(work.currentWorkSpec.revision) ? work.currentWorkSpec.revision : null,
              objective: typeof work.currentWorkSpec.objective === "string" ? work.currentWorkSpec.objective.slice(0, 512) : null,
              scope: typeof work.currentWorkSpec.scope === "string" ? work.currentWorkSpec.scope.slice(0, 512) : null,
              completionContract: typeof work.currentWorkSpec.completionContract === "string" ? work.currentWorkSpec.completionContract.slice(0, 512) : null,
            } : null,
            timeline: Array.isArray(work.timeline) ? work.timeline.slice(-32).map((entry) => ({
              sequence: Number.isSafeInteger(entry?.sequence) ? entry.sequence : null,
              type: typeof entry?.type === "string" ? entry.type.slice(0, 96) : null,
              at: typeof entry?.at === "string" ? entry.at.slice(0, 64) : null,
              requestId: typeof entry?.requestId === "string" ? entry.requestId.slice(0, 160) : null,
            })) : [],
          },
        });
      },
    });
  }

  const wrapped = new TiangongToolRegistry();
  for (const definition of registry.definitions()) {
    wrapped.register(wrapTeamTool(definition, {
      gate: deps.gate,
      evidence: deps.evidence,
      getInvocation: deps.getInvocation,
      category: ["team_check_result", "team_read_coordination_work"].includes(definition.name) ? "read-only" : "state-transition",
    }));
  }
  return wrapped;
}
