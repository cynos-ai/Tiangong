import { Type } from "typebox";

import { sha256 } from "../canonical-json.mjs";
import { createContentRef, createTaskSpec, createWorkSpec } from "./coordination-store.mjs";
import { createRemoteCoordinationStore } from "./coordination-control-client.mjs";

const LEADER_ROLE = "leader";
const ID = Type.String({ pattern: "^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$" });
const EVENT_ID = Type.String({ pattern: "^\\$[^\\s]{1,255}$" });
const CONTENT_REF = Type.Union([
  Type.Object({ repositoryId: ID, commitSha: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ adapter: ID, ref: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
]);
const TOOL_NAMES = Object.freeze([
  "tiangong_list_pending_messages", "tiangong_route_message", "tiangong_correct_message_association",
  "tiangong_read_work", "tiangong_rename_work", "tiangong_set_work_spec", "tiangong_publish_plan",
  "tiangong_create_task", "tiangong_cancel_task", "tiangong_complete_work", "tiangong_stop_work",
]);

function required(value, name) { if (typeof value !== "string" || value === "") throw new Error(`${name} is required`); return value; }
function ok(details) { return { content: [{ type: "text", text: JSON.stringify(details) }], details }; }
function requestId(action, toolCallId, params) { return `${action}-${sha256({ toolCallId, params }).slice(0, 48)}`; }
function now() { return new Date().toISOString(); }

export function isLeaderEnvironment(env = process.env) { return env?.TIANGONG_ROLE_ID === LEADER_ROLE || env?.AGENTTEAMS_WORKER_ROLE === "team_leader"; }

function definitions(store, memberId) {
  return [
    {
      name: "tiangong_list_pending_messages", label: "List messages awaiting Leader routing",
      description: "Read bounded Matrix event references awaiting semantic routing. Message bodies remain in Matrix.",
      parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential",
      async execute() { return ok(await store.listMessageAdmissions({ status: "pending" })); },
    },
    {
      name: "tiangong_route_message", label: "Route one Matrix message",
      description: "Associate a pending Human Matrix event with an open Work, or create a new requirement-pending Work. UI selection is never an input.",
      parameters: Type.Object({ eventId: EVENT_ID, targetWorkId: Type.Optional(ID), title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), expectedEpoch: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) {
        if (params.targetWorkId && !Number.isSafeInteger(params.expectedEpoch)) throw new Error("Routing to an existing Work requires expectedEpoch");
        if (!params.targetWorkId && !params.title) throw new Error("Creating a Work requires a bounded title");
        return ok(await store.routeMessage({ ...params, actorId: memberId, requestId: requestId("route-message", toolCallId, params) }));
      },
    },
    {
      name: "tiangong_correct_message_association", label: "Correct a mistaken message association",
      description: "Correct the current Work association without deleting history or moving Tasks, Results, ToolResults, or Operations.",
      parameters: Type.Object({ eventId: EVENT_ID, correctionEventId: EVENT_ID, targetWorkId: Type.Optional(ID), title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), expectedSourceEpoch: Type.Integer({ minimum: 0 }), expectedTargetEpoch: Type.Optional(Type.Integer({ minimum: 0 })), stopSourceIfEmpty: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) {
        if (params.targetWorkId && !Number.isSafeInteger(params.expectedTargetEpoch)) throw new Error("Existing correction target requires expectedTargetEpoch");
        if (!params.targetWorkId && !params.title) throw new Error("New correction target requires a title");
        return ok(await store.correctMessageAssociation({ ...params, actorId: memberId, requestId: requestId("correct-message", toolCallId, params) }));
      },
    },
    {
      name: "tiangong_read_work", label: "Read one durable Work", description: "Read the current Work projection and bounded timeline.",
      parameters: Type.Object({ workId: ID }, { additionalProperties: false }), executionMode: "sequential",
      async execute(_toolCallId, params) { return ok({ work: await store.getWork(params.workId) }); },
    },
    {
      name: "tiangong_rename_work", label: "Rename Work", description: "Change bounded display metadata only.",
      parameters: Type.Object({ workId: ID, title: Type.String({ minLength: 1, maxLength: 160 }), expectedEpoch: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) { return ok(await store.changeWorkTitle({ ...params, actorId: memberId, requestId: requestId("rename-work", toolCallId, params) })); },
    },
    {
      name: "tiangong_set_work_spec", label: "Form or revise WorkSpec", description: "Publish the Leader's complete current understanding of the Work.",
      parameters: Type.Object({ workId: ID, goal: Type.String({ minLength: 1, maxLength: 4096 }), scope: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 })), constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 })), doneWhen: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 32 }), unresolvedAssumptions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 })), expectedEpoch: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) {
        const work = await store.getWork(params.workId); if (!work) throw new Error("WORK_NOT_FOUND");
        const spec = createWorkSpec({ workId: params.workId, revision: (work.currentWorkSpec?.revision ?? 0) + 1, goal: params.goal, scope: params.scope ?? [], constraints: params.constraints ?? [], doneWhen: params.doneWhen, unresolvedAssumptions: params.unresolvedAssumptions ?? [], createdAt: now() });
        return ok(await store.changeWorkSpec({ workId: params.workId, spec, actorId: memberId, expectedEpoch: params.expectedEpoch, requestId: requestId("set-work-spec", toolCallId, params) }));
      },
    },
    {
      name: "tiangong_publish_plan", label: "Publish current Plan", description: "Set the immutable Markdown ContentRef used as current shared Plan.",
      parameters: Type.Object({ workId: ID, planRef: CONTENT_REF, reason: Type.String({ minLength: 1, maxLength: 2048 }), expectedEpoch: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) { return ok(await store.changeWorkPlan({ ...params, planRef: createContentRef(params.planRef), actorId: memberId, requestId: requestId("publish-plan", toolCallId, params) })); },
    },
    {
      name: "tiangong_create_task", label: "Create Task", description: "Create one immutable TaskSpec for an enabled member. No role, stage, kind, or DAG is encoded.",
      parameters: Type.Object({ workId: ID, taskId: ID, assigneeMemberId: ID, objective: Type.String({ minLength: 1, maxLength: 4096 }), inputs: Type.Optional(Type.Array(CONTENT_REF, { maxItems: 32 })), constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 })), expectedEpoch: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) {
        const task = createTaskSpec({ taskId: params.taskId, workId: params.workId, assigneeMemberId: params.assigneeMemberId, objective: params.objective, inputs: params.inputs ?? [], constraints: params.constraints ?? [], createdAt: now() });
        return ok(await store.createTask({ task, actorId: memberId, expectedEpoch: params.expectedEpoch, requestId: requestId("create-task", toolCallId, params) }));
      },
    },
    {
      name: "tiangong_cancel_task", label: "Cancel Task", description: "Cancel an unreported Task only after runtime cancellation guards pass.",
      parameters: Type.Object({ workId: ID, taskId: ID, reason: Type.String({ minLength: 1, maxLength: 2048 }), expectedEpoch: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) { return ok(await store.cancelTask({ ...params, actorId: memberId, requestId: requestId("cancel-task", toolCallId, params) })); },
    },
    ...["complete", "stop"].map((action) => ({
      name: `tiangong_${action}_work`, label: `${action === "complete" ? "Complete" : "Stop"} Work`, description: `${action === "complete" ? "Semantically complete" : "Stop"} the Work after CloseGuard verifies machine facts.`,
      parameters: Type.Object({ workId: ID, reason: Type.String({ minLength: 1, maxLength: 4096 }), expectedEpoch: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), executionMode: "sequential",
      async execute(toolCallId, params) { return ok(await store.closeWork({ ...params, action, actorId: memberId, requestId: requestId(`${action}-work`, toolCallId, params) })); },
    })),
  ];
}

export function registerLeaderOpenClawTools(api, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!isLeaderEnvironment(env)) return { enabled: false };
  if (typeof api?.registerTool !== "function") throw new Error("OpenClaw registerTool API is unavailable");
  const endpoint = required(env.TIANGONG_COORDINATION_CONTROL_ENDPOINT, "TIANGONG_COORDINATION_CONTROL_ENDPOINT");
  const token = required(env.TIANGONG_COORDINATION_CONTROL_TOKEN, "TIANGONG_COORDINATION_CONTROL_TOKEN");
  const memberId = required(env.TIANGONG_MEMBER_ID ?? env.AGENTTEAMS_WORKER_NAME, "TIANGONG_MEMBER_ID");
  const store = createRemoteCoordinationStore({ endpoint, token, fetchImpl, memberId });
  api.registerTool(() => definitions(store, memberId), { names: [...TOOL_NAMES] });
  return { enabled: true, tools: [...TOOL_NAMES], runtime: "openclaw-built-in" };
}
